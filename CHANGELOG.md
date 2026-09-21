# Changelog

## 1.2.0 - 2026-09-21

- Defaulted the bridge model to `zai-coding-plan/glm-5.3-flash`, matching the GLM Coding Plan catalog in OpenCode v2.
- Added pasted-PDF interception in the v2 `prompt` hook, rendering pages to PNG batches before OpenCode omits unsupported binary attachments from model context.
- Generalized attachment decoding, SHA-256 storage, caching, request injection, prompts, and output labels for both images and PDFs.
- Made context bridging capability-specific so a model can receive images natively while unsupported PDFs are still described as text.
- Added coverage for PDF data URLs, prompt mutation, mixed model capabilities, and non-media prompt attachments.

## 1.1.0 - 2026-09-21

- Prevented failed automatic vision requests from aborting the parent OpenCode session. The bridge now preserves the attachment reference and reports that visual analysis was unavailable.
- Removed the broken free-model default. A vision provider is now an explicit, authenticated configuration requirement.

## 1.0.4 - 2026-09-21

- Added npm repository metadata, issue tracker, homepage, discovery keywords, and upstream-fork attribution.

## 1.0.3 - 2026-09-21

- Published the stable V2 plugin under the public `@the-crafty-coder/opencode-vision-bridge` npm scope.

## 1.0.1 - 2026-09-21

- Inject transient vision media through both stable V2 `context` and `generate` hooks.
- Create transient vision sessions in the originating session's project location so provider configuration is retained.

## 1.0.0 - 2026-09-21

- Ported the vision bridge from the OpenCode V2 beta API to stable OpenCode 2.0.12.
- Updated plugin, client, and AI dependencies from `@opencode-ai/*` beta packages to stable `@opencode/*` packages.
- Migrated custom-provider registration to the stable provider transform API.
- Made configuration tests cross-platform.
