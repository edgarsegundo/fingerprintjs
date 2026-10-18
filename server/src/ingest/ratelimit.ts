/**
 * A token bucket per key: each key may make `limit` requests per window, with bursts up to `limit`.
 * It lives in the memory of one process. With several processes each one has its own count, so the real limit
 * is the limit times the number of processes; a shared store is needed for an exact limit.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>()
  private lastPruneAt = 0

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  /** Returns `0` if the request is allowed, otherwise the seconds to wait */
  take(key: string): number {
    const now = this.now()
    this.prune(now)
    const bucket = this.buckets.get(key) ?? { tokens: this.limit, updatedAt: now }
    const refill = ((now - bucket.updatedAt) / this.windowMs) * this.limit
    bucket.tokens = Math.min(this.limit, bucket.tokens + refill)
    bucket.updatedAt = now

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      this.buckets.set(key, bucket)
      return 0
    }
    this.buckets.set(key, bucket)
    return Math.ceil(((1 - bucket.tokens) / this.limit) * (this.windowMs / 1000))
  }

  /** Forgets keys that are full again (nothing to remember), and everything if there are too many keys */
  private prune(now: number): void {
    if (this.buckets.size < this.maxKeys && now - this.lastPruneAt < this.windowMs) {
      return
    }
    this.lastPruneAt = now
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.windowMs) {
        this.buckets.delete(key)
      }
    }
    if (this.buckets.size >= this.maxKeys) {
      this.buckets.clear()
    }
  }
}
