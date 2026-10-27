import { Redis } from "ioredis";

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  readonly kind: "memory" | "redis";
}

export class MemoryCache implements Cache {
  readonly kind = "memory" as const;
  private readonly store = new Map<string, { value: unknown; expires: number }>();
  constructor(private readonly maxEntries = 10_000) {}

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value as string); // FIFO eviction
    this.store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class RedisCache implements Cache {
  readonly kind = "redis" as const;
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "amrutam:",
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), "EX", ttlSeconds);
  }
  async del(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}

/**
 * Wraps any cache so an outage degrades to "always miss" instead of failing requests: the database is the source of
 * truth and every cached read path is safe to serve uncached. Correctness never depends on the cache.
 */
export class ResilientCache implements Cache {
  constructor(
    private readonly inner: Cache,
    private readonly onError: (op: string, err: unknown) => void = () => {},
  ) {}
  get kind() {
    return this.inner.kind;
  }
  async get<T>(key: string) {
    return this.inner.get<T>(key).catch((e) => (this.onError("get", e), undefined));
  }
  async set(key: string, value: unknown, ttl: number) {
    await this.inner.set(key, value, ttl).catch((e) => this.onError("set", e));
  }
  async del(key: string) {
    await this.inner.del(key).catch((e) => this.onError("del", e));
  }
}

/** Read-through with in-process single-flight, so a cold key under load triggers one DB query, not one per request. */
export class ReadThrough {
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(
    private readonly cache: Cache,
    private readonly onResult: (name: string, hit: boolean) => void = () => {},
  ) {}

  async get<T>(name: string, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.cache.get<T>(key);
    if (cached !== undefined) {
      this.onResult(name, true);
      return cached;
    }
    this.onResult(name, false);
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load()
        .then(async (v) => {
          await this.cache.set(key, v, ttlSeconds);
          return v;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Version-stamped keys: embed version(family) in a key, bump(family) to invalidate the whole family at once. */
  version(family: string): Promise<number> {
    return this.cache.get<number>(`ver:${family}`).then((v) => v ?? 0);
  }
  async bump(family: string): Promise<void> {
    await this.cache.set(`ver:${family}`, Date.now() * 1000 + Math.floor(Math.random() * 1000), 86_400);
  }
}
