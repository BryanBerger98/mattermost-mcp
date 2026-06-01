// Transport resilience layered around Client4 calls: a per-request timeout
// (injected as an AbortSignal so the underlying fetch is actually aborted) and
// retry-with-backoff on transient failures (429 / 5xx / network). All HTTP still
// flows through Client4 — we only augment its fetch options and wrap its calls.
import type { Client4 } from "@mattermost/client";
import mattermost from "@mattermost/client";
import { log } from "../log.js";

export interface ResilienceConfig {
  /** Per-request timeout in ms; 0 disables. */
  timeoutMs: number;
  /** Additional attempts after the first (so 3 = up to 4 calls). */
  maxRetries: number;
  /** Exponential-backoff base delay in ms. */
  baseDelayMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
  timeoutMs: 30_000,
  maxRetries: 3,
  baseDelayMs: 500,
};

/**
 * A status is transient (worth retrying) when it is a rate-limit, a server
 * error, or unknown/zero (network failure or aborted request). A `401` is NOT
 * retryable here — auth recovery is handled separately, before the retry wrap.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status == null || status === 0) return true; // network / aborted
  return status === 429 || (status >= 500 && status <= 599);
}

/** Classify any thrown value: Mattermost ClientError by status, else transport faults. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof mattermost.ClientError) return isRetryableStatus(err.status_code);
  // Bare transport failures that never became a ClientError.
  if (err instanceof TypeError) return true; // fetch network error
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true; // request timed out (AbortSignal.timeout)
  }
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof mattermost.ClientError) return `status ${err.status_code ?? 0}`;
  if (err instanceof Error) return err.name || err.message;
  return String(err);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * `sleep` and `rand` are injectable so tests run instantly and deterministically.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: ResilienceConfig,
  sleep: (ms: number) => Promise<void> = realSleep,
  rand: () => number = Math.random,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= cfg.maxRetries || !isRetryableError(err)) throw err;
      const backoff = cfg.baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(rand() * cfg.baseDelayMs);
      const delay = backoff + jitter;
      attempt += 1;
      log(
        `transient failure (${describeError(err)}); retry ${attempt}/${cfg.maxRetries} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Make every Client4 request carry an AbortSignal timeout, unless the caller
 * already set one. We wrap `getOptions` (whose result Client4 passes straight to
 * fetch) rather than touching global fetch — the HTTP stays Client4's.
 */
export function applyRequestTimeout(client: Client4, timeoutMs: number): void {
  if (timeoutMs <= 0) return;
  const original = client.getOptions.bind(client);
  client.getOptions = ((options: Parameters<Client4["getOptions"]>[0]) => {
    const opts = original(options);
    if (!opts.signal) {
      (opts as { signal?: AbortSignal }).signal = AbortSignal.timeout(timeoutMs);
    }
    return opts;
  }) as Client4["getOptions"];
}
