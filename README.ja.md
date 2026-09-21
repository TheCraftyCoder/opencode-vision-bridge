# opencode-vision-bridge

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

テキスト専用の **OpenCode v2** セッションで、画像と PDF を自動的に理解できるようにするプラグインです。

メインセッションでは `zai-coding-plan/glm-5.3` などのテキスト専用モデルを使用できます。画像または PDF を貼り付けると、プラグインが添付ファイルと質問を `zai-coding-plan/glm-5.3-flash` に送り、その説明文をメインモデルへ返します。

## 機能

- 画像: v2 の `context` hook で現在のモデル能力を確認します。テキスト専用モデルには GLM-5.3-Flash の説明を渡し、画像入力対応モデルには元の画像をそのまま渡します。
- PDF: OpenCode の添付処理で省略される前に v2 の `prompt` hook で処理し、バイナリ添付を説明文に置き換えます。
- ブリッジした添付は SHA-256 名で `images/` に保存され、注入されるテキストにはローカル `file:` URL が含まれます。
- vision 呼び出しが失敗した場合は、解析できなかったことを明示します。内容を推測せず、メインモデルのリクエストも中断しません。
- `read_image` ツールでディスク上の既存画像を確認できます。

## 必要環境

- OpenCode 2.0.12 以降
- Node.js 22.13 以降
- `zai-coding-plan/glm-5.3-flash`、または設定済みの別のマルチモーダルモデルへのアクセス

## インストール

```bash
opencode plugin add @the-crafty-coder/opencode-vision-bridge@1.2.0
```

既定では GLM-5.3-Flash を使うため、追加オプションは不要です。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "zai-coding-plan/glm-5.3",
  "plugins": ["@the-crafty-coder/opencode-vision-bridge@1.2.0"]
}
```

変更後に `opencode service restart` を実行してください。プラグイン ID は `moeblack.vision-bridge` です。

## 設定

既定値を変更する場合のみオブジェクト形式を使います。

```jsonc
{
  "plugins": [
    {
      "package": "@the-crafty-coder/opencode-vision-bridge@1.2.0",
      "options": {
        "vision": {
          "type": "opencode",
          "model": "zai-coding-plan/glm-5.3-flash"
        },
        "saveDir": "./images",
        "timeoutMs": 180000
      }
    }
  ]
}
```

| 設定 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `vision.type` | `"opencode" \| "openai-compatible"` | `"opencode"` | マルチモーダルモデルの供給元。 |
| `vision.model` | `string` | `"zai-coding-plan/glm-5.3-flash"` | OpenCode では `provider/model[#variant]`、カスタムでは上流モデル ID。 |
| `vision.baseURL` | `string` | なし | OpenAI 互換エンドポイントの URL。 |
| `vision.apiKey` | `string` | なし | OpenAI 互換エンドポイントの bearer key。 |
| `saveDir` | `string` | プラグイン内の `images/` | 添付ファイルの保存先。 |
| `timeoutMs` | 正の整数 | `180000` | 1 回の生成タイムアウト（ミリ秒）。 |

カスタム OpenAI 互換エンドポイント:

```jsonc
{
  "package": "@the-crafty-coder/opencode-vision-bridge@1.2.0",
  "options": {
    "vision": {
      "type": "openai-compatible",
      "model": "glm-5.3-flash",
      "baseURL": "https://vision.example.com/v1",
      "apiKey": "replace-with-key"
    }
  }
}
```

## 検証

```bash
npm install
npm run check
```

OpenCode でテキスト専用のメインモデルを選び、画像と PDF をそれぞれ貼り付けて質問します。回答が添付内容を使っており、`saveDir` にダイジェスト名の画像と `.pdf` が作成されることを確認してください。次に画像対応モデルへ切り替え、画像貼り付け時に新しい保存画像が作られないことを確認します。

## 制約

- 既定モデルが OpenCode catalog で利用可能かつ認証済みである必要があります。別のモデルは `vision.model` で指定できます。
- 上流モデルのファイルサイズ、個数、形式制限は引き続き適用されます。
- 説明キャッシュはプロセス内のみです。再読み込みや再起動後は再解析され、保存済みファイルは自動削除されません。
- OpenCode Promise プラグイン API は現在 session 削除を公開していません。内部生成はメッセージを書き込みませんが、OpenCode が整理するまで空の内部 session が見える場合があります。

実装詳細と `read_image` の引数は [English README](README.md) を参照してください。
