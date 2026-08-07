# opencode-vision-bridge

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

An automatic image-viewing plugin for **OpenCode 2.0 beta**. When the current session model does not support image input, the plugin automatically:

1. Extracts images from the messages in `ctx.session.hook("context")` before the provider request is sent;
2. Saves each image to disk under its SHA-256 filename;
3. Sends the image to a configured vision-capable model through the OpenCode agent path to generate a text description;
4. Replaces the original image part with the description text, including a local `file:` URL;
5. Lets the non-vision main model continue processing the request normally.

The main model needs no extra system prompt, no tools, and no calling convention. When the current model natively supports `image` input, the plugin leaves the messages untouched and the image goes straight to that model.

## Features

- **Zero-intrusion**: automatic interception — the main model never learns to call a tool.
- **No side effects**: the vision request runs through a hidden internal agent on a temporary session; no persistent session is created, no user/assistant message is admitted, no automatic session rename is triggered.
- **Image saved to disk**: every bridged image (including clipboard pastes) is stored under its SHA-256 name and referenced by a `file:///...` URL in the injected description.
- **Configurable vision source**: use an OpenCode provider model already in your catalog, or any custom OpenAI-compatible endpoint (baseURL + apiKey).
- **Vision-aware**: models that natively accept images are never intercepted.

## Requirements

- OpenCode 2.0 beta: `@opencode-ai/cli@0.0.0-next-16977`
- Node.js 22 or newer
- Plugin dependencies are pinned to the same build as the target OpenCode beta (`0.0.0-next-16977`)

Install dependencies:

```bash
cd opencode-vision-bridge
npm install
```

## Install into OpenCode

Add a local entry to the V2 `plugins` config field. Absolute paths are supported by the V2 native plugin loader:

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

Plugin ID:

```text
moeblack.vision-bridge
```

If the same config file is also used by OpenCode V1, keep the V1 `plugin` field and add the V2 `plugins` field alongside it. V1 plugin implementations do not run in V2.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `vision.type` | `"opencode" \| "openai-compatible"` | `"opencode"` | Vision model source. |
| `vision.model` | `string` | `zoaholic/gpt-5.6-luna-codex-20x` | `provider/model[#variant]` for built-in sources; upstream model ID for custom sources. |
| `vision.baseURL` | `string` | none | Base URL of a custom OpenAI-compatible endpoint. |
| `vision.apiKey` | `string` | none | Bearer key for the custom OpenAI-compatible endpoint. |
| `saveDir` | `string` | `images/` in the project | Directory where images are saved. Relative paths resolve against the plugin project root. |
| `timeoutMs` | positive integer | `180000` | Timeout for one vision generation, in milliseconds. |

### Using an existing OpenCode provider

`vision.model` must be a model present in the current OpenCode catalog whose `capabilities.input` includes `image`:

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

This mode reuses the provider, credentials, model settings and variant already loaded by OpenCode.

### Using a custom OpenAI-compatible endpoint

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

The plugin registers an in-memory provider `moeblack-vision-bridge-custom` using the native `@opencode-ai/ai/providers/openai-compatible` package, then calls it through the same internal agent flow. This provider is never written back to the OpenCode config file.

## How it works

### Main-request interception

The V2 model context normalizes images as:

```ts
{
  type: "media",
  mediaType: "image/png",
  data: "data:image/png;base64,..."
}
```

The plugin also recognizes V1-style data-URL `file` parts to stay resilient while the beta message shape changes. Model capability is read from the V2 model catalog; when `capabilities.input` includes `image`, the plugin returns immediately without saving or describing anything.

### Side-effect-free vision generation

The V2 global `/api/generate` endpoint does not accept attachments, and a session agent loop may execute tools. The plugin therefore:

1. Creates an empty temporary session with a fixed non-default title, targeting a hidden internal agent with the vision model;
2. Keeps the image only in an in-memory request table;
3. Calls `session.generate` for a one-shot generation;
4. Injects the image inside that generation's `context` hook and clears the tools;
5. Reads the text returned directly by `session.generate`;
6. Deletes the temporary session in a `finally` block.

No prompt is admitted to the temporary session, no user/assistant message is written, and automatic title-generation conditions are never met. The internal agent does not enter a multi-step agent loop and cannot execute file, shell or network tools.

## Verification

### 1. Static checks and tests

```bash
cd opencode-vision-bridge
npm run check
```

### 2. Confirm the plugin is loaded

After changing the config, restart the background service:

```bash
opencode2 service restart
opencode2 api get /api/plugin
```

The returned `data` should contain:

```json
{"id":"moeblack.vision-bridge"}
```

### 3. Functional check

1. Pick a model that only supports `text` input;
2. Paste a PNG, JPEG, GIF or WebP image;
3. Ask directly about the image content;
4. Confirm the answer uses the image information;
5. Confirm a new `<sha256>.<ext>` file appears in `saveDir`;
6. Then pick a native vision model, paste an image, and confirm the request still completes and the bridge adds no new image file.

## Development commands

```bash
npm test
npm run typecheck
npm run check
```

## Beta limitations

- The plugin API is still beta. After upgrading `opencode2`, sync the three `@opencode-ai/*` dependencies to the same build and re-run the load verification.
- If the same config keeps the legacy `plugin: ["opencode-see-image"]` entry for V1, `next-16977` still tries to parse that V1 package with the V2 API and logs an `Expected object` compatibility warning; this does not affect `moeblack.vision-bridge` loading. Only removing the legacy field silences the warning, at the cost of losing the V1 plugin wiring.
- The Promise `SessionDomain` of `@opencode-ai/plugin` does not expose the `remove` method needed to delete a session. The plugin uses the same-version `@opencode-ai/client` to discover and connect to the managed background service, so `opencode2 --standalone` is not supported yet.
- V2 has no one-shot generate API that carries images without any session. The temporary session keeps no messages and is deleted when the call finishes; debugging clients that subscribe to the raw server event stream may still observe the corresponding create/delete events.
- The `context` runtime hook currently has no progress metadata or TUI heartbeat channel. To avoid creating visible messages, no V1-style progress bar is shown while waiting for the vision call.
- OpenCode V2 currently places only PNG, JPEG, GIF and WebP prompt attachments into the model context. Other binary formats never reach the plugin.
- The description cache lives in plugin process memory; after a plugin reload or background-service restart the vision model is called again. Images already saved to disk are never deleted automatically.
