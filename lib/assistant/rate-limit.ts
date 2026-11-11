/**
 * A small in-memory sliding-window limiter for the public assistant endpoint, so one visitor
 * can't run up the AI bill. Per server process (the demo runs one instance). Pure apart from
 * the injected clock.
 */
export function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number }) {
  const { limit, windowMs, now = Date.now } = options;
  const hits = new Map<string, number[]>();

  return {
    /** True if this call is allowed (and counts it); false when the key is over the limit. */
    take(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5_000) {
        for (const [k, v] of hits) if (v.every((at) => t - at >= windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}
