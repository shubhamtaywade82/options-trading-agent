import type { Redis } from 'ioredis';

/**
 * Spaces calls so consecutive acquisitions under one key are at least `windowMs` apart. Used for
 * account-wide limits, which one process cannot enforce alone when two processes share an account.
 */
export interface RateGate {
  acquire(key: string, windowMs: number): Promise<void>;
}

export interface MemoryRateGateOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class MemoryRateGate implements RateGate {
  private readonly last = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: MemoryRateGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async acquire(key: string, windowMs: number): Promise<void> {
    const previous = this.last.get(key);
    if (previous !== undefined) {
      const wait = previous + windowMs - this.now();
      if (wait > 0) {
        await this.sleep(wait);
      }
    }
    this.last.set(key, this.now());
  }
}

export interface RedisRateGateOptions {
  readonly prefix: string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Attempts before giving up. Each attempt waits for the current window to close. */
  readonly maxAttempts?: number;
}

/**
 * A slot is claimed with SET NX PX, so exactly one caller wins each window across every process.
 * A caller that loses waits for the remaining TTL of the winning slot, then tries again.
 */
export class RedisRateGate implements RateGate {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisRateGateOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 50;
  }

  async acquire(key: string, windowMs: number): Promise<void> {
    const slot = `${this.options.prefix}${key}`;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const claimed = await this.redis.set(slot, '1', 'PX', windowMs, 'NX');
      if (claimed === 'OK') {
        return;
      }
      const remaining = await this.redis.pttl(slot);
      await this.sleep(remaining > 0 ? remaining : 1);
    }
    throw new Error(`rate gate ${key} did not open after ${this.maxAttempts} attempts`);
  }
}
