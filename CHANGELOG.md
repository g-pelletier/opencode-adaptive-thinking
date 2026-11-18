# Changelog

## 1.1.0

- Reload and restart safe: temporary changes are recorded in plugin storage (`pending/<sessionID>`) before the switch and reverted from storage at turn end.
- Startup scan reconciles records left by an earlier process: idle sessions are reverted, busy or unknown sessions are left, missing sessions and records older than 7 days are dropped.
- Manual changes are respected: a switch-back is skipped and its record dropped when the session's model or level no longer matches what the plugin set.
- `session.execution.interrupted` with `reason: "shutdown"` no longer reverts; the server resumes the turn after restart.
- A failed switch reports failure and does not leave a pending record behind.
- A switch to the model default (no variant) is recorded and reverted correctly.
- Per-session serialization of tool calls and reverts; end events are handled without blocking the subscription.
- Event subscription resubscribes with backoff when it ends or errors.
- Internal split: `src/pending.js` holds storage, reconciliation, and the startup scan.
- Tests (`npm test`, `node:test`, no dependencies) and a CI workflow on Node 22.
- Requires Node 20+ for tests (`engines`).

## 1.0.0

- Initial native OpenCode v2 release.
- `set_reasoning_effort` tool (`level`, `persist`) with per-model level checks against the live catalog.
- Guidance injected into each session's system prompt with the current level and valid levels.
- Temporary changes revert at the end of the turn; `persist: true` keeps the level.
- Options: `enabled`, `rootSessionsOnly`, `toolName`, `toolDescription`, `systemPrompt`, `debug`.
