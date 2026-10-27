export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor?: number;
}

/** "Full jitter" exponential backoff: uniform in [0, min(max, base * factor^attempt)]. Spreads out retry storms. */
export function backoffDelay(attempt: number, { baseMs, maxMs, factor = 2 }: BackoffOptions, rand = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attempt)));
  return Math.floor(rand() * ceiling);
}

export interface RetryOptions extends BackoffOptions {
  retries: number;
  shouldRetry?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || (opts.shouldRetry && !opts.shouldRetry(err))) throw err;
      const delay = backoffDelay(attempt, opts);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
