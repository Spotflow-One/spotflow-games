/** Token bucket per key. `perSecond` tokens refill each second, up to `burst`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private now: () => number = Date.now) {}

  take(key: string, perSecond: number, burst = perSecond * 2): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSecond);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  clear(prefix: string) {
    for (const k of this.buckets.keys()) if (k.startsWith(prefix)) this.buckets.delete(k);
  }
}
