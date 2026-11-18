// Configured limits on which reasoning-effort levels a session may use, and the ordering used to present them.
// Pure functions only: no host calls, no storage.

// Ordering low -> high. "thinking" is not a rank of its own: it ranks like "high".
export const RANK_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const ALIASES = { thinking: "high" };

// Rank of a level name, or undefined when the name is not in the table.
export function rankOf(name) {
  const index = RANK_ORDER.indexOf(ALIASES[name] ?? name);
  return index < 0 ? undefined : index;
}

// Known levels sorted by rank (ties keep catalog order); unknown levels follow in catalog order.
export function orderLevels(levels) {
  return levels
    .map((name, index) => ({ name, index, rank: rankOf(name) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank || a.index - b.index;
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.index - b.index;
    })
    .map((item) => item.name);
}

// Agent name from a host value; empty or non-string values are ignored.
export const agentOf = (value) => (typeof value === "string" && value.length > 0 ? value : undefined);

const levelList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.length > 0) : undefined);
const levelName = (value) => (typeof value === "string" && value.length > 0 ? value : undefined);

// Limits for one agent. A key set on config.agents[agent] overrides the top-level key; `enabled: false` disables the agent.
export function limitsFor(config, agent) {
  const override =
    agent !== undefined && config.agents && Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;
  const pick = (key) => (override && Object.hasOwn(override, key) ? override[key] : config[key]);
  return {
    enabled: override?.enabled !== false,
    allowedLevels: levelList(pick("allowedLevels")),
    maxLevel: levelName(pick("maxLevel")),
  };
}

// Levels the agent may use on a model whose catalog lists `catalog`, ordered low -> high.
// - allowedLevels (when set) keeps only the listed names.
// - maxLevel keeps levels ranked at or below it. A level equal to maxLevel is kept. When a name has no rank,
//   it is kept only if allowedLevels names it.
export function effectiveLevels(catalog, limits) {
  if (!limits.enabled) return [];
  const { allowedLevels, maxLevel } = limits;
  const maxRank = maxLevel === undefined ? undefined : rankOf(maxLevel);
  const kept = catalog.filter((level) => {
    if (allowedLevels && !allowedLevels.includes(level)) return false;
    if (maxLevel === undefined || level === maxLevel) return true;
    const rank = rankOf(level);
    if (rank !== undefined && maxRank !== undefined) return rank <= maxRank;
    return allowedLevels?.includes(level) === true;
  });
  return orderLevels(kept);
}
