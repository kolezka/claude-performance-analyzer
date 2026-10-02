// A small memo cache with both a size cap and a TTL, so a long-running process
// does not grow its memo table forever (one entry per session seen, say).
export class BoundedCache<V> {
  private map = new Map<string, { value: V; at: number }>();

  constructor(
    private maxSize: number,
    private ttlMs: number,
  ) {}

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()) {
    this.map.delete(key); // re-insert so it moves to the back (most recently set)
    this.map.set(key, { value, at: now });
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }
}
