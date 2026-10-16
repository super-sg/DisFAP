/**
 * Small bounded-retry helper for best-effort cleanup steps whose failure is
 * recoverable (a transient Vault/DB error) and whose success is not required
 * for the caller to proceed. Deliberately tiny: no jitter, no unbounded loops,
 * exponential backoff capped at `maxDelayMs`.
 */

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** First backoff delay in ms. Default 25. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 500. */
  maxDelayMs?: number;
  /** Observation hook, called after each failed attempt (never with secrets). */
  onAttemptFailed?: (err: unknown, attempt: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn`, retrying on rejection. Resolves with the first success. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 25;
  const max = opts.maxDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      opts.onAttemptFailed?.(err, attempt);
      if (attempt < attempts) await sleep(Math.min(base * 2 ** (attempt - 1), max));
    }
  }
  throw lastError;
}
