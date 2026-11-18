// Native OpenCode v2 port of ian-pascoe/opencode-adaptive-thinking (MIT).
// Lets any agent session (main or subagent) raise/lower its own reasoning-effort variant.
// - Injects guidance (current level + the levels this model supports) into each session's system prompt.
// - Registers `set_reasoning_effort` (level, persist). Every change is checked against the live model catalog and
//   the configured limits.
// - applyMode "switch" (default): temporary changes are recorded in storage (pending/<sessionID>) before the switch
//   and reverted when the turn ends, but only if the session still shows the level the plugin set on the same model.
// - applyMode "request" (experimental): the level is applied to the provider request options instead; nothing is
//   switched. Records live under request/<sessionID> and are cleared at turn end unless persisted.
// - Storage survives reloads and restarts; a startup scan reconciles pending entries left by an earlier process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentOf, effectiveLevels, limitsFor } from "./src/limits.js";
import { applyVariantOverride, readRequest, removeRequest, writeRequest } from "./src/request.js";
import {
  catalogEntries,
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
  maxSwitchesPerTurn: 3, // successful level changes per session per turn; reverts are not counted
  applyMode: "switch", // "switch" | "request" (experimental, see src/request.js)
  codemode: false, // false exposes the tool directly; true keeps it reachable only through Code Mode
  debug: false, // true appends a trace to debugFile
  debugFile: undefined, // default: $OPENCODE_LOG_DIR or <data>/opencode/log, file opencode-adaptive-thinking.log
};

const END_EVENTS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"];
const defaultDebugFile = () => {
  const dir =
    process.env.OPENCODE_LOG_DIR ||
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "log");
  return path.join(dir, "opencode-adaptive-thinking.log");
};
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
    if (!Number.isInteger(config.maxSwitchesPerTurn) || config.maxSwitchesPerTurn < 0) {
      config.maxSwitchesPerTurn = DEFAULTS.maxSwitchesPerTurn;
    }
    const requestMode = config.applyMode === "request";

    const debugOn = config.debug === true || !!process.env.OPENCODE_ADAPTIVE_THINKING_DEBUG;
    const logFile =
      typeof config.debugFile === "string" && config.debugFile.length > 0 ? config.debugFile : defaultDebugFile();
    if (debugOn) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
      } catch {}
    }
    const debug = (msg, data) => {
      if (!debugOn) return;
      try {
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg} ${JSON.stringify(data ?? {})}\n`);
      } catch {}
    };

    // In-memory cache only (guidance and tool input). Never the source of truth for pending reverts.
    // sessionID -> { model, variant (host's own variant), agent, isRoot }
    const states = new Map();
    const stateOf = (sessionID) => {
      if (!states.has(sessionID)) states.set(sessionID, {});
      return states.get(sessionID);
    };

    // Successful level changes made in the current turn, sessionID -> count. Memory only; cleared at turn end.
    const turnSwitches = new Map();

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

    // Variants for the model's current catalog entry ([{ id, settings }]); null when the catalog cannot be read.
    const entriesFor = async (model) => {
      try {
        return await catalogEntries(ctx, model);
      } catch {
        return null;
      }
    };
    const levelsFor = async (model) => {
      const entries = await entriesFor(model);
      return entries === null ? null : entries.map((v) => v.id);
    };

    // Levels this agent may use on the model, ordered low -> high; null when the catalog cannot be read.
    const allowedFor = async (model, agent) => {
      const catalog = await levelsFor(model);
      return catalog === null ? null : effectiveLevels(catalog, limitsFor(config, agent));
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

    // Request mode: the stored override if it still applies to the session's model and host variant.
    // Otherwise it is dropped (model changed, or the user changed the variant by hand).
    const requestFor = async (sessionID, state) => {
      if (!requestMode || !state.model) return undefined;
      const entry = await readRequest(ctx, sessionID);
      if (!entry) return undefined;
      if (!sameModel(entry.model, state.model) || levelOf(state.variant) !== entry.resetVariant) {
        await removeRequest(ctx, sessionID);
        debug("request dropped", { sessionID, reason: sameModel(entry.model, state.model) ? "variant" : "model" });
        return undefined;
      }
      return entry;
    };

    const disposers = [];
    let disposed = false;

    // 1) Track each session's live model/variant (cache), inject guidance, and apply a request-mode override.
    const contextReg = await ctx.session.hook("context", async (event) => {
      if (!event?.sessionID || !event.model) return;
      const state = stateOf(event.sessionID);
      state.model = { providerID: event.model.providerID, id: event.model.id };
      state.variant = levelOf(event.model.variant); // undefined and null both mean the model default
      state.agent = agentOf(event.agent) ?? state.agent;
      const request = await requestFor(event.sessionID, state);
      const shown = request ? request.level : state.variant;
      debug("context", {
        sessionID: event.sessionID,
        model: state.model,
        variant: state.variant,
        request: request?.level,
        agent: state.agent,
      });
      if (request && isRecordObject(event.options)) {
        const entries = await entriesFor(state.model);
        const target = entries?.find((v) => v.id === request.level);
        if (target?.settings) {
          const base = request.resetVariant === null ? undefined : entries.find((v) => v.id === request.resetVariant);
          applyVariantOverride(event.options, base?.settings, target.settings);
        } else {
          debug("request skipped: no settings for level", { sessionID: event.sessionID, level: request.level });
        }
      }
      if (!(await inScope(event.sessionID))) return;
      const variants = await allowedFor(state.model, state.agent);
      if (!variants?.length || !Array.isArray(event.system)) return;
      event.system.push({
        type: "text",
        text:
          `${config.systemPrompt.trim()} ` +
          `Current reasoning effort level: ${shown ?? "default (model's own setting)"}. ` +
          `Valid reasoning effort levels for this session (ordered from lowest to highest effort): ${variants.join(", ")}. ` +
          `To change your reasoning effort, use the \`${config.toolName}\` tool with one of the valid levels. ` +
          `The new level applies from your next step. Only call it when the task complexity justifies changing levels.`,
      });
    });
    disposers.push(() => contextReg?.dispose?.());

    // Runs inside the session's queue.
    const setEffort = async (sessionID, args, agent) => {
      const reply = (output) => ({ title: config.toolName, metadata: {}, output });
      if (!(await inScope(sessionID))) {
        return reply("Reasoning effort changes are disabled for sub-sessions (rootSessionsOnly); not changed.");
      }
      const state = stateOf(sessionID);
      if (!state.model) return reply("Failed to set reasoning effort: current model unknown for this session");
      const model = state.model;
      const ref = modelRef(model);
      const entries = await entriesFor(model);
      if (entries === null) return reply(`Failed to set reasoning effort on ${ref}: model catalog unavailable; not changed.`);
      if (entries.length === 0) return reply(`Not changed: ${ref} exposes no reasoning effort levels.`);
      const catalog = entries.map((v) => v.id);
      const limits = limitsFor(config, agent);
      const allowed = effectiveLevels(catalog, limits);
      const allowedText = allowed.join(", ") || "none";
      const who = agent ? `agent ${agent}` : "this session";
      const level = String(args?.level ?? "");
      const persist = args?.persist === true;

      // Switch mode: the session's variant is the level. Request mode: the stored override is the level.
      const request = requestMode ? await requestFor(sessionID, state) : undefined;
      const previous = requestMode ? (request ? request.level : levelOf(state.variant)) : levelOf(state.variant);
      const existing = requestMode ? request : await readPending(ctx, sessionID);
      const sameAsPending = !!existing && sameModel(existing.model, model);
      // Going back to the level recorded for this turn is never blocked by limits or by the switch limit.
      const isRevert = sameAsPending && existing.resetVariant === level && catalog.includes(level);
      if (!isRevert) {
        if (!limits.enabled) return reply(`Not changed: reasoning effort changes are disabled for ${who} by configuration.`);
        if (!allowed.includes(level)) {
          if (catalog.includes(level)) {
            return reply(
              `Not changed: ${level} exists on ${ref} but is blocked by configuration for ${who}. Valid levels: ${allowedText}.`,
            );
          }
          return reply(`Invalid reasoning effort level for ${ref}: ${level}. Valid levels: ${allowedText}.`);
        }
      }

      // Keep the original target across repeated temporary calls on the same model.
      const resetVariant = sameAsPending ? existing.resetVariant : levelOf(state.variant);
      const temporary = !persist && resetVariant !== level;
      const needsSwitch = previous !== level;
      const counts = needsSwitch && !isRevert;
      if (requestMode && needsSwitch && !entries.find((v) => v.id === level)?.settings) {
        return reply(`Not changed: ${level} on ${ref} has no provider settings to apply in request mode.`);
      }
      if (counts && (turnSwitches.get(sessionID) ?? 0) >= config.maxSwitchesPerTurn) {
        debug("switch limit", { sessionID, limit: config.maxSwitchesPerTurn });
        return reply(`Not changed: switch limit reached for this turn (${config.maxSwitchesPerTurn}).`);
      }

      if (requestMode) {
        // No switch: the override is stored, or removed when the level is back to the host's variant.
        try {
          if (level === resetVariant) await removeRequest(ctx, sessionID);
          else
            await writeRequest(ctx, sessionID, {
              model: { providerID: model.providerID, id: model.id },
              resetVariant,
              level,
              persist,
              at: Date.now(),
            });
        } catch (error) {
          const message = error?.message ?? String(error);
          debug("request write failed", { sessionID, level, message });
          return reply(`Failed to set reasoning effort to ${level} on ${ref}: ${message}. Not changed.`);
        }
      } else {
        const entry = temporary
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
      }

      if (counts) turnSwitches.set(sessionID, (turnSwitches.get(sessionID) ?? 0) + 1);
      debug("set", { sessionID, agent, mode: config.applyMode, level, persist, previous, reset: resetVariant });
      const verb = needsSwitch ? `set to ${level}` : `already ${level}`;
      const tail = persist
        ? " (persisted for this session)."
        : temporary
          ? ` (reverts to ${levelName(resetVariant)} at end of turn).`
          : ".";
      return reply(`Reasoning effort ${verb} on ${ref}${tail}`);
    };

    // 2) The tool.
    const toolReg = await ctx.tool.transform((draft) => {
      draft.add({
        name: config.toolName,
        description: config.toolDescription,
        options: { codemode: config.codemode === true },
        input: {
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
          const agent = agentOf(toolCtx?.agent) ?? stateOf(sessionID).agent;
          return serialize(sessionID, () => setEffort(sessionID, args, agent)).catch((error) => {
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

    // Request mode: a non-persisted override ends with its turn.
    const endRequest = async (sessionID) => {
      if (!requestMode) return;
      const entry = await readRequest(ctx, sessionID);
      if (entry && !entry.persist) await removeRequest(ctx, sessionID);
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
      // The turn counter is reset inside the session queue, so it cannot race a tool call in progress.
      serialize(sessionID, async () => {
        turnSwitches.delete(sessionID);
        await endRequest(sessionID);
        return revertPending(sessionID);
      }).catch((error) => debug("revert error", { sessionID, message: error?.message ?? String(error) }));
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

const isRecordObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
