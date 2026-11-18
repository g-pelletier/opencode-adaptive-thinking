# opencode-adaptive-thinking

OpenCode **v2** plugin that lets an agent raise or lower its own reasoning effort during a session, in the main session and in subagents.

It is a native v2 rewrite of [ian-pascoe/opencode-adaptive-thinking](https://github.com/ian-pascoe/opencode-adaptive-thinking), which targets the v1 plugin API and does not load on OpenCode 2.x.

## What it does

- Adds guidance to each session's system prompt: the current reasoning effort level and the levels the session's **current model** supports.
- Registers a `set_reasoning_effort` tool with two arguments:
  - `level`: one of the levels listed in the system prompt.
  - `persist`: `true` keeps the level for the rest of the session. `false` (default) switches back when the turn ends.
- Before every change, it reads the live model catalog and only applies a level the current model exposes. Models differ: for example `none, thinking` on one model, `high, max` on another.
- Models without reasoning-effort levels get no guidance, and the tool answers `Not changed`.
- Temporary changes are recorded in plugin storage before the switch, so they survive a plugin reload or a server restart.
- A switch-back is skipped (and its record dropped) when the session's model or level changed since the plugin set it, for example a manual variant change or a provider fallback. The original level must also still exist on the model.
- A `persist: true` call, or a shutdown interrupt, never reverts: after a restart the server resumes the turn at the level it had.
- Calls for the same session are applied one at a time, so parallel tool calls cannot lose the original level.

## Install

Add it to the `plugins` list in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["github:g-pelletier/opencode-adaptive-thinking"]
}
```

Restart the OpenCode server.

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
        "debug": false
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
| `debug` | `false` | `true` appends a trace to `/tmp/opencode/adaptive-thinking.log`. |

## Limits

- Pending switch-backs are stored per session. Records older than 7 days are dropped at startup instead of reverted.
- A switch-back that fails to apply (host error) keeps its record and is retried at the next turn end or startup.
- If the session is still busy when the server starts, its record is left in place and is only checked again when the turn ends.
- Models without reasoning-effort levels get no guidance and the tool answers `Not changed`.
- On some models the tool is only reachable through Code Mode (`tools.set_reasoning_effort`), like other plugin tools.

## Storage

The plugin keeps one record per session under the `pending/` key prefix in its own plugin storage. A record exists only while a temporary change is waiting to be reverted. Records hold the model reference and level names only; no prompt or message content is stored.

## Development

```sh
npm test   # node:test, no dependencies (Node 20+)
```

## Requirements

OpenCode 2.x (tested on 2.3.0) with models that expose variants. Node 20+ for tests.

## License

MIT. Original work © Ian Pascoe.
