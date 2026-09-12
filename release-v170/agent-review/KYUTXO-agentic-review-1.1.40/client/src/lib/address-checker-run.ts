// Shared helpers for the Address Checker's concurrent lookup run:
//  - runWithConcurrency: bounded worker pool with prompt cancellation and
//    per-item failure isolation (one bad item never stalls or aborts the rest);
//  - chunk: split a list into fixed-size batches (Electrum batch history);
//  - createPatchBuffer: accumulate per-row patches and flush them to React
//    state on a short interval, so a 5,000-row table re-renders a handful of
//    times per second instead of twice per address.

export interface RunWithConcurrencyOptions {
  /** Maximum number of workers in flight at once. */
  concurrency: number;
  /** Checked before each item is started; when true, no new items begin. */
  isCancelled?: () => boolean;
}

export interface ItemFailure<T> {
  item: T;
  index: number;
  error: unknown;
}

/**
 * Run `worker` over every item with at most `concurrency` in flight.
 * A worker that throws only fails its own item (recorded in the returned
 * failures list) and immediately frees its pool slot. Cancellation stops new
 * items from starting; items already in flight are awaited so callers can
 * safely finalize state afterwards.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  options: RunWithConcurrencyOptions,
): Promise<{ failures: ItemFailure<T>[] }> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const isCancelled = options.isCancelled ?? (() => false);
  const failures: ItemFailure<T>[] = [];
  let next = 0;

  async function runSlot(): Promise<void> {
    while (true) {
      if (isCancelled()) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        failures.push({ item: items[index], index, error });
      }
    }
  }

  const slots: Promise<void>[] = [];
  for (let s = 0; s < Math.min(concurrency, items.length); s++) {
    slots.push(runSlot());
  }
  await Promise.all(slots);
  return { failures };
}

/** Split `items` into consecutive batches of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const batchSize = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize) as T[]);
  }
  return out;
}

export interface PatchBuffer<T> {
  /** Queue a patch for the row at `index`; merged over any queued patch. */
  add(index: number, patch: Partial<T>): void;
  /** Flush any queued patches immediately (also called by the timer). */
  flushNow(): void;
  /** Stop the timer and flush whatever is still queued. */
  stop(): void;
}

/**
 * Accumulates row patches and delivers them in batches via `apply` at most
 * once per `intervalMs`. `apply` receives a Map of row index → merged patch.
 */
export function createPatchBuffer<T>(
  apply: (patches: Map<number, Partial<T>>) => void,
  intervalMs = 250,
): PatchBuffer<T> {
  let pending = new Map<number, Partial<T>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const flushNow = () => {
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    apply(batch);
  };

  return {
    add(index, patch) {
      const existing = pending.get(index);
      pending.set(index, existing ? { ...existing, ...patch } : { ...patch });
      if (timer === null) {
        timer = setInterval(flushNow, intervalMs);
      }
    },
    flushNow,
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      flushNow();
    },
  };
}
