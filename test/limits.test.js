import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../index.js";
import { effectiveLevels, limitsFor, orderLevels } from "../src/limits.js";
import { callTool, createFakeCtx, runContext, tick } from "./fake-ctx.js";

const M1 = (variant) => (variant === undefined ? { providerID: "p", id: "m1" } : { providerID: "p", id: "m1", variant });
const ended = (sessionID) => ({ type: "session.execution.succeeded", properties: { sessionID } });
const M4 = { providerID: "p", id: "m4" };
const CATALOG_M4 = [
  {
    providerID: "p",
    id: "m4",
    variants: [{ id: "max" }, { id: "thinking" }, { id: "weird" }, { id: "low" }],
  },
];

async function start(t, ctx) {
  const dispose = await plugin.setup(ctx);
  t.after(() => dispose());
  return dispose;
}

function session(variant) {
  return { model: { providerID: "p", id: "m1", ...(variant === undefined ? {} : { variant }) }, time: { idle: 2, busy: 1 } };
}

// ---- pure functions ----

test("orderLevels: known ranks low -> high, thinking ranks like high, unknown keep catalog order after", () => {
  assert.deepEqual(orderLevels(["max", "thinking", "custom", "high", "low", "none", "other"]), [
    "none",
    "low",
    "thinking",
    "high",
    "max",
    "custom",
    "other",
  ]);
});

test("effectiveLevels: maxLevel keeps ranks at or below it, even when maxLevel is not in the catalog", () => {
  assert.deepEqual(effectiveLevels(["max", "low", "high"], { enabled: true, maxLevel: "xhigh" }), ["low", "high"]);
  assert.deepEqual(effectiveLevels(["low", "high", "max"], { enabled: true, maxLevel: "high" }), ["low", "high"]);
});

test("effectiveLevels: unknown names are kept only when allowedLevels names them", () => {
  const catalog = ["low", "turbo", "high"];
  assert.deepEqual(effectiveLevels(catalog, { enabled: true, maxLevel: "high" }), ["low", "high"]);
  assert.deepEqual(
    effectiveLevels(catalog, { enabled: true, maxLevel: "high", allowedLevels: ["turbo", "high", "low"] }),
    ["low", "high", "turbo"],
  );
});

test("effectiveLevels: allowedLevels intersects the catalog; enabled:false yields nothing", () => {
  assert.deepEqual(effectiveLevels(["low", "high", "max"], { enabled: true, allowedLevels: ["max", "low", "x"] }), [
    "low",
    "max",
  ]);
  assert.deepEqual(effectiveLevels(["low", "high"], { enabled: false }), []);
});

test("limitsFor: per-agent keys override the top-level keys; other keys fall back", () => {
  const config = { maxLevel: "high", allowedLevels: ["low", "high"], agents: { explorer: { maxLevel: "low" } } };
  assert.deepEqual(limitsFor(config, "explorer"), { enabled: true, allowedLevels: ["low", "high"], maxLevel: "low" });
  assert.deepEqual(limitsFor(config, "build"), { enabled: true, allowedLevels: ["low", "high"], maxLevel: "high" });
  assert.deepEqual(limitsFor(config, undefined), { enabled: true, allowedLevels: ["low", "high"], maxLevel: "high" });
});

// ---- plugin behaviour ----

test("global maxLevel: guidance lists only allowed levels and the tool names the blocked level", async (t) => {
  const ctx = createFakeCtx({ options: { maxLevel: "high" }, sessions: { s1: session("low") } });
  await start(t, ctx);
  const system = await runContext(ctx, "s1", M1("low"));
  assert.match(system[0].text, /ordered from lowest to highest effort\): low, high\./);

  const out = await callTool(ctx, { level: "max" });
  assert.equal(
    out,
    "Not changed: max exists on p/m1 but is blocked by configuration for this session. Valid levels: low, high.",
  );
  assert.equal(ctx.switches.length, 0);
});

test("allowedLevels restricts guidance and the tool", async (t) => {
  const ctx = createFakeCtx({ options: { allowedLevels: ["low", "max"] }, sessions: { s1: session("low") } });
  await start(t, ctx);
  const system = await runContext(ctx, "s1", M1("low"));
  assert.match(system[0].text, /: low, max\./);
  assert.match(await callTool(ctx, { level: "high" }), /^Not changed: high exists on p\/m1 but is blocked/);
});

test("a level missing from the catalog is still reported as invalid, not blocked", async (t) => {
  const ctx = createFakeCtx({ options: { maxLevel: "high" }, sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  assert.equal(
    await callTool(ctx, { level: "turbo" }),
    "Invalid reasoning effort level for p/m1: turbo. Valid levels: low, high.",
  );
});

test("per-agent limits apply to the agent from the context hook and from the tool context", async (t) => {
  const ctx = createFakeCtx({
    options: { maxLevel: "high", agents: { explorer: { maxLevel: "low" } } },
    sessions: { s1: session("low"), s2: session("low") },
  });
  await start(t, ctx);

  const explorer = await runContext(ctx, "s1", M1("low"), [], "explorer");
  assert.match(explorer[0].text, /: low\. /);
  assert.match(await callTool(ctx, { level: "high" }), /blocked by configuration for agent explorer/);

  const build = await runContext(ctx, "s2", M1("low"), [], "build");
  assert.match(build[0].text, /: low, high\. /);
  assert.equal(await callTool(ctx, { level: "high" }, "s2", "build"), "Reasoning effort set to high on p/m1 (reverts to low at end of turn).");
});

test("agent with enabled:false gets no guidance and cannot change its level", async (t) => {
  const ctx = createFakeCtx({ options: { agents: { locked: { enabled: false } } }, sessions: { s1: session("low") } });
  await start(t, ctx);
  const system = await runContext(ctx, "s1", M1("low"), [], "locked");
  assert.equal(system.length, 0);
  assert.equal(
    await callTool(ctx, { level: "high" }, "s1", "locked"),
    "Not changed: reasoning effort changes are disabled for agent locked by configuration.",
  );
  assert.equal(ctx.switches.length, 0);
});

test("revert target is never blocked: going back to a blocked original level works", async (t) => {
  const ctx = createFakeCtx({ options: { maxLevel: "high" }, sessions: { s1: session("max") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("max"));
  assert.match(await callTool(ctx, { level: "high" }), /reverts to max at end of turn/);
  assert.match(await callTool(ctx, { level: "max" }), /^Reasoning effort set to max on p\/m1\.$/);
  assert.equal(ctx.storageMap.has("pending/s1"), false);
  assert.equal(ctx.sessions.s1.model.variant, "max");
});

test("end-of-turn revert restores a blocked original level", async (t) => {
  const ctx = createFakeCtx({ options: { maxLevel: "high" }, sessions: { s1: session("max") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("max"));
  await callTool(ctx, { level: "low" });
  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "max");
});

test("switch limit: default is 3 per turn, counted per session, reset at turn end", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  assert.match(await callTool(ctx, { level: "high" }), /^Reasoning effort set to high/);
  assert.match(await callTool(ctx, { level: "max" }), /^Reasoning effort set to max/);
  assert.match(await callTool(ctx, { level: "high" }), /^Reasoning effort set to high/);
  assert.equal(
    await callTool(ctx, { level: "max" }),
    "Not changed: switch limit reached for this turn (3).",
  );
  assert.equal(ctx.switches.length, 3);

  ctx.stream.push(ended("s1"));
  await tick();
  assert.match(await callTool(ctx, { level: "max" }), /^Reasoning effort set to max/);
});

test("switch limit: revert targets are free and not counted", async (t) => {
  const ctx = createFakeCtx({ options: { maxSwitchesPerTurn: 1 }, sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  assert.match(await callTool(ctx, { level: "high" }), /^Reasoning effort set to high/);
  assert.match(await callTool(ctx, { level: "low" }), /^Reasoning effort set to low on p\/m1\.$/);
  assert.equal(
    await callTool(ctx, { level: "max" }),
    "Not changed: switch limit reached for this turn (1).",
  );
});

test("switch limit: counts only successful switches", async (t) => {
  const ctx = createFakeCtx({ options: { maxSwitchesPerTurn: 1 }, sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  ctx.session.switchModel = async () => {
    throw new Error("boom");
  };
  assert.match(await callTool(ctx, { level: "high" }), /^Failed to set reasoning effort/);
  assert.match(await callTool(ctx, { level: "high" }), /^Failed to set reasoning effort/);
});

test("ordering: guidance is low -> high with thinking ranked like high and unknown names last", async (t) => {
  const ctx = createFakeCtx({ catalog: CATALOG_M4, sessions: { s4: session("low") } });
  await start(t, ctx);
  const system = await runContext(ctx, "s4", { ...M4, variant: "low" });
  assert.match(system[0].text, /\(ordered from lowest to highest effort\): low, thinking, max, weird\./);
});

test("ordering with maxLevel: thinking stays under high, unknown names are dropped", async (t) => {
  const ctx = createFakeCtx({ options: { maxLevel: "high" }, catalog: CATALOG_M4, sessions: { s4: session("low") } });
  await start(t, ctx);
  const system = await runContext(ctx, "s4", { ...M4, variant: "low" });
  assert.match(system[0].text, /: low, thinking\./);
});

test("debugFile: the trace is written to the configured path", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oat-debug-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "trace.log");
  const ctx = createFakeCtx({ options: { debug: true, debugFile: file }, sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  assert.match(fs.readFileSync(file, "utf8"), /^\S+ context \{/m);
});

test("debugFile default: OPENCODE_LOG_DIR, else XDG_DATA_HOME/opencode/log", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oat-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = { OPENCODE_LOG_DIR: process.env.OPENCODE_LOG_DIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // The default path is resolved during setup, so the environment only needs to be set for that call.
  async function setupWith(env) {
    Object.assign(process.env, env);
    const ctx = createFakeCtx({ options: { debug: true }, sessions: { s1: session("low") } });
    try {
      return { ctx, dispose: await plugin.setup(ctx) };
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  const direct = path.join(root, "direct");
  delete process.env.XDG_DATA_HOME;
  const first = await setupWith({ OPENCODE_LOG_DIR: direct });
  t.after(() => first.dispose());
  await runContext(first.ctx, "s1", M1("low"));
  assert.match(fs.readFileSync(path.join(direct, "opencode-adaptive-thinking.log"), "utf8"), /context/);

  const xdg = path.join(root, "xdg");
  const second = await setupWith({ OPENCODE_LOG_DIR: "", XDG_DATA_HOME: xdg });
  t.after(() => second.dispose());
  await runContext(second.ctx, "s1", M1("low"));
  assert.match(
    fs.readFileSync(path.join(xdg, "opencode", "log", "opencode-adaptive-thinking.log"), "utf8"),
    /context/,
  );
});
