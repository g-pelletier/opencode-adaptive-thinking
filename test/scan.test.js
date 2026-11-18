import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { createFakeCtx, tick } from "./fake-ctx.js";

const DAY = 24 * 60 * 60 * 1000;
const model = { providerID: "p", id: "m1" };
const entry = (appliedVariant, resetVariant = "low", at = Date.now()) => ({
  model,
  resetVariant,
  appliedVariant,
  at,
});
const idle = { idle: 2, busy: 1 };
const busy = { idle: 1, busy: 5 };

async function startWith(t, ctx) {
  const dispose = await plugin.setup(ctx);
  t.after(() => dispose());
}

test("startup scan reverts idle sessions and leaves busy ones", async (t) => {
  const storage = new Map([
    ["pending/idle", entry("high")],
    ["pending/busy", entry("high")],
    ["pending/no-idle", entry("high")],
    ["pending/missing", entry("high")],
    ["pending/expired", entry("high", "low", Date.now() - 8 * DAY)],
    ["pending/changed", entry("high")],
    ["pending/default", entry("high", null)],
  ]);
  const ctx = createFakeCtx({
    storage,
    sessions: {
      idle: { model: { ...model, variant: "high" }, time: idle },
      busy: { model: { ...model, variant: "high" }, time: busy },
      "no-idle": { model: { ...model, variant: "high" }, time: { busy: 3 } },
      expired: { model: { ...model, variant: "high" }, time: idle },
      changed: { model: { ...model, variant: "max" }, time: idle },
      default: { model: { ...model, variant: "high" }, time: idle },
    },
  });
  await startWith(t, ctx);
  await tick(30);

  assert.equal(ctx.sessions.idle.model.variant, "low");
  assert.equal(ctx.sessions.busy.model.variant, "high");
  assert.equal(ctx.sessions["no-idle"].model.variant, "high");
  assert.equal(ctx.sessions.expired.model.variant, "high");
  assert.equal(ctx.sessions.changed.model.variant, "max");
  assert.equal(ctx.sessions.default.model.variant, undefined);

  assert.equal(storage.has("pending/idle"), false);
  assert.equal(storage.has("pending/busy"), true);
  assert.equal(storage.has("pending/no-idle"), true);
  assert.equal(storage.has("pending/missing"), false);
  assert.equal(storage.has("pending/expired"), false);
  assert.equal(storage.has("pending/changed"), false);
  assert.equal(storage.has("pending/default"), false);
  assert.deepEqual(
    ctx.switches.map((s) => s.sessionID).sort(),
    ["default", "idle"],
    "only idle, valid entries are switched",
  );
});

test("startup scan pages through more entries than one page", async (t) => {
  const storage = new Map();
  for (let i = 0; i < 230; i++) storage.set(`pending/gone-${String(i).padStart(3, "0")}`, entry("high"));
  const ctx = createFakeCtx({ storage });
  await startWith(t, ctx);
  await tick(30);
  assert.equal([...storage.keys()].filter((k) => k.startsWith("pending/")).length, 0);
});

test("startup scan drops malformed entries", async (t) => {
  const storage = new Map([["pending/bad", { nope: true }]]);
  const ctx = createFakeCtx({ storage });
  await startWith(t, ctx);
  await tick(30);
  assert.equal(storage.has("pending/bad"), false);
});
