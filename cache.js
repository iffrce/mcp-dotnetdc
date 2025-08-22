export function createInMemoryCache(ttlMs) {
  async function maybeCached(tool, args, compute) {
    return compute();
  }
  return { maybeCached };
}

export function ensureDir(dir) {
  // no-op: cache removed
  return Promise.resolve();
}


