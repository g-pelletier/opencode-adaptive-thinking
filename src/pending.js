// Durable record of temporary reasoning-effort changes that must be reverted when a turn ends.
// Storage key: pending/<sessionID>. Storage is the source of truth; in-memory state is only a cache.
//
// Entry: { model: {providerID, id}, resetVariant, appliedVariant, at }
//   resetVariant:   level to restore (null = model default, no catalog check)
//   appliedVariant: level the plugin last set; used to detect manual changes
//   at:             epoch ms of the last write

export const PENDING_PREFIX = "pending/";
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The host reports the model default as undefined, "" or the literal "default".
export const levelOf = (value) => (typeof value === "string" && value.length > 0 && value !== "default" ? value : null);
export const levelName = (level) => level ?? "default";
export const modelRef = (model) => `${model.providerID}/${model.id}`;
export const sameModel = (a, b) => a?.providerID === b?.providerID && a?.id === b?.id;

const isModel = (m) => !!m && typeof m.providerID === "string" && typeof m.id === "string";
const isEntry = (v) =>
  !!v &&
  typeof v === "object" &&
  isModel(v.model) &&
  (v.resetVariant === null || typeof v.resetVariant === "string") &&
  (v.appliedVariant === null || typeof v.appliedVariant === "string") &&
  typeof v.at === "number";

// host is the plugin ctx: { storage, session, model }.
export async function readPending(host, sessionID) {
  const value = await host.storage.get(PENDING_PREFIX + sessionID);
  return isEntry(value) ? value : undefined;
}

export const writePending = (host, sessionID, entry) => host.storage.set(PENDING_PREFIX + sessionID, entry);
export const removePending = (host, sessionID) => host.storage.remove(PENDING_PREFIX + sessionID);

// Live level list for a model. Throws if the catalog cannot be read.
export async function catalogVariants(host, model) {
  const list = await host.model.list();
  const catalog = Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : [];
  const found = catalog.find((m) => sameModel(m, model));
  return Array.isArray(found?.variants) ? found.variants.map((v) => v.id).filter(Boolean) : [];
}

// level null means "model default": the variant key is omitted.
export function switchTo(host, sessionID, model, level) {
  return host.session.switchModel({
    sessionID,
    model: { providerID: model.providerID, id: model.id, ...(level ? { variant: level } : {}) },
  });
}

// { status: "ok", model, time } | { status: "missing" } | { status: "error", error }
export async function readSession(host, sessionID) {
  let info;
  try {
    info = await host.session.get({ sessionID });
  } catch (error) {
    return { status: "error", error };
  }
  const session = info?.data ?? info;
  if (!session) return { status: "missing" };
  return { status: "ok", model: session.model ?? {}, time: session.time ?? {} };
}

// Idle means a completed idle timestamp exists and no busy timestamp is newer than it.
export function isIdle(time) {
  const idle = time?.idle;
  const busy = time?.busy;
  if (typeof idle !== "number") return false;
  return !(typeof busy === "number" && busy > idle);
}

// Checks an entry against the live session and reverts it when still valid.
// Returns one of: expired | missing | busy | skipped | changed | invalid | failed | reverted.
// Entries are removed for every outcome except busy, skipped and failed.
export async function reconcile(host, sessionID, entry, { startup = false, log = () => {} } = {}) {
  if (startup && Date.now() - entry.at > MAX_AGE_MS) {
    await removePending(host, sessionID);
    return "expired";
  }
  const read = await readSession(host, sessionID);
  if (read.status === "error") return "skipped";
  if (read.status === "missing") {
    await removePending(host, sessionID);
    return "missing";
  }
  if (startup && !isIdle(read.time)) return "busy";
  if (!sameModel(read.model, entry.model) || levelOf(read.model.variant) !== entry.appliedVariant) {
    await removePending(host, sessionID);
    return "changed";
  }
  if (entry.resetVariant !== null) {
    let variants;
    try {
      variants = await catalogVariants(host, entry.model);
    } catch {
      return "skipped";
    }
    if (!variants.includes(entry.resetVariant)) {
      await removePending(host, sessionID);
      return "invalid";
    }
  }
  try {
    await switchTo(host, sessionID, entry.model, entry.resetVariant);
  } catch (error) {
    log("revert failed", { sessionID, message: error?.message ?? String(error) });
    return "failed";
  }
  await removePending(host, sessionID);
  return "reverted";
}

// Startup pass over every pending entry. `lock(sessionID, task)` lets the caller serialize per session.
export async function scanPending(host, { log = () => {}, lock = (_, task) => task() } = {}) {
  let after;
  do {
    const page = await host.storage.scan({ prefix: PENDING_PREFIX, after, limit: 100 });
    const entries = page.entries ?? [];
    for (const { key } of entries) {
      const sessionID = key.startsWith(PENDING_PREFIX) ? key.slice(PENDING_PREFIX.length) : key;
      await lock(sessionID, async () => {
        const entry = await readPending(host, sessionID);
        if (!entry) {
          await removePending(host, sessionID);
          return;
        }
        const outcome = await reconcile(host, sessionID, entry, { startup: true, log });
        log("startup scan", { sessionID, outcome });
      });
    }
    after = entries.length > 0 ? page.next ?? undefined : undefined;
  } while (after !== undefined && after !== null);
}
