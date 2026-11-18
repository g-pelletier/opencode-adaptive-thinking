import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { callTool, createFakeCtx, runContext, tick } from "./fake-ctx.js";

const M1 = (variant) => (variant === undefined ? { providerID: "p", id: "m1" } : { providerID: "p", id: "m1", variant });
const ended = (sessionID, type = "session.execution.succeeded", extra = {}) => ({
  type,
  properties: { sessionID, ...extra },
});

async function start(t, ctx) {
  const dispose = await plugin.setup(ctx);
  t.after(() => dispose());
  return dispose;
}

function session(variant, model = { providerID: "p", id: "m1" }) {
  return { model: { ...model, ...(variant === undefined ? {} : { variant }) }, time: { idle: 2, busy: 1 } };
}

test("temporary change reverts at end of turn and guidance lists the levels", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  const system = await runContext(ctx, "s1", M1("low"));
  assert.match(system[0].text, /Current reasoning effort level: low\./);
  assert.match(system[0].text, /Valid reasoning effort levels for this session \(ordered from lowest to highest effort\): low, high, max\./);

  const out = await callTool(ctx, { level: "high" });
  assert.match(out, /Reasoning effort set to high on p\/m1 \(reverts to low at end of turn\)\./);
  assert.equal(ctx.sessions.s1.model.variant, "high");
  assert.ok(ctx.storageMap.has("pending/s1"));

  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "low");
  assert.equal(ctx.storageMap.has("pending/s1"), false);
});

test("persist keeps the level after end of turn", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  const out = await callTool(ctx, { level: "high", persist: true });
  assert.match(out, /persisted for this session/);
  assert.equal(ctx.storageMap.has("pending/s1"), false);

  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "high");
  assert.equal(ctx.switches.length, 1);
});

test("second temporary call keeps the original target", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  await callTool(ctx, { level: "high" });
  const out = await callTool(ctx, { level: "max" });
  assert.match(out, /reverts to low/);
  assert.equal((await ctx.storage.get("pending/s1")).resetVariant, "low");

  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "low");
});

test("concurrent calls for one session are serialized and keep the original target", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  await Promise.all([callTool(ctx, { level: "high" }), callTool(ctx, { level: "max" })]);
  assert.equal((await ctx.storage.get("pending/s1")).resetVariant, "low");
  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "low");
});

test("reload: a new setup sharing storage still reverts at end of turn", async (t) => {
  const first = createFakeCtx({ sessions: { s1: { ...session("low"), time: { busy: 5 } } } });
  const disposeFirst = await plugin.setup(first);
  await runContext(first, "s1", M1("low"));
  await callTool(first, { level: "high" });
  await disposeFirst();

  const second = createFakeCtx({ storage: first.storageMap, sessions: first.sessions });
  await start(t, second);
  await tick();
  assert.equal(second.sessions.s1.model.variant, "high", "a session with no idle timestamp is left alone at startup");
  ctxEnd(second, "s1");
  await tick();
  assert.equal(second.sessions.s1.model.variant, "low");
});

test("shutdown interrupt is ignored and the entry is kept", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  await callTool(ctx, { level: "high" });
  ctx.stream.push(ended("s1", "session.execution.interrupted", { reason: "shutdown" }));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "high");
  assert.ok(ctx.storageMap.has("pending/s1"));
  assert.equal(ctx.switches.length, 1);
});

test("interrupt with another reason reverts", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  await callTool(ctx, { level: "high" });
  ctx.stream.push(ended("s1", "session.execution.interrupted", { reason: "user" }));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "low");
});

test("no revert after a manual variant change", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  await callTool(ctx, { level: "high" });
  ctx.sessions.s1.model.variant = "max";
  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "max");
  assert.equal(ctx.storageMap.has("pending/s1"), false);
  assert.equal(ctx.switches.length, 1);
});

test("no revert after a model change", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  await callTool(ctx, { level: "high" });
  ctx.sessions.s1.model = { providerID: "p", id: "m2", variant: "high" };
  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.id, "m2");
  assert.equal(ctx.switches.length, 1);
  assert.equal(ctx.storageMap.has("pending/s1"), false);
});

test("default variant (null) reverts to the model default", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session(undefined) } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1(undefined));
  const out = await callTool(ctx, { level: "high" });
  assert.match(out, /reverts to default/);
  assert.equal((await ctx.storage.get("pending/s1")).resetVariant, null);

  ctx.stream.push(ended("s1"));
  await tick();
  const last = ctx.switches.at(-1);
  assert.equal(last.model.variant, undefined);
  assert.equal(ctx.sessions.s1.model.variant, undefined);
});

test('host-reported "default" variant is treated as the model default and reverts', async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("default") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("default"));
  const out = await callTool(ctx, { level: "high" });
  assert.match(out, /reverts to default/);
  assert.equal((await ctx.storage.get("pending/s1")).resetVariant, null);

  ctx.stream.push(ended("s1"));
  await tick();
  assert.equal(ctx.switches.at(-1).model.variant, undefined);
  assert.equal(await ctx.storage.get("pending/s1"), undefined);
});

test("invalid level is rejected with the model's valid list", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  const out = await callTool(ctx, { level: "turbo" });
  assert.equal(out, "Invalid reasoning effort level for p/m1: turbo. Valid levels: low, high, max.");
  assert.equal(ctx.switches.length, 0);
});

test("model without variants answers Not changed", async (t) => {
  const ctx = createFakeCtx({ sessions: { s3: session(undefined, { providerID: "p", id: "m3" }) } });
  await start(t, ctx);
  await runContext(ctx, "s3", { providerID: "p", id: "m3" });
  const out = await callTool(ctx, { level: "high" }, "s3");
  assert.equal(out, "Not changed: p/m3 exposes no reasoning effort levels.");
  assert.equal(ctx.switches.length, 0);
});

test("switchModel failure removes the entry and reports failure", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") }, switchError: "boom" });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  const out = await callTool(ctx, { level: "high" });
  assert.match(out, /^Failed to set reasoning effort to high on p\/m1: boom\. Not changed\./);
  assert.equal(ctx.storageMap.has("pending/s1"), false);
  assert.equal(ctx.sessions.s1.model.variant, "low");
});

test("switchModel failure keeps an earlier pending entry", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  await runContext(ctx, "s1", M1("low"));
  await callTool(ctx, { level: "high" });
  ctx.session.switchModel = async () => {
    throw new Error("boom");
  };
  const out = await callTool(ctx, { level: "max" });
  assert.match(out, /Failed/);
  assert.equal((await ctx.storage.get("pending/s1")).resetVariant, "low");
  assert.equal((await ctx.storage.get("pending/s1")).appliedVariant, "high");
});

test("event stream failure resubscribes with backoff", async (t) => {
  const ctx = createFakeCtx({ sessions: { s1: session("low") } });
  await start(t, ctx);
  assert.equal(ctx.streams.length, 1);
  ctx.streams[0].fail(new Error("stream closed"));
  await tick(700);
  assert.equal(ctx.streams.length, 2);
  await runContext(ctx, "s1", M1("low"));
  await callTool(ctx, { level: "high" });
  ctx.streams[1].push(ended("s1"));
  await tick();
  assert.equal(ctx.sessions.s1.model.variant, "low");
});

function ctxEnd(ctx, sessionID) {
  ctx.stream.push(ended(sessionID));
}
