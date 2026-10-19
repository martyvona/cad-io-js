// The stores' bookkeeping: each entry's size, least recently used first, and the total.

export class Lru {
  /** Insertion order is recency: the first key is the least recently used. */
  private sizes = new Map<string, number>();
  total = 0;
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  has(key: string): boolean {
    return this.sizes.has(key);
  }

  /** The keys, least recently used first. */
  keys(): string[] {
    return [...this.sizes.keys()];
  }

  /** Marks `key` as just used. */
  touch(key: string): void {
    const n = this.sizes.get(key);
    if (n === undefined) return;
    this.sizes.delete(key);
    this.sizes.set(key, n);
  }

  /**
   * Records `key` as just stored with `size` bytes, and returns the keys to evict to stay within `maxBytes`, least
   * recently used first: just `key` if `size` alone exceeds it (as when `maxBytes` was lowered between runs).
   */
  add(key: string, size: number): string[] {
    this.remove(key);
    if (size > this.maxBytes) return [key];
    this.sizes.set(key, size);
    this.total += size;
    const evict: string[] = [];
    for (const [k, n] of this.sizes) {
      if (this.total <= this.maxBytes) break;
      evict.push(k);
      this.sizes.delete(k);
      this.total -= n;
    }
    return evict;
  }

  remove(key: string): void {
    const n = this.sizes.get(key);
    if (n === undefined) return;
    this.sizes.delete(key);
    this.total -= n;
  }

  clear(): void {
    this.sizes.clear();
    this.total = 0;
  }
}
