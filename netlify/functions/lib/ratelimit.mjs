// Best-effort in-memory limiter (per warm function instance). The durable, edge-level
// limit is declared in kp-rsvp.mjs `config.rateLimit`; this is a second layer.
const hits = new Map();

export function rateLimited(key, { limit = 5, windowMs = 10 * 60 * 1000 } = {}, now = Date.now()) {
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return recent.length > limit;
}

export function _reset() {
  hits.clear();
}
