// Test double for the OpenCode v2 plugin ctx. Storage, sessions and the catalog are plain objects so tests
// can share them across simulated reloads.

export const CATALOG = [
  {
    providerID: "p",
    id: "m1",
    variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
  },
  { providerID: "p", id: "m2", variants: [{ id: "none" }, { id: "thinking" }] },
  { providerID: "p", id: "m3", variants: [] },
];

// A pushable async iterable that behaves like ctx.event.subscribe() output.
export function eventStream() {
  const queue = [];
  const waiters = [];
  let closed = false;
  const stream = {
    push(value) {
      if (waiters.length) waiters.shift()({ value, done: false });
      else queue.push(value);
    },
    fail(error) {
      closed = true;
      while (waiters.length) waiters.shift()(Promise.reject(error));
    },
    end() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return() {
          stream.end();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return stream;
}

export function createFakeCtx({
  options = {},
  storage = new Map(),
  sessions = {},
  catalog = CATALOG,
  switchError,
} = {}) {
  const hooks = {};
  const tools = [];
  const switches = [];
  const streams = [];

  const storageApi = {
    async get(key) {
      return storage.has(key) ? structuredClone(storage.get(key)) : undefined;
    },
    async set(key, value) {
      storage.set(key, structuredClone(value));
    },
    async remove(key) {
      storage.delete(key);
    },
    // Key-ordered pages, cursor = last key of the previous page (page.next).
    async scan({ prefix, after, limit = 200 }) {
      const keys = [...storage.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after === undefined ? 0 : keys.findIndex((k) => k > after);
      const slice = start < 0 ? [] : keys.slice(start, start + limit);
      const more = start >= 0 && start + limit < keys.length;
      return {
        entries: slice.map((key) => ({ key, value: structuredClone(storage.get(key)) })),
        next: more ? slice[slice.length - 1] : undefined,
      };
    },
  };

  const ctx = {
    options,
    storage: storageApi,
    hooks,
    tools,
    switches,
    sessions,
    storageMap: storage,
    get stream() {
      return streams[streams.length - 1];
    },
    streams,
    session: {
      async hook(name, handler) {
        hooks[name] = handler;
        return { dispose() {} };
      },
      async get({ sessionID }) {
        const session = sessions[sessionID];
        return session ? { data: structuredClone(session) } : undefined;
      },
      async switchModel({ sessionID, model }) {
        switches.push({ sessionID, model });
        if (switchError) throw new Error(switchError);
        const session = sessions[sessionID];
        if (!session) throw new Error("no session");
        session.model = { providerID: model.providerID, id: model.id, variant: model.variant };
      },
    },
    model: {
      async list() {
        return { data: catalog };
      },
    },
    tool: {
      async transform(fn) {
        fn({
          add(def) {
            tools.push(def);
          },
        });
        return { dispose() {} };
      },
    },
    event: {
      subscribe() {
        const stream = eventStream();
        streams.push(stream);
        return stream;
      },
    },
  };
  return ctx;
}

export const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls the registered tool; returns the output string.
export async function callTool(ctx, args, sessionID = "s1", agent) {
  const def = ctx.tools.find((t) => t.name === "set_reasoning_effort");
  const result = await def.execute(args, { sessionID, agent });
  return result.output;
}

export async function runContext(ctx, sessionID, model, system = [], agent) {
  await ctx.hooks.context({ sessionID, model, system, agent });
  return system;
}
