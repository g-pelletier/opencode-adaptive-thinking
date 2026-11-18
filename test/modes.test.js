import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { callTool, createFakeCtx, runContext, tick } from "./fake-ctx.js";

const ended = (sessionID) => ({ type: "session.execution.succeeded", properties: { sessionID } });
const M1 = (variant) => (variant === undefined ? { providerID: "p", id: "m1" } : { providerID: "p", id: "m1", variant });

// Catalog with provider settings on the variants (request mode needs them).
const CATALOG_R = [
  {
    providerID: "p",
    id: "r1",
    variants: [
      { id: "low", settings: { effort: "low" } },
      { id: "high", settings: { effort: "high", budget: 8000 } },
      { id: "max", settings: { effort: "max", budget: 16000 } },
      { id: "plain" },
    ],
  },
  { providerID: "p", id: "r2", variants: [{ id: "low" }] },
];

async function start(t, ctx) {
  const dispose = await plugin.setup(ctx);
  t.after(() => dispose());
  return dispose;
}

// A context event as the host sends it: model variant plus provider request options.
const ev = (sessionID, variant, options = {}, model = { providerID: "p", id: "r1" }) => ({
  sessionID,
  model: variant === undefined ? { ...model } : { ...model, variant },
  system: [],
  options,
});

const request = (ctx, sessionID = "s1") => ctx.storageMap.get(`request/${sessionID}`);

// ---- the tool definition ----

test("tool is exposed directly by default (options.codemode false)", async (t) => {
  const ctx = createFakeCtx();
  await start(t, ctx);
  assert.deepEqual(ctx.tools[0].options, { codemode: false });
});

test("tool schema is declared under input (the key the host reads), not parameters", async (t) => {
  const ctx = createFakeCtx();
  await start(t, ctx);
  const def = ctx.tools[0];
  assert.equal(def.parameters, undefined);
  assert.equal(def.input?.type, "object");
  assert.deepEqual(Object.keys(def.input.properties).sort(), ["level", "persist"]);
  assert.deepEqual(def.input.required, ["level"]);
});

test("codemode: true keeps the tool reachable only through Code Mode", async (t) => {
  const ctx = createFakeCtx({ options: { codemode: true } });
  await start(t, ctx);
  assert.deepEqual(ctx.tools[0].options, { codemode: true });
});

// ---- request mode ----

test("request mode: the level is applied to request options, no switch, no transcript entry", async (t) => {
  const ctx = createFakeCtx({ options: { applyMode: "request" }, catalog: CATALOG_R });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "low", { effort: "low", temperature: 0.2 }));

  const out = await callTool(ctx, { level: "high" });
  assert.equal(out, "Reasoning effort set to high on p/r1 (reverts to low at end of turn).");
  assert.equal(ctx.switches.length, 0);
  assert.equal(request(ctx).level, "high");

  const next = ev("s1", "low", { effort: "low", temperature: 0.2 });
  await ctx.hooks.context(next);
  assert.equal(next.options.effort, "high");
  assert.equal(next.options.budget, 8000);
  assert.equal(next.options.temperature, 0.2, "unrelated options are kept");
  assert.match(next.system[0]?.text ?? "", /Current reasoning effort level: high\./);
});

test("request mode: keys of the host's current variant are removed before the new settings apply", async (t) => {
  const ctx = createFakeCtx({ options: { applyMode: "request" }, catalog: CATALOG_R });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "high", { effort: "high", budget: 8000, temperature: 0.5 }));
  assert.match(await callTool(ctx, { level: "low" }), /^Reasoning effort set to low/);

  const next = ev("s1", "high", { effort: "high", budget: 8000, temperature: 0.5 });
  await ctx.hooks.context(next);
  assert.deepEqual(next.options, { effort: "low", temperature: 0.5 });
});

test("request mode: a temporary override is cleared at end of turn", async (t) => {
  const ctx = createFakeCtx({ options: { applyMode: "request" }, catalog: CATALOG_R });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "low", { effort: "low" }));
  await callTool(ctx, { level: "high" });

  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(request(ctx), undefined);

  const after = ev("s1", "low", { effort: "low" });
  await ctx.hooks.context(after);
  assert.equal(after.options.effort, "low");
  assert.match(after.system[0]?.text ?? "", /Current reasoning effort level: low\./);
});

test("request mode: persist keeps the override past end of turn", async (t) => {
  const ctx = createFakeCtx({ options: { applyMode: "request" }, catalog: CATALOG_R });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "low", { effort: "low" }));
  const out = await callTool(ctx, { level: "high", persist: true });
  assert.match(out, /persisted for this session/);

  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(request(ctx).level, "high");
  const after = ev("s1", "low", { effort: "low" });
  await ctx.hooks.context(after);
  assert.equal(after.options.effort, "high");
});

test("request mode: a model change drops the override", async (t) => {
  const ctx = createFakeCtx({ options: { applyMode: "request" }, catalog: CATALOG_R });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "low", { effort: "low" }));
  await callTool(ctx, { level: "high", persist: true });

  const other = ev("s1", "low", { effort: "low" }, { providerID: "p", id: "r2" });
  await ctx.hooks.context(other);
  assert.equal(request(ctx), undefined);
  assert.equal(other.options.effort, "low");
});

test("request mode: a manual variant change by the user drops the override", async (t) => {
  const ctx = createFakeCtx({ options: { applyMode: "request" }, catalog: CATALOG_R });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "low", { effort: "low" }));
  await callTool(ctx, { level: "high", persist: true });

  const manual = ev("s1", "max", { effort: "max" });
  await ctx.hooks.context(manual);
  assert.equal(request(ctx), undefined);
  assert.equal(manual.options.effort, "max");
});

test("request mode: a level without provider settings is refused", async (t) => {
  const ctx = createFakeCtx({ options: { applyMode: "request" }, catalog: CATALOG_R });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "low", { effort: "low" }));
  assert.equal(
    await callTool(ctx, { level: "plain" }),
    "Not changed: plain on p/r1 has no provider settings to apply in request mode.",
  );
  assert.equal(request(ctx), undefined);
});

test("request mode: limits and the switch limit apply the same way", async (t) => {
  const ctx = createFakeCtx({
    options: { applyMode: "request", maxLevel: "high", maxSwitchesPerTurn: 1 },
    catalog: CATALOG_R,
  });
  await start(t, ctx);
  await ctx.hooks.context(ev("s1", "low", { effort: "low" }));
  assert.match(await callTool(ctx, { level: "max" }), /^Not changed: max exists on p\/r1 but is blocked/);
  assert.match(await callTool(ctx, { level: "high" }), /^Reasoning effort set to high/);
  assert.equal(
    await callTool(ctx, { level: "low" }),
    "Reasoning effort set to low on p/r1.",
    "going back to the host's variant is not counted",
  );
  assert.equal(
    await callTool(ctx, { level: "high" }),
    "Not changed: switch limit reached for this turn (1).",
  );
});
