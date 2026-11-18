# Changelog

## 1.2.1 - 2026-11-18

### Changed

- Minimum Node.js version is now 22 (`engines`).

## 1.2.0

- Level limits: `allowedLevels`, `maxLevel`, and per-agent `agents` overrides (`allowedLevels`, `maxLevel`, `enabled: false`). Guidance and the tool both use the effective list; a blocked level is reported as blocked by configuration.
- Revert targets are never blocked by level limits or the switch limit.
- `maxSwitchesPerTurn` (default 3): successful level changes per session per turn. Reverts are not counted. The count resets at end of turn and is kept in memory only.
- Levels are ordered low to high (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `thinking` ranks like `high`; unknown names follow in catalog order). Guidance says so.
- `debugFile` option: the trace path is configurable. Default `$OPENCODE_LOG_DIR`, else `$XDG_DATA_HOME/opencode/log` (usually `~/.local/share/opencode/log`), file `opencode-adaptive-thinking.log`. The directory is created when debugging is on.
- The tool is exposed directly to the model (`options.codemode: false`). New option `codemode: true` restores Code Mode-only exposure.
- Experimental `applyMode: "request"`: the level is applied to the provider request options instead of switching the model variant, so no `model-switched` transcript entry. Overrides are stored under `request/<sessionID>`, cleared at end of turn unless persisted, and dropped on model or manual variant change.
- `scripts/live-matrix.sh`: live check against a real OpenCode server. Judges pass/fail from the trace, not model text. Example cases in `scripts/cases.example.txt`.
- Release workflow: pushing a `v*` tag runs the tests and creates a GitHub release from the matching CHANGELOG section.
- GitHub Actions pinned to full commit SHAs; Dependabot checks action updates weekly.

### Fixed

- Tool argument schema is now declared under `input`, the key OpenCode v2 reads; direct (non-Code Mode) calls previously arrived without arguments.

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
