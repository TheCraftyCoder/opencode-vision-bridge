# opencode-vision-bridge

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Automatic image and PDF understanding for text-only **OpenCode v2** sessions.

Use a text-only model such as `zai-coding-plan/glm-5.3` as the main session model. When you paste an image or PDF, the plugin sends only that attachment and your question to `zai-coding-plan/glm-5.3-flash`, then gives the resulting description back to the main model as text.

GLM-5.3-Flash is the default. You can override it with any multimodal model already configured in OpenCode or with an OpenAI-compatible endpoint.

## What it does

- Images: the v2 `context` hook checks the active model. Text-only models receive a GLM-5.3-Flash description; models with native image input receive the original image unchanged.
- PDFs: the v2 `prompt` hook intercepts the file before OpenCode's attachment resolver can omit it, asks GLM-5.3-Flash to describe it, removes the binary attachment, and appends the description to the admitted prompt.
- Each bridged attachment is saved under a SHA-256 filename in the project's `.opencode/vision-bridge/attachments/` directory. Local paths are not sent to either model.
- Vision failures are represented by an explicit unavailable-analysis note. The plugin does not invent attachment contents or abort the main text-only request.
- A complementary `read_image` tool lets the model inspect an image already on disk.

## Requirements

- OpenCode 2.0.12 or newer
- Node.js 22.13 or newer
- Access to `zai-coding-plan/glm-5.3-flash`, or another configured multimodal model

The OpenCode API dependencies are pinned together at `2.0.12`.

## Install

```bash
opencode plugin add @the-crafty-coder/opencode-vision-bridge@1.2.0
```

The equivalent Git release is `github:TheCraftyCoder/opencode-vision-bridge#v1.2.0`.

Add the plugin to `opencode.jsonc`. No options are required for the default GLM-5.3-Flash setup:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "zai-coding-plan/glm-5.3",
  "plugins": ["@the-crafty-coder/opencode-vision-bridge@1.2.0"]
}
```

Plugin ID: `moeblack.vision-bridge`.

Restart OpenCode after installing or changing the package:

```bash
opencode service restart
```

## Configuration

Object form is only needed when overriding defaults:

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

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `vision.type` | `"opencode" \| "openai-compatible"` | `"opencode"` | Where the multimodal model comes from. |
| `vision.model` | `string` | `"zai-coding-plan/glm-5.3-flash"` | `provider/model[#variant]` for an OpenCode model; upstream model ID for a custom endpoint. |
| `vision.baseURL` | `string` | none | Base URL for an OpenAI-compatible endpoint. |
| `vision.apiKey` | `string` | none | Bearer key for an OpenAI-compatible endpoint. |
| `saveDir` | `string` | `.opencode/vision-bridge/attachments/` in the session project | Where bridged attachments are saved. Relative paths resolve from the session project. |
| `timeoutMs` | positive integer | `180000` | Timeout for one multimodal generation and the complete rendering of one PDF. |

To reuse another OpenCode model:

```jsonc
{
  "package": "@the-crafty-coder/opencode-vision-bridge@1.2.0",
  "options": {
    "vision": {
      "type": "opencode",
      "model": "provider/vision-model"
    }
  }
}
```

The selected model must accept image input. PDF pages are rendered to PNG before they are sent, so the upstream model does not need native PDF input.

To use a custom OpenAI-compatible endpoint:

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

The custom provider is registered in memory and is not written back to OpenCode configuration.

## How the v2 bridge works

### Pasted images

OpenCode v2 normalizes supported images into model-context media parts:

```ts
{
  type: "media",
  mediaType: "image/png",
  data: "data:image/png;base64,..."
}
```

Immediately before a model call, the plugin reads the active model's current catalog capabilities. If it includes `image`, the media part is left unchanged. Otherwise the plugin replaces it in place with a text block containing the GLM-5.3-Flash description.

### Pasted PDFs

PDFs need an earlier path because current OpenCode v2 attachment resolution does not reliably place PDF prompt attachments into model context. The plugin handles them in `ctx.session.hook("prompt")`:

1. Read a pasted `data:` URL or attached local `file:` URL.
2. Validate the file size, save the PDF using its SHA-256 digest, and render at most 32 pages to bounded PNG batches of eight.
3. Ask GLM-5.3-Flash to inspect the page images using the surrounding user text as the question.
4. Remove the original binary PDF attachment while preserving existing prompt text and mention offsets.
5. Append a bounded `[Attached PDF] ... [/Attached PDF]` text description to the same user prompt.

Other prompt files, including text files and pasted images, remain on OpenCode's normal resolution path.

### Internal generation

The bridge registers a hidden, one-step internal agent with all tools denied. One reusable internal session per project handles serialized `session.generate` calls. An idempotent in-memory request registry supplies the attachment without admitting user or assistant messages. This prevents tool execution, duplicate media injection, unbounded session creation, and automatic title generation during visual analysis.

## Explicit `read_image` tool

`read_image` handles PNG, JPEG, GIF, WebP, BMP, and AVIF files already inside the current project. It rejects unknown extensions, oversized files, traversal, home-relative paths, and symlinks that escape the project. It accepts:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | `string` | yes | Path relative to the project, or an absolute path that remains inside it. |
| `question` | `string` | no | A focused visual question. Omit it for a general description. |

Example input:

```json
{
  "filePath": "artifacts/ui-error.png",
  "question": "What error is shown, and which source line caused it?"
}
```

## Verify

Run the static checks and unit tests:

```bash
npm install
npm run check
```

Then verify in OpenCode:

1. Select a text-only main model, such as `zai-coding-plan/glm-5.3`.
2. Paste an image and ask about it. Confirm the answer uses visible details and a digest-named image appears in `saveDir`.
3. Paste a PDF and ask for a summary. Confirm the answer uses document details and a digest-named `.pdf` appears in `saveDir`.
4. Select a native image model, paste an image, and confirm the plugin does not create a new saved image.

## Constraints

- The default `zai-coding-plan/glm-5.3-flash` model must be available and authenticated in the OpenCode catalog. Override `vision.model` if you use a different provider.
- Provider and model size/count limits still apply. The bridge additionally caps attachments at 25 MiB, PDFs at 32 rendered pages, rendered page images at 4 MiB, and PDFs at four per prompt.
- Successful descriptions are cached in memory for 15 minutes with a 128-entry limit. Failures and partial PDF descriptions are never cached.
- One empty hidden internal session may remain visible per project because the OpenCode Promise plugin surface does not expose safe session removal from inside a hook.
- Saved digest files are not deleted automatically.
- OpenCode plugin APIs can change between releases. Keep the three `@opencode/*` package versions aligned and rerun `npm run check` after upgrading.
