// Request mode (applyMode: "request"): the chosen level is applied to the provider request options of each
// context event instead of switching the session's model variant. Nothing is recorded as a revert, so no
// switchModel call and no transcript entry is made.
// Storage key: request/<sessionID>. Storage is the source of truth.
//
// Entry: { model: {providerID, id}, resetVariant, level, persist, at }
//   resetVariant: the host's own variant when the override was made (null = model default)
//   level:        the level to apply
//   persist:      false = cleared at end of turn; true = kept for the session

export const REQUEST_PREFIX = "request/";

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isEntry = (v) =>
  isRecord(v) &&
  isRecord(v.model) &&
  typeof v.model.providerID === "string" &&
  typeof v.model.id === "string" &&
  (v.resetVariant === null || typeof v.resetVariant === "string") &&
  typeof v.level === "string" &&
  typeof v.persist === "boolean" &&
  typeof v.at === "number";

export async function readRequest(host, sessionID) {
  const value = await host.storage.get(REQUEST_PREFIX + sessionID);
  return isEntry(value) ? value : undefined;
}
export const writeRequest = (host, sessionID, entry) => host.storage.set(REQUEST_PREFIX + sessionID, entry);
export const removeRequest = (host, sessionID) => host.storage.remove(REQUEST_PREFIX + sessionID);

// Options without the keys that `settings` sets (nested objects are trimmed the same way).
export function withoutVariantSettings(options, settings) {
  const entries = [];
  for (const [key, value] of Object.entries(options)) {
    const selected = Object.hasOwn(settings, key) ? settings[key] : undefined;
    if (selected === undefined) {
      entries.push([key, value]);
    } else if (isRecord(value) && isRecord(selected)) {
      const remaining = withoutVariantSettings(value, selected);
      if (Object.keys(remaining).length > 0) entries.push([key, remaining]);
    }
  }
  return Object.fromEntries(entries);
}

// Replaces the variant keys of `fromSettings` in `options` (mutated in place) with `toSettings`.
export function applyVariantOverride(options, fromSettings, toSettings) {
  const kept = fromSettings ? withoutVariantSettings(options, fromSettings) : { ...options };
  for (const key of Object.keys(options)) delete options[key];
  Object.assign(options, kept, structuredClone(toSettings));
}
