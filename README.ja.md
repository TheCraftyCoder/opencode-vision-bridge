# opencode-vision-bridge

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**OpenCode 2.0 beta** 向けの自動画像閲覧プラグイン。現在のセッションモデルが画像入力に対応していない場合、プロバイダーへのリクエスト送信前にプラグインが自動的に以下を行います。

1. `ctx.session.hook("context")` のメッセージから画像を抽出する；
2. 画像を SHA-256 ファイル名でローカルに保存する；
3. OpenCode の agent 経路を通して、設定済みの vision 対応モデルに文字による説明を生成させる；
4. 元の画像パートを、ローカル `file:` URL を含む説明文に置き換える；
5. vision 非対応のメインモデルがそのままリクエスト処理を続行できるようにする。

メインモデルに追加の system prompt やツール、呼び出し規約は不要です。現在のモデルが `image` 入力をネイティブにサポートしている場合はメッセージを変更せず、画像はそのモデルに直接渡されます。

## 特徴

- **ゼロ侵入**: 自動インターセプト方式。メインモデルがツールの呼び出しを学ぶ必要はありません。
- **副作用なし**: vision リクエストは非表示の内部エージェントが一時セッション上で実行します。永続セッションを作らず、user/assistant メッセージも書き込まず、セッションの自動リネームも発生しません。
- **画像を保存**: ブリッジされた画像（クリップボードからの貼り付けを含む）は SHA-256 ファイル名で保存され、注入された説明文内の `file:///...` URL から参照できます。
- **vision ソースを設定可能**: OpenCode カタログ内の既存プロバイダーモデル、または任意のカスタム OpenAI 互換エンドポイント（baseURL + apiKey）を使用できます。
- **vision 認識**: 画像をネイティブに受け入れられるモデルはインターセプトされません。

## 必要環境

- OpenCode 2.0 beta: `@opencode-ai/cli@0.0.0-next-16977`
- Node.js 22 以降
- プラグインの依存関係は対象の OpenCode beta と同じビルドに固定（`0.0.0-next-16977`）

依存関係のインストール:

```bash
cd opencode-vision-bridge
npm install
```

## OpenCode への組み込み

V2 の `plugins` 設定フィールドにローカルエントリを追加します。絶対パスは V2 ネイティブのプラグインローダーでサポートされています:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-vision-bridge/src/index.ts",
      "options": {
        "vision": {
          "type": "opencode",
          "model": "zoaholic/gpt-5.6-luna-codex-20x"
        }
      }
    }
  ]
}
```

プラグイン ID:

```text
moeblack.vision-bridge
```

同じ設定ファイルを OpenCode V1 でも使う場合は、V1 の `plugin` フィールドを残しつつ V2 の `plugins` フィールドを追加してください。V1 プラグインの実装は V2 では動作しません。

## 設定項目

| 設定 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `vision.type` | `"opencode" \| "openai-compatible"` | `"opencode"` | vision モデルのソース。 |
| `vision.model` | `string` | `zoaholic/gpt-5.6-luna-codex-20x` | 内蔵ソースでは `provider/model[#variant]`、カスタムソースでは上流モデル ID。 |
| `vision.baseURL` | `string` | なし | カスタム OpenAI 互換エンドポイントの base URL。 |
| `vision.apiKey` | `string` | なし | カスタム OpenAI 互換エンドポイントの bearer key。 |
| `saveDir` | `string` | プロジェクト内の `images/` | 画像の保存ディレクトリ。相対パスはプラグインプロジェクトルート基準で解決されます。 |
| `timeoutMs` | 正の整数 | `180000` | vision 生成 1 回あたりのタイムアウト（ミリ秒）。 |

### 既存の OpenCode プロバイダーを使用する場合

`vision.model` は、現在の OpenCode カタログに存在し `capabilities.input` に `image` を含むモデルである必要があります:

```jsonc
{
  "package": "/path/to/opencode-vision-bridge/src/index.ts",
  "options": {
    "vision": {
      "type": "opencode",
      "model": "zoaholic/gpt-5.6-luna-codex-20x"
    },
    "saveDir": "/path/to/opencode-vision-bridge/images",
    "timeoutMs": 180000
  }
}
```

このモードでは、OpenCode がすでに読み込んでいるプロバイダー・資格情報・モデル設定・バリアントを再利用します。

### カスタム OpenAI 互換エンドポイントを使用する場合

```jsonc
{
  "package": "/path/to/opencode-vision-bridge/src/index.ts",
  "options": {
    "vision": {
      "type": "openai-compatible",
      "model": "my-vision-model",
      "baseURL": "https://vision.example.com/v1",
      "apiKey": "replace-with-key"
    }
  }
}
```

プラグインはネイティブの `@opencode-ai/ai/providers/openai-compatible` パッケージを使ってメモリ内プロバイダー `moeblack-vision-bridge-custom` を登録し、同じ内部 agent フローで呼び出します。このプロバイダーは OpenCode の設定ファイルに書き戻されません。

## 動作の仕組み

### メインリクエストのインターセプト

V2 のモデルコンテキストでは画像が次のように正規化されます:

```ts
{
  type: "media",
  mediaType: "image/png",
  data: "data:image/png;base64,..."
}
```

プラグインは beta 期間中のメッセージ形状の変化に備えて、V1 形式の data-URL `file` パートも認識します。モデルの能力は V2 モデルカタログから取得し、`capabilities.input` に `image` が含まれる場合は保存も説明もせずに即座に戻ります。

### 副作用なしの vision 生成

V2 のグローバル `/api/generate` エンドポイントは添付ファイルを受け付けず、セッションの agent loop はツールを実行し得ます。そのためプラグインは次の手順を使います:

1. 固定の非デフォルトタイトルを持つ空の一時セッションを作成し、非表示の内部エージェントと vision モデルを指定する；
2. 画像をプラグインのインメモリリクエストテーブルにのみ保持する；
3. `session.generate` でワンショット生成を呼び出す；
4. その生成リクエストの `context` hook 内で画像を注入し、tools を空にする；
5. `session.generate` が直接返すテキストを読み取る；
6. `finally` で一時セッションを削除する。

このフローは一時セッションにプロンプトを admit せず、user/assistant メッセージも書き込まず、自動タイトル生成の条件も満たしません。内部エージェントはマルチステップの agent loop に入らず、ファイル・シェル・ネットワークツールを実行できません。

## 検証

### 1. 静的チェックとテスト

```bash
cd opencode-vision-bridge
npm run check
```

### 2. プラグインが読み込まれたことを確認

設定変更後、バックグラウンドサービスを再起動:

```bash
opencode2 service restart
opencode2 api get /api/plugin
```

返ってくる `data` に以下が含まれるはずです:

```json
{"id":"moeblack.vision-bridge"}
```

### 3. 機能確認

1. `text` 入力のみサポートするモデルを選択する；
2. PNG・JPEG・GIF・WebP の画像を貼り付ける；
3. 画像の内容を直接質問する；
4. 回答が画像の情報を使っていることを確認する；
5. `saveDir` に新しい `<sha256>.<ext>` ファイルが増えることを確認する；
6. 次にネイティブ vision モデルを選んで画像を貼り付け、リクエストが正常に完了し bridge が画像ファイルを追加しないことを確認する。

## 開発コマンド

```bash
npm test
npm run typecheck
npm run check
```

## Beta の制限

- プラグイン API はまだ beta です。`opencode2` をアップグレードしたら、3 つの `@opencode-ai/*` 依存を同じビルドに揃え、読み込み検証をやり直してください。
- 同じ設定に V1 用の旧 `plugin: ["opencode-see-image"]` を残している場合、`next-16977` はその V1 パッケージを V2 API で解析しようとし、サーバーログに `Expected object` の互換性警告を記録します。`moeblack.vision-bridge` の読み込みには影響しません。警告を消すには旧フィールドを削除するしかありませんが、V1 プラグインの接続は失われます。
- 現在の `@opencode-ai/plugin` の Promise `SessionDomain` は、セッション削除に必要な `remove` メソッドを公開していません。プラグインは同バージョンの `@opencode-ai/client` を使って managed background service を発見・接続するため、`opencode2 --standalone` はまだサポートされていません。
- V2 には、セッションなしで画像を運べる one-shot generate API がありません。一時セッションはメッセージを保持せず、呼び出し終了時に削除されます。生のサーバーイベントストリームを購読するデバッグクライアントは、対応する create/delete イベントを観察する可能性があります。
- `context` runtime hook には現在、進行状況のメタデータや TUI のハートビートチャネルがありません。可視メッセージを作らないため、vision 呼び出しの待機中に V1 ツールプラグイン風のプログレスバーは表示されません。
- OpenCode V2 は現在、PNG・JPEG・GIF・WebP のプロンプト添付のみをモデルコンテキストに入れます。他のバイナリ形式はプラグインに到達しません。
- 説明キャッシュはプラグインプロセスのメモリ内にあります。プラグインのリロードやバックグラウンドサービスの再起動後は vision モデルが再度呼び出されます。保存済みの画像が自動削除されることはありません。
