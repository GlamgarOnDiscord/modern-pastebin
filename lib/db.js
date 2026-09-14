// Real Vercel KV / Upstash Redis when configured, otherwise an in-memory hash
// store with TTL for local development.

function createMemoryKv() {
  const store = new Map(); // key -> { fields: Map, expiresAt: number|null }

  function live(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  function fieldsObject(entry) {
    const out = {};
    for (const [k, v] of entry.fields) out[k] = v;
    return out;
  }

  return {
    async hset(key, fields) {
      let entry = live(key);
      if (!entry) {
        entry = { fields: new Map(), expiresAt: null };
        store.set(key, entry);
      }
      for (const [k, v] of Object.entries(fields)) entry.fields.set(k, v);
      return Object.keys(fields).length;
    },
    async hget(key, field) {
      const entry = live(key);
      if (!entry || !entry.fields.has(field)) return null;
      return entry.fields.get(field);
    },
    async hgetall(key) {
      const entry = live(key);
      if (!entry || entry.fields.size === 0) return null;
      return fieldsObject(entry);
    },
    async hdel(key, ...fields) {
      const entry = live(key);
      if (!entry) return 0;
      let n = 0;
      for (const f of fields) if (entry.fields.delete(f)) n++;
      if (entry.fields.size === 0) store.delete(key);
      return n;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async exists(key) {
      return live(key) ? 1 : 0;
    },
    async expire(key, seconds) {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async ttl(key) {
      const entry = live(key);
      if (!entry) return -2;
      if (!entry.expiresAt) return -1;
      return Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    },
  };
}

export const isLocalKv = !process.env.KV_REST_API_URL;

export const kv = isLocalKv ? createMemoryKv() : (await import("@vercel/kv")).kv;
