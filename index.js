// Native OpenCode v2 port of ian-pascoe/opencode-adaptive-thinking (MIT).
// Lets any agent session (main or subagent) raise/lower its own reasoning-effort variant.
// - Injects guidance (current level + the levels this model supports) into each session's system prompt.
// - Registers `set_reasoning_effort` (level, persist). Every change is checked against the live model catalog.
// - Temporary changes are recorded in storage (pending/<sessionID>) before the switch and reverted when the
//   turn ends, but only if the session still shows the level the plugin set on the same model.
// - Storage survives reloads and restarts; a startup scan reconciles entries left by an earlier process.

import fs from "node:fs";
import {
  catalogVariants,
  levelName,
  levelOf,
  modelRef,
  readPending,
  reconcile,
  removePending,
  sameModel,
  scanPending,
  switchTo,
  writePending,
} from "./src/pending.js";

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
const LOG_FILE = "/tmp/opencode/adaptive-thinking.log";
const MAX_BACKOFF_MS = 30_000;
const noop = async () => {};

export default {
  id: "opencode-adaptive-thinking",
  setup: async (ctx) => {
    if (typeof ctx?.session?.hook !== "function" || typeof ctx?.tool?.transform !== "function" || !ctx.storage) {
      return noop;
    }
    const config = { ...DEFAULTS, ...(ctx.options ?? {}) };
    if (config.enabled === false) return noop;

    const debugOn = config.debug === true || !!process.env.OPENCODE_ADAPTIVE_THINKING_DEBUG;
    const debug = (msg, data) => {
      if (!debugOn) return;
      try {
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg} ${JSON.stringify(data ?? {})}\n`);
      } catch {}
    };

    // In-memory cache only (guidance and tool input). Never the source of truth for pending reverts.
    // sessionID -> { model, variant, isRoot }
    const states = new Map();
    const stateOf = (sessionID) => {
      if (!states.has(sessionID)) states.set(sessionID, {});
      return states.get(sessionID);
    };

    // Per-session promise chain: tool calls and reverts for one session never interleave.
    const queues = new Map();
    const serialize = (sessionID, task) => {
      const run = (queues.get(sessionID) ?? Promise.resolve()).then(task);
      const tail = run.catch(() => {});
      queues.set(sessionID, tail);
      tail.then(() => {
        if (queues.get(sessionID) === tail) queues.delete(sessionID);
      });
      return run;
    };

    // Levels for the model's current catalog entry; null when the catalog cannot be read.
    const levelsFor = async (model) => {
      try {
        return await catalogVariants(ctx, model);
      } catch {
        return null;
      }
    };

    const isRootSession = async (sessionID) => {
      const state = stateOf(sessionID);
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

    const disposers = [];
    let disposed = false;

    // 1) Track each session's live model/variant (cache) and inject guidance for that model.
    const contextReg = await ctx.session.hook("context", async (event) => {
      if (!event?.sessionID || !event.model) return;
      const state = stateOf(event.sessionID);
      state.model = { providerID: event.model.providerID, id: event.model.id };
      state.variant = levelOf(event.model.variant); // undefined and null both mean the model default
      debug("context", { sessionID: event.sessionID, model: state.model, variant: state.variant });
      if (!(await inScope(event.sessionID))) return;
      const variants = await levelsFor(state.model);
      if (!variants?.length || !Array.isArray(event.system)) return;
      event.system.push({
        type: "text",
        text:
          `${config.systemPrompt.trim()} ` +
          `Current reasoning effort level: ${state.variant ?? "default (model's own setting)"}. ` +
          `Valid reasoning effort levels for this session: ${variants.join(", ")}. ` +
          `To change your reasoning effort, use the \`${config.toolName}\` tool with one of the valid levels. ` +
          `The new level applies from your next step. Only call it when the task complexity justifies changing levels.`,
      });
    });
    disposers.push(() => contextReg?.dispose?.());

    // Runs inside the session's queue.
    const setEffort = async (sessionID, args) => {
      const reply = (output) => ({ title: config.toolName, metadata: {}, output });
      if (!(await inScope(sessionID))) {
        return reply("Reasoning effort changes are disabled for sub-sessions (rootSessionsOnly); not changed.");
      }
      const state = stateOf(sessionID);
      if (!state.model) return reply("Failed to set reasoning effort: current model unknown for this session");
      const model = state.model;
      const ref = modelRef(model);
      const variants = await levelsFor(model);
      if (variants === null) return reply(`Failed to set reasoning effort on ${ref}: model catalog unavailable; not changed.`);
      if (variants.length === 0) return reply(`Not changed: ${ref} exposes no reasoning effort levels.`);
      const level = String(args?.level ?? "");
      if (!variants.includes(level)) {
        return reply(`Invalid reasoning effort level for ${ref}: ${level}. Valid levels: ${variants.join(", ")}.`);
      }

      const persist = args?.persist === true;
      const previous = levelOf(state.variant);
      const existing = await readPending(ctx, sessionID);
      // Keep the original target across repeated temporary calls on the same model.
      const resetVariant = existing && sameModel(existing.model, model) ? existing.resetVariant : previous;
      const keep = !persist && resetVariant !== level;
      const needsSwitch = previous !== level;
      const entry = keep
        ? { model: { providerID: model.providerID, id: model.id }, resetVariant, appliedVariant: level, at: Date.now() }
        : undefined;

      // Record before switching so a crash mid-switch cannot lose the original level.
      try {
        if (entry) await writePending(ctx, sessionID, entry);
        else if (existing) await removePending(ctx, sessionID);
        if (needsSwitch) await switchTo(ctx, sessionID, model, level);
      } catch (error) {
        const message = error?.message ?? String(error);
        debug("switch failed", { sessionID, level, message });
        try {
          if (existing) await writePending(ctx, sessionID, existing);
          else await removePending(ctx, sessionID);
        } catch {}
        return reply(`Failed to set reasoning effort to ${level} on ${ref}: ${message}. Not changed.`);
      }

      state.variant = level;
      debug("set", { sessionID, level, persist, previous, reset: entry?.resetVariant });
      const verb = needsSwitch ? `set to ${level}` : `already ${level}`;
      const tail = persist
        ? " (persisted for this session)."
        : entry
          ? ` (reverts to ${levelName(resetVariant)} at end of turn).`
          : ".";
      return reply(`Reasoning effort ${verb} on ${ref}${tail}`);
    };

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
          const sessionID = toolCtx?.sessionID ?? toolCtx?.session?.id;
          if (!sessionID) {
            return { title: config.toolName, metadata: {}, output: "Failed to set reasoning effort: no session context" };
          }
          return serialize(sessionID, () => setEffort(sessionID, args)).catch((error) => {
            debug("tool error", { sessionID, message: error?.message ?? String(error) });
            return {
              title: config.toolName,
              metadata: {},
              output: `Failed to set reasoning effort: ${error?.message ?? String(error)}. Not changed.`,
            };
          });
        },
      });
    });
    disposers.push(() => toolReg?.dispose?.());

    // 3) Revert a temporary change once its turn has ended.
    const revertPending = async (sessionID) => {
      const entry = await readPending(ctx, sessionID);
      if (!entry) return;
      const outcome = await reconcile(ctx, sessionID, entry, { log: debug });
      debug("revert", { sessionID, outcome });
      if (outcome === "reverted") stateOf(sessionID).variant = entry.resetVariant;
    };

    const onEnd = (ev) => {
      const props = ev?.data ?? ev?.properties ?? {};
      const sessionID = props.sessionID;
      if (typeof sessionID !== "string") return;
      // Shutdown interrupts are not the end of a turn: keep the entry, the server resumes the turn after restart.
      if (ev.type === "session.execution.interrupted" && props.reason === "shutdown") {
        debug("end ignored (shutdown)", { sessionID });
        return;
      }
      serialize(sessionID, () => revertPending(sessionID)).catch((error) =>
        debug("revert error", { sessionID, message: error?.message ?? String(error) }),
      );
    };

    // Subscription loop: resubscribe with backoff until disposed. Events are handled without being awaited.
    let timer;
    let wake;
    let activeIterator;
    const sleep = (ms) =>
      new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      });
    const listen = async () => {
      let backoff = 500;
      while (!disposed) {
        try {
          activeIterator = ctx.event.subscribe({ types: END_EVENTS })[Symbol.asyncIterator]();
          for (;;) {
            const next = await activeIterator.next();
            if (next.done || disposed) break;
            backoff = 500;
            onEnd(next.value);
          }
          debug("event stream ended");
        } catch (error) {
          debug("event stream error", { message: error?.message ?? String(error) });
        }
        if (disposed) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    };
    listen().catch((error) => debug("listener stopped", { message: error?.message ?? String(error) }));
    disposers.push(async () => {
      disposed = true;
      clearTimeout(timer);
      wake?.();
      await activeIterator?.return?.();
    });

    // Startup scan: fire-and-forget so setup is not delayed by storage size.
    scanPending(ctx, { log: debug, lock: serialize }).catch((error) =>
      debug("startup scan failed", { message: error?.message ?? String(error) }),
    );

    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch {}
      }
    };
  },
};
