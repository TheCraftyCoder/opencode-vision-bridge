# opencode-vision-bridge

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

为仅支持文本的 **OpenCode v2** 会话自动理解图片和 PDF。

主会话可以使用 `zai-coding-plan/glm-5.3` 等纯文本模型。粘贴图片或 PDF 后，插件会把附件和用户问题交给 `zai-coding-plan/glm-5.3-flash`，再将生成的文字描述返回给主模型。

## 功能

- 图片：在 v2 `context` hook 中读取当前模型能力。纯文本模型收到 GLM-5.3-Flash 的描述；原生支持图片的模型仍收到原图。
- PDF：在 v2 `prompt` hook 中提前拦截，以免 PDF 被 OpenCode 的附件解析流程省略；分析后移除二进制附件并把描述加入同一条用户消息。
- 每个被桥接的附件按 SHA-256 文件名保存到 `images/`，注入文字中包含本地 `file:` URL。
- vision 调用失败时会明确写明分析不可用，不会猜测附件内容，也不会中断主模型请求。
- `read_image` 工具可读取磁盘上已有的图片。

## 环境

- OpenCode 2.0.12 或更新版本
- Node.js 22.13 或更新版本
- 可访问 `zai-coding-plan/glm-5.3-flash`，或其他已配置的多模态模型

## 安装

```bash
opencode plugin add @the-crafty-coder/opencode-vision-bridge@1.2.0
```

默认使用 GLM-5.3-Flash，无需额外 options：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "zai-coding-plan/glm-5.3",
  "plugins": ["@the-crafty-coder/opencode-vision-bridge@1.2.0"]
}
```

修改后执行 `opencode service restart`。插件 ID 为 `moeblack.vision-bridge`。

## 配置

只有覆盖默认值时才需要对象形式：

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

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `vision.type` | `"opencode" \| "openai-compatible"` | `"opencode"` | 多模态模型来源。 |
| `vision.model` | `string` | `"zai-coding-plan/glm-5.3-flash"` | OpenCode 使用 `provider/model[#variant]`；自定义端点使用上游模型 ID。 |
| `vision.baseURL` | `string` | 无 | OpenAI 兼容端点 URL。 |
| `vision.apiKey` | `string` | 无 | OpenAI 兼容端点 bearer key。 |
| `saveDir` | `string` | 插件目录下的 `images/` | 附件保存目录。 |
| `timeoutMs` | 正整数 | `180000` | 单次多模态生成超时（毫秒）。 |

自定义 OpenAI 兼容端点示例：

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

## 验证

```bash
npm install
npm run check
```

然后在 OpenCode 中选择纯文本主模型，分别粘贴图片和 PDF 并提问。确认回答引用了附件内容，且 `saveDir` 中出现摘要命名的图片和 `.pdf` 文件。再切换到原生图片模型，确认粘贴图片时插件不会保存新的图片。

## 限制

- 默认模型必须已在 OpenCode catalog 中可用并完成认证；也可通过 `vision.model` 覆盖。
- 上游模型的文件大小、数量和格式限制仍然适用。
- 描述缓存仅存在于插件进程内；重载或重启后会重新分析，已保存文件不会自动删除。
- OpenCode Promise 插件接口目前不提供 session 删除；内部生成不会写入消息，但 OpenCode 清理前可能看到一个空的内部 session。

完整的实现细节和 `read_image` 参数请参阅 [English README](README.md)。
