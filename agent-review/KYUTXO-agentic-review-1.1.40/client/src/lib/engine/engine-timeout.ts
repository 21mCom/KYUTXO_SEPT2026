/**
 * Bounded timeout for native read-engine IPC probes (Task #308).
 *
 * The engine worker is single-threaded. While it runs a long SYNCHRONOUS job —
 * notably the seed `finalize` step (build indexes → materialize UTXOs →
 * integrity_check) — it cannot answer `status`/`schemaVersion`/fingerprint IPC.
 * Any renderer code that AWAITS such a probe without a bound would stall until
 * that job finished (the freeze this module exists to prevent).
 *
 * Both the read gate (engine-freshness.ts) and the readiness poll
 * (engine-client.ts) wrap their probes with this helper so they degrade to Dexie
 * within a bounded time instead of hanging. A timeout REJECTS so the caller's
 * existing catch/fallback handles it; it NEVER cancels or tears down the
 * in-progress worker job — the rebuild keeps running, we just stop waiting on it.
 */

/** Upper bound (ms) for any single engine IPC probe. */
export const ENGINE_PROBE_TIMEOUT_MS = 2000;

/** Marker error so callers can report a probe timeout distinctly from a read error. */
export class EngineProbeTimeoutError extends Error {
  constructor() {
    super('engine probe timed out');
    this.name = 'EngineProbeTimeoutError';
  }
}

/**
 * Race an engine IPC probe against a bounded timer. Resolves with the probe's
 * value if it settles first; otherwise rejects with {@link EngineProbeTimeoutError}.
 */
export function withEngineTimeout<T>(
  p: Promise<T>,
  ms: number = ENGINE_PROBE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineProbeTimeoutError()), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
