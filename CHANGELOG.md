# Changelog

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
