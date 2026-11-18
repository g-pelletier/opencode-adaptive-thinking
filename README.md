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
- If the session's model changes during a turn, a pending switch-back is dropped. The switch-back is also skipped if the original level no longer exists on the model.

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

- Session state is kept in memory. If the server restarts or the plugin reloads mid-turn, a temporary change is not switched back.
- On some models the tool is only reachable through Code Mode (`tools.set_reasoning_effort`), like other plugin tools.

## Requirements

OpenCode 2.x (tested on 2.3.0) with models that expose variants.

## License

MIT. Original work © Ian Pascoe.
