# opencode-adaptive-thinking

OpenCode **v2** plugin that lets an agent raise or lower its own reasoning effort during a session, in the main session and in subagents.

It is a native v2 rewrite of [ian-pascoe/opencode-adaptive-thinking](https://github.com/ian-pascoe/opencode-adaptive-thinking), which targets the v1 plugin API and does not load on OpenCode 2.x.

## What it does

- Adds guidance to each session's system prompt: the current reasoning effort level and the levels the session may use on its **current model**, ordered from lowest to highest effort.
- Registers a `set_reasoning_effort` tool with two arguments:
  - `level`: one of the levels listed in the system prompt.
  - `persist`: `true` keeps the level for the rest of the session. `false` (default) switches back when the turn ends.
- Before every change, it reads the live model catalog and only applies a level the current model exposes. Models differ: for example `none, thinking` on one model, `high, max` on another.
- Optional limits restrict which levels a session (or a named agent) may use, and how many changes it may make per turn. See [Level limits](#level-limits).
- Models without reasoning-effort levels get no guidance, and the tool answers `Not changed`.
- Temporary changes are recorded in plugin storage before the switch, so they survive a plugin reload or a server restart.
- A switch-back is skipped (and its record dropped) when the session's model or level changed since the plugin set it, for example a manual variant change or a provider fallback. The original level must also still exist on the model.
- A `persist: true` call, or a shutdown interrupt, never reverts: after a restart the server resumes the turn at the level it had.
- Calls for the same session are applied one at a time, so parallel tool calls cannot lose the original level.
- Manual changes are respected. You can change the level yourself with OpenCode's built-in `/effort`; the plugin drops a pending revert when the live variant no longer matches what it set.
- The tool is exposed directly to the model (not only through Code Mode). `codemode: true` restores the Code Mode-only exposure.
- Two ways to apply a level: `applyMode: "switch"` (default) switches the session's model variant; `applyMode: "request"` (experimental) changes only the provider request options. See [Apply modes](#apply-modes).

## Install

Add it to the `plugins` list in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["github:g-pelletier/opencode-adaptive-thinking"]
}
```

Restart the OpenCode server.

> **Do not keep a working copy under `~/.config/opencode/plugins`.** OpenCode loads everything in that directory automatically. A copy there next to the `github:` install gives you two instances of the plugin that fight over the same session and storage.

## Update

`github:` installs are cached by OpenCode. Updating the repository does not update the cache, so either:

1. Refresh the cache and restart:

   ```sh
   rm -rf ~/.cache/opencode/npm/git-opencode-adaptive-thinking-*
   ```

   then restart the OpenCode server, or

2. Pin a release tag and change it when you want to upgrade:

   ```json
   { "plugins": ["github:g-pelletier/opencode-adaptive-thinking#v1.2.0"] }
   ```

## Options

```json
{
  "plugins": [
    {
      "package": "github:g-pelletier/opencode-adaptive-thinking",
      "options": {
        "enabled": true,
        "rootSessionsOnly": false,
        "toolName": "set_reasoning_effort",
        "toolDescription": "Set your reasoning effort",
        "systemPrompt": "Actively choose the lowest reasoning effort that can safely complete the task. Raise effort for ambiguity, debugging, risky changes, or multi-step synthesis.",
        "maxSwitchesPerTurn": 3,
        "allowedLevels": ["low", "medium", "high"],
        "maxLevel": "high",
        "agents": {
          "explorer": { "maxLevel": "low" },
          "quiet-helper": { "enabled": false }
        },
        "applyMode": "switch",
        "codemode": false,
        "debug": false,
        "debugFile": "~/.local/share/opencode/log/opencode-adaptive-thinking.log"
      }
    }
  ]
}
```

| Option | Default | Effect |
|---|---|---|
| `enabled` | `true` | Turn the plugin off without removing it. |
| `rootSessionsOnly` | `false` | `true` limits it to the main session; subagents keep their configured level. |
| `toolName` | `set_reasoning_effort` | Name of the tool. |
| `toolDescription` | `Set your reasoning effort` | Tool description shown to the model. |
| `systemPrompt` | see above | Guidance text added before the level list. |
| `maxSwitchesPerTurn` | `3` | Successful level changes allowed per session per turn. Reverts do not count. `0` blocks all changes. |
| `allowedLevels` | not set | Array of level names. Only these levels may be used. |
| `maxLevel` | not set | Highest level allowed, by the ordering below. |
| `agents` | not set | Object keyed by agent name. Each entry may set `allowedLevels`, `maxLevel`, or `enabled: false`. |
| `applyMode` | `"switch"` | `"switch"` changes the session's model variant. `"request"` (experimental) changes only provider request options. See [Apply modes](#apply-modes). |
| `codemode` | `false` | `false` exposes the tool directly to the model. `true` keeps it reachable only through Code Mode. |
| `debug` | `false` | `true` appends a trace to `debugFile`. |
| `debugFile` | `$OPENCODE_LOG_DIR`, else `$XDG_DATA_HOME/opencode/log` (default `~/.local/share/opencode/log`), file `opencode-adaptive-thinking.log` | Path of the trace file used when `debug` is on. The directory is created if missing. |

`OPENCODE_ADAPTIVE_THINKING_DEBUG=1` in the server environment also turns the trace on.

## Apply modes

### switch (default)

The level is applied by switching the session's model variant. Each switch is recorded before it happens, and temporary changes revert at end of turn (see Storage). The host shows each switch as a visible `model-switched` entry in the transcript.

### request (experimental)

Status: experimental. The host forwards `event.options` to the provider request (live check: an invalid injected option produced a provider validation error, and an override set `effort: "high"` in the request). The effect on reasoning could not be measured: the provider reported 0 reasoning tokens even for native variants, so treat request mode as unproven for quality or cost.

```json
{ "options": { "applyMode": "request" } }
```

In request mode the plugin never calls `switchModel`, so there is no transcript entry. The chosen level is stored under `request/<sessionID>`. On each context event, if the override still matches the session's model and the host variant, the plugin:

1. removes the settings keys of the host's current variant from the request options,
2. adds the settings of the chosen variant from the model catalog.

Temporary overrides are cleared at end of turn. `persist: true` keeps them. A model change or a manual variant change drops the override. The same limits and switch counting apply.

A level is refused when its catalog entry has no `settings`.

## Level limits

Levels are ordered from lowest to highest effort:

`none` < `minimal` < `low` < `medium` < `high` < `xhigh` < `max`

`thinking` ranks like `high`. Any other name is unknown: unknown names are listed after the known ones, in the order the model reports them.

For a session, the valid levels are the model's levels, filtered by:

- `allowedLevels` (when set): only the listed names.
- `maxLevel` (when set): levels ranked at or below it. A name that is not ranked can only pass when `allowedLevels` names it.

Per-agent settings in `agents` override the top-level `allowedLevels` and `maxLevel` for that agent. `enabled: false` turns the plugin off for that agent: no guidance, and the tool answers `Not changed`.

The agent name comes from the host's context event, or from the tool call context when the host provides it.

```json
{
  "options": {
    "maxLevel": "high",
    "agents": {
      "explorer": { "maxLevel": "low" },
      "fast-reviewer": { "allowedLevels": ["none", "low"] },
      "quiet-helper": { "enabled": false }
    }
  }
}
```

With this config, the main session can use `none` … `high`, `explorer` can use `none`, `minimal`, `low`, and `quiet-helper` cannot change its level.

A blocked level is rejected with a message that says the level exists on the model but is blocked by configuration, and lists the valid levels.

Going back to the level a temporary change will revert to is never blocked by these limits or by `maxSwitchesPerTurn`. A session that starts above its limit can always return to its original level.

### Switch limit

`maxSwitchesPerTurn` counts successful level changes per session. When the limit is reached, the tool answers `Not changed: switch limit reached for this turn (N)`. The count resets when the turn ends. It is kept in memory only, so a plugin reload starts the count again.

## Limits

- Pending switch-backs are stored per session. Records older than 7 days are dropped at startup instead of reverted.
- A switch-back that fails to apply (host error) keeps its record and is retried at the next turn end or startup.
- If the session is still busy when the server starts, its record is left in place and is only checked again when the turn ends.
- Models without reasoning-effort levels get no guidance and the tool answers `Not changed`.
- The tool is exposed directly by default. With `"codemode": true` it is reachable only through Code Mode (`tools.set_reasoning_effort`).

## Storage

The plugin keeps one record per session under the `pending/` key prefix in its own plugin storage. A record exists only while a temporary change is waiting to be reverted. In request mode, overrides are kept under `request/<sessionID>`. Records hold the model reference and level names only; no prompt or message content is stored.

## Logging

The plugin has no host logger. With `debug: true` it appends a trace to `debugFile`. The default is `$OPENCODE_LOG_DIR`, or `$XDG_DATA_HOME/opencode/log` (usually `~/.local/share/opencode/log`), in the file `opencode-adaptive-thinking.log`. Set `OPENCODE_ADAPTIVE_THINKING_DEBUG=1` in the server environment to turn the trace on without editing the config.

## Live test

`scripts/live-matrix.sh` runs a real OpenCode server through a set of cases, one model/variant per case, and judges each one from the plugin trace. It does not read the model's text.

1. Turn on the trace in your OpenCode config. Without `debugFile` it goes to the default path above; if you set `debugFile`, pass the same path with `-t`:

   ```json
   { "options": { "debug": true } }
   ```

2. Copy `scripts/cases.example.txt` and replace the generic entries with models you have. Each line is:

   ```text
   provider/model#start|bad|target|persist|expected-next
   ```

   | Field | Meaning |
   |---|---|
   | `start` | Variant the session starts on. Empty means the model default. |
   | `bad` | Level that must be rejected. `-` means none. |
   | `target` | Level the agent is asked to set. |
   | `persist` | `true` or `false`. |
   | `expected-next` | Variant on the first context line of the second turn. `default` means the model default. |

3. Run it:

   ```sh
   scripts/live-matrix.sh -f my-cases.txt
   # or a single case:
   scripts/live-matrix.sh 'provider/model#low|-|high|false|low'
   ```

The script prints one row per case and a count. It exits `1` if any case fails and `2` on usage errors. It needs `opencode`, `bash`, `grep`, `sed`, and `mktemp` on the PATH. Each case makes real model calls, so it costs tokens.

## Development

```sh
npm test   # node:test, no dependencies (Node 22+)
```

## Requirements

OpenCode 2.x (tested on 2.3.0) with models that expose variants. Node 22+.

## License

MIT. Original work © Ian Pascoe.
