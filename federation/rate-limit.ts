// Per-partner rate limiting. Spec: api-design.md §Rate Limiting (API-9:
// RATE_LIMITED is 429 with Retry-After).
//
// A token bucket. The bucket holds `capacity` requests and refills at
// `perHour`; a request takes one token or is refused and told how long until
// there is one. With the capacity equal to the hourly rate — the default here —
// a partner's first full sync can spend a whole hour's allowance in one burst,
// which is the "burst allowance for initial synchronisation" the spec asks
// for, and steady polling never notices the limit at all.

export interface RateLimit {
  /** Requests that can be made back to back from a full bucket. */
  capacity: number;
  /** Sustained rate. This is the figure advertised as `limits.rate_per_hour`. */
  perHour: number;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * What the endpoints need from a limiter. The key is the partner's domain —
 * taken from a *verified* request, never from a header alone, or anyone could
 * spend a partner's allowance for it.
 */
export interface RateLimiter {
  take(key: string, limit: RateLimit): Promise<RateDecision>;
}

export interface Bucket {
  tokens: number;
  /** When `tokens` was true, in milliseconds since the epoch. */
  at: number;
}

/**
 * One request against one bucket: the arithmetic, with no storage and no
 * clock of its own. A host that keeps its buckets somewhere shared — a
 * database row, a cache — reproduces exactly this.
 */
export function takeToken(bucket: Bucket | undefined, limit: RateLimit, now: number): { bucket: Bucket; decision: RateDecision } {
  const perMillisecond = limit.perHour / 3_600_000;
  const elapsed = bucket === undefined ? 0 : Math.max(0, now - bucket.at);
  const tokens = bucket === undefined ? limit.capacity : Math.min(limit.capacity, bucket.tokens + elapsed * perMillisecond);

  if (tokens >= 1) return { bucket: { tokens: tokens - 1, at: now }, decision: { allowed: true } };
  // Rounded up, and never zero: "retry after 0 seconds" invites a retry that
  // is refused again.
  const retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / perMillisecond / 1000));
  return { bucket: { tokens, at: now }, decision: { allowed: false, retryAfterSeconds } };
}

/**
 * Buckets held in this process. Exact on a single long-running server. On a
 * host that runs several instances, or starts a fresh one per request, each
 * instance counts alone and the limit is only approximate — keep the buckets
 * in shared storage there.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly clock: { now(): Date } = { now: () => new Date() },
    /** Buckets kept at most. Beyond it, the ones untouched for longest are dropped. */
    private readonly maxKeys = 10_000,
  ) {}

  async take(key: string, limit: RateLimit): Promise<RateDecision> {
    const { bucket, decision } = takeToken(this.buckets.get(key), limit, this.clock.now().getTime());
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.evict();
    return decision;
  }

  private evict() {
    // A key can be anything a caller chooses, so the map must not grow without
    // bound. Dropping a bucket forgives whatever it had spent; dropping the
    // oldest-touched ones forgives the least.
    const excess = this.buckets.size - this.maxKeys;
    let dropped = 0;
    for (const key of this.buckets.keys()) {
      if (dropped++ >= excess) break;
      this.buckets.delete(key);
    }
  }
}
