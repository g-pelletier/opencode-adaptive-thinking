// Native OpenCode v2 port of ian-pascoe/opencode-adaptive-thinking (MIT).
// Lets any agent session (main or subagent) raise/lower its own reasoning-effort variant.
// - Injects guidance (current level + the levels this model supports) into each session's system prompt.
// - Registers `set_reasoning_effort` (level, persist). Before every switch it re-reads the live
//   model catalog for the session's current model and only applies a level that model exposes.
// - Non-persisted changes revert when the session's turn ends (again only if still supported).

const DEFAULTS = {
  enabled: true,
  toolName: "set_reasoning_effort",
  toolDescription: "Set your reasoning effort",
  systemPrompt:
    "Actively choose the lowest reasoning effort that can safely complete the task. " +
    "Raise effort for ambiguity, debugging, risky changes, or multi-step synthesis.",
  rootSessionsOnly: false,
  debug: false, // true appends a trace to /tmp/opencode/adaptive-thinking.log
};

const END_EVENTS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"];

export default {
  id: "opencode-adaptive-thinking",
  setup: async (ctx) => {
    if (typeof ctx?.session?.hook !== "function" || typeof ctx?.tool?.transform !== "function") {
      return async () => {};
    }
    const config = { ...DEFAULTS, ...(ctx.options ?? {}) };
    if (config.enabled === false) return async () => {};

    // sessionID -> { model: {providerID, id}, variant, resetVariant, isRoot }
    const sessions = new Map();
    const entry = (id) => {
      if (!sessions.has(id)) sessions.set(id, {});
      return sessions.get(id);
    };

    // Always query the live catalog: models differ in which levels they expose,
    // and the catalog can change (provider reloads, config edits).
    const variantsFor = async (model) => {
      if (!model?.providerID || !model?.id) return [];
      try {
        const list = await ctx.model.list();
        const catalog = Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : [];
        const found = catalog.find((m) => m.providerID === model.providerID && m.id === model.id);
        return Array.isArray(found?.variants) ? found.variants.map((v) => v.id).filter(Boolean) : [];
      } catch {
        return [];
      }
    };

    const isRootSession = async (sessionID) => {
      const state = entry(sessionID);
      if (state.isRoot !== undefined) return state.isRoot;
      try {
        const info = await ctx.session.get({ sessionID });
        const session = info?.data ?? info;
        state.isRoot = !(session?.parentID ?? session?.parentId);
      } catch {
        state.isRoot = true;
      }
      return state.isRoot;
    };
    const inScope = async (sessionID) => !config.rootSessionsOnly || (await isRootSession(sessionID));

    const switchVariant = (sessionID, model, variant) =>
      ctx.session.switchModel({ sessionID, model: { providerID: model.providerID, id: model.id, variant } });

    const disposers = [];
    const fs = await import("node:fs");
    const debug = (msg, data) => {
      if (!process.env.OPENCODE_ADAPTIVE_THINKING_DEBUG && !config.debug) return;
      try {
        fs.appendFileSync("/tmp/opencode/adaptive-thinking.log", `${new Date().toISOString()} ${msg} ${JSON.stringify(data ?? {})}\n`);
      } catch {}
    };

    // 1) Track each session's live model/variant and inject guidance for that model.
    const contextReg = await ctx.session.hook("context", async (event) => {
      if (!event?.sessionID || !event.model) return;
      const state = entry(event.sessionID);
      const model = { providerID: event.model.providerID, id: event.model.id };
      if (state.model && (state.model.providerID !== model.providerID || state.model.id !== model.id)) {
        // Model changed (fallback, manual switch): a pending revert target may not exist on the new model.
        delete state.resetVariant;
      }
      state.model = model;
      state.variant = event.model.variant;
      debug("context", { sessionID: event.sessionID, model: event.model, agent: event.agent });
      if (!(await inScope(event.sessionID))) return;
      const variants = await variantsFor(model);
      if (variants.length === 0 || !Array.isArray(event.system)) return;
      event.system.push({
        type: "text",
        text:
          `${config.systemPrompt.trim()} ` +
          (state.variant ? `Current reasoning effort level: ${state.variant}. ` : "") +
          `Valid reasoning effort levels for this session: ${variants.join(", ")}. ` +
          `To change your reasoning effort, use the \`${config.toolName}\` tool with one of the valid levels. ` +
          `The new level applies from your next step. Only call it when the task complexity justifies changing levels.`,
      });
    });
    disposers.push(() => contextReg?.dispose?.());

    // 2) The tool.
    const toolReg = await ctx.tool.transform((draft) => {
      draft.add({
        name: config.toolName,
        description: config.toolDescription,
        parameters: {
          type: "object",
          properties: {
            level: {
              type: "string",
              description: "Reasoning effort level; must be one of the valid levels listed in the system prompt for the current model.",
            },
            persist: {
              type: "boolean",
              description: "true keeps the level for the rest of the session; false (default) reverts when the current turn ends.",
            },
          },
          required: ["level"],
        },
        output: { type: "string" },
        execute: async (args, toolCtx) => {
          const result = (output) => ({ title: config.toolName, metadata: {}, output });
          const sessionID = toolCtx?.sessionID ?? toolCtx?.session?.id;
          if (!sessionID) return result("Failed to set reasoning effort: no session context");
          if (!(await inScope(sessionID))) {
            return result("Reasoning effort changes are disabled for sub-sessions (rootSessionsOnly); not changed.");
          }
          const state = entry(sessionID);
          if (!state.model) return result("Failed to set reasoning effort: current model unknown for this session");
          const modelRef = `${state.model.providerID}/${state.model.id}`;
          const variants = await variantsFor(state.model);
          if (variants.length === 0) {
            return result(`Not changed: ${modelRef} exposes no reasoning effort levels.`);
          }
          const level = String(args?.level ?? "");
          if (!variants.includes(level)) {
            return result(`Invalid reasoning effort level for ${modelRef}: ${level}. Valid levels: ${variants.join(", ")}.`);
          }
          const previous = state.variant;
          if (previous === level) {
            if (args?.persist === true) delete state.resetVariant;
            return result(`Reasoning effort already ${level} on ${modelRef}; not changed.`);
          }
          const sw = await switchVariant(sessionID, state.model, level);
          debug("switch", { sessionID, level, persist: args?.persist, previous, sw });
          if (args?.persist === true) delete state.resetVariant;
          else if (state.resetVariant === undefined && previous) state.resetVariant = previous;
          state.variant = level;
          return result(
            `Reasoning effort set to ${level} on ${modelRef}` +
              (args?.persist === true
                ? " (persisted for this session)."
                : state.resetVariant
                  ? ` (reverts to ${state.resetVariant} at end of turn).`
                  : "."),
          );
        },
      });
    });
    disposers.push(() => toolReg?.dispose?.());

    // 3) Revert temporary changes when the turn ends, only to a level the current model still supports.
    let stopped = false;
    try {
      const iterator = ctx.event.subscribe({ types: END_EVENTS })[Symbol.asyncIterator]();
      (async () => {
        while (!stopped) {
          const next = await iterator.next();
          if (next.done) break;
          const ev = next.value ?? {};
          const props = ev.properties ?? ev.data ?? ev;
          const sessionID = props?.sessionID;
          debug("end-event", { type: ev.type, sessionID, state: sessionID ? sessions.get(sessionID) : undefined });
          const state = sessionID && sessions.get(sessionID);
          if (!state?.resetVariant || !state.model) continue;
          const target = state.resetVariant;
          delete state.resetVariant;
          try {
            if (!(await variantsFor(state.model)).includes(target)) continue;
            await switchVariant(sessionID, state.model, target);
            state.variant = target;
          } catch {}
        }
      })().catch(() => {});
      disposers.push(() => {
        stopped = true;
        return iterator.return?.();
      });
    } catch {}

    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch {}
      }
    };
  },
};
