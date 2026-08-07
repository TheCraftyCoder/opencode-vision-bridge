# opencode-vision-bridge

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

面向 **OpenCode 2.0 beta** 的自动看图插件。当前会话模型不支持图片输入时，插件会在 provider 请求发出前自动完成以下处理：

1. 从 `ctx.session.hook("context")` 的消息中提取图片；
2. 将图片按 SHA-256 文件名保存到本地；
3. 通过 OpenCode agent 路径让配置的 vision 模型生成文字描述；
4. 用包含本地 `file:` URL 的描述文字替换原图片 part；
5. 让原本不支持 vision 的主模型继续正常处理请求。

自动附件路径不需要额外 system prompt、工具调用或调用约定。当前模型原生支持 `image` 输入时，插件不改动消息，图片直接交给该模型。

## 特性

- **零侵入自动路径**：附件拦截不依赖主模型发起工具调用。
- **无副作用**：vision 请求通过隐藏内部 agent 在临时 session 上执行；不创建持久 session、不写入 user/assistant 消息、不触发会话自动重命名。
- **图片落盘**：被桥接的图片（包括剪切板粘贴的）按 SHA-256 文件名保存，并在注入的描述中以 `file:///...` URL 引用。
- **vision 来源可配置**：使用 OpenCode catalog 中已有的 provider 模型，或任意自定义 OpenAI 兼容端点（baseURL + apiKey）。
- **vision 感知**：原生支持图片的模型不会被拦截。
- **显式读取磁盘图片**：模型可通过 `read_image` 工具检查已经存在于磁盘上的图片。

## 环境

- OpenCode 2.0 beta：`@opencode-ai/cli@0.0.0-next-16977`
- Node.js 22 或更新版本
- 插件依赖与目标 OpenCode beta 版本保持一致，均固定为 `0.0.0-next-16977`

安装依赖：

```bash
cd opencode-vision-bridge
npm install
```

## 接入 OpenCode

在 V2 配置字段 `plugins` 中加入本地入口。绝对路径受 V2 原生插件加载器支持：

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-vision-bridge/src/index.ts",
      "options": {
        "vision": {
          "type": "opencode",
          "model": "opencode/mimo-v2.5-free"
        }
      }
    }
  ]
}
```

插件 ID 为：

```text
moeblack.vision-bridge
```

如果同一配置还供 OpenCode V1 使用，可以保留原有 `plugin` 字段，并另加 V2 的 `plugins` 字段。V1 插件实现不能直接在 V2 运行。

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `vision.type` | `"opencode" \| "openai-compatible"` | `"opencode"` | vision 模型来源。 |
| `vision.model` | `string` | `opencode/mimo-v2.5-free` | 内置来源使用 `provider/model[#variant]`；自定义来源填写上游模型 ID。 |
| `vision.baseURL` | `string` | 无 | 自定义 OpenAI 兼容端点的 base URL。 |
| `vision.apiKey` | `string` | 无 | 自定义 OpenAI 兼容端点的 bearer key。 |
| `saveDir` | `string` | 项目内 `images/` | 图片保存目录。相对路径按插件项目根目录解析。 |
| `timeoutMs` | 正整数 | `180000` | 一次 vision 生成的超时时间，单位为毫秒。 |

### 使用 OpenCode 已有 provider

`vision.model` 必须是当前 OpenCode catalog 中存在且 `capabilities.input` 包含 `image` 的模型：

```jsonc
{
  "package": "/path/to/opencode-vision-bridge/src/index.ts",
  "options": {
    "vision": {
      "type": "opencode",
      "model": "opencode/mimo-v2.5-free"
    },
    "saveDir": "/path/to/opencode-vision-bridge/images",
    "timeoutMs": 180000
  }
}
```

该模式复用 OpenCode 已加载的 provider、凭据、模型设置和 variant。

### 使用自定义 OpenAI 兼容端点

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

插件会在内存 catalog 中注册 provider `moeblack-vision-bridge-custom`，使用 OpenCode V2 原生的 `@opencode-ai/ai/providers/openai-compatible` provider package，再通过同一套内部 agent 流程调用它。该 provider 不写回 OpenCode 配置文件。

## 显式 `read_image` 工具

消息附件仍默认走自动拦截流程，主模型不需要调用任何工具。`read_image` 是一条补充的显式路径，适合检查已经存在于磁盘上的图片，例如模型稍后需要查看的生成截图、图表或 UI 产物。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `filePath` | `string` | 是 | 绝对路径、以 `~/` 开头的路径，或相对于当前项目目录的路径。 |
| `question` | `string` | 否 | 交给 vision 模型的聚焦问题。省略时，插件会要求通用的详细描述，并保留可见文字与布局信息。 |

例如，可以要求模型使用以下参数调用 `read_image`：

```json
{
  "filePath": "artifacts/ui-error.png",
  "question": "终端中显示了什么错误，是哪一行源码引起的？"
}
```

工具会读取该文件，将相同字节按 SHA-256 文件名保存到 `saveDir`，再交给配置的 vision 模型，并同时返回保存后的 `file:///...` URL 与文字描述。工具按扩展名识别 PNG、JPEG（`.jpg` 与 `.jpeg`）、GIF、WebP、BMP 和 AVIF，扩展名不区分大小写；未知扩展名按 `image/png` 发送。

## 工作方式

### 主请求拦截

V2 的模型上下文把图片规范化为：

```ts
{
  type: "media",
  mediaType: "image/png",
  data: "data:image/png;base64,..."
}
```

插件同时识别 V1 风格的 data-URL `file` part，以便适应 beta 期间的消息形状变化。当前模型的能力来自 V2 model catalog；`capabilities.input` 包含 `image` 时直接返回，不做落盘或描述。

### 无持久消息的 vision 生成

OpenCode V2 的全局 `/api/generate` 端点不接受附件，而 session agent loop 可能执行工具。插件因此使用以下流程：

1. 创建带固定非默认标题的空临时 session，指定隐藏的内部 agent 与 vision 模型；
2. 将图片仅保存在插件内存的请求表中；
3. 调用 `session.generate` 做一次性生成；
4. 在该生成请求的 `context` hook 中注入图片，并清空 tools；
5. 读取 `session.generate` 直接返回的文字；
6. 在 `finally` 中删除临时 session。

该流程不会向临时 session admit prompt，不写入 user/assistant message，也不会满足自动标题生成条件。内部 agent 不进入多步 agent loop，不会执行文件、shell 或网络工具。

## 验证

### 1. 静态检查与测试

```bash
cd opencode-vision-bridge
npm run check
```

### 2. 确认插件已加载

修改配置后重启后台服务：

```bash
opencode2 service restart
opencode2 api get /api/plugin
```

返回的 `data` 中应包含：

```json
{"id":"moeblack.vision-bridge"}
```

### 3. 功能验证

1. 选择仅支持 `text` 输入的模型；
2. 粘贴 PNG、JPEG、GIF 或 WebP 图片；
3. 直接询问图片内容；
4. 确认回答使用了图片信息；
5. 确认 `saveDir` 中新增一个 `<sha256>.<ext>` 文件；
6. 再选择原生 vision 模型粘贴图片，确认请求仍能正常完成且 bridge 不新增图片文件。

## 开发命令

```bash
npm test
npm run typecheck
npm run check
```

## Beta 限制

- 插件 API 尚处于 beta。升级 `opencode2` 后，应把三个 `@opencode-ai/*` 依赖同步到相同 build，并重新执行加载验证。
- 同一配置为 V1 保留旧 `plugin: ["opencode-see-image"]` 时，`next-16977` 仍会尝试按 V2 API 解析该 V1 包，并在 server log 中记录 `Expected object` 兼容性警告；这不影响 `moeblack.vision-bridge` 加载。只有移除旧字段才能消除该警告，但会失去原配置的 V1 插件接入。
- 当前 `@opencode-ai/plugin` 的 Promise `SessionDomain` 未暴露删除 session 所需的 `remove` 方法。插件使用同版本 `@opencode-ai/client` 发现并连接当前 managed background service，因此 `opencode2 --standalone` 暂不受支持。
- V2 没有可直接携带图片且完全无 session 的 one-shot generate API。临时 session 不保留消息并会在调用结束时删除；实时订阅原始 server event stream 的调试客户端仍可能观察到对应的 create/delete 事件。
- `context` runtime hook 当前没有进度 metadata 或 TUI heartbeat 通道。为避免创建可见消息，vision 等待期间不显示 V1 工具插件式的进度条。
- OpenCode V2 当前只把 PNG、JPEG、GIF 和 WebP prompt attachment 放入模型上下文，因此自动拦截受此限制；`read_image` 还可以直接从磁盘读取 BMP 和 AVIF 文件。
- 自动 bridge 的描述缓存位于插件进程内存中，插件重载或后台服务重启后会重新调用 vision 模型。已经落盘的图片不会自动删除。
