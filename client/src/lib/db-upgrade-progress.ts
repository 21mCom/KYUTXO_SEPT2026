/**
 * One-time Dexie schema-upgrade progress reporting.
 *
 * When the app opens a vault created by an older release (e.g. 1.1.24 /
 * schema v25), Dexie runs every intermediate upgrade before the first query
 * resolves. On a large vault the heavy upgrade bodies (v27's 16-table walk,
 * v29/v30's records passes) can take minutes — previously behind a bare
 * "Loading vault..." spinner, which users read as a hang and force-quit,
 * aborting the version-change transaction and restarting the upgrade on the
 * next launch.
 *
 * The upgrade bodies in database.ts call {@link reportDbUpgradeProgress} as
 * they walk rows; the UI subscribes via {@link subscribeDbUpgradeProgress} and
 * shows a visible, moving overlay instead. Reporting is fire-and-forget and
 * throttled here so the upgrade loop never pays for React re-renders.
 *
 * This module is dependency-free on purpose: database.ts must be importable
 * from workers/tests without pulling in React.
 */

export interface DbUpgradeProgress {
  /** Schema version whose upgrade body is running (e.g. 27). */
  version: number;
  /** Human-readable step, e.g. "Updating transactionParticipants". */
  step: string;
  /** Rows walked so far within this step; 0 = just started / indeterminate. */
  rowsProcessed: number;
}

type Listener = (progress: DbUpgradeProgress | null) => void;

let current: DbUpgradeProgress | null = null;
const listeners = new Set<Listener>();
let lastNotifyAt = 0;
let lastNotifiedStep = '';

/** Minimum ms between listener notifications for same-step row-count updates. */
const NOTIFY_INTERVAL_MS = 150;

function notify(force: boolean) {
  const now = Date.now();
  const stepKey = current ? `${current.version}:${current.step}` : '';
  if (!force && stepKey === lastNotifiedStep && now - lastNotifyAt < NOTIFY_INTERVAL_MS) {
    return;
  }
  lastNotifyAt = now;
  lastNotifiedStep = stepKey;
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // A broken listener must never break the schema upgrade itself.
    }
  }
}

/**
 * Called from Dexie upgrade bodies. Cheap enough to call every few hundred
 * rows: listener notification is throttled, and with no listeners attached
 * (unit tests, workers) it only updates a local variable.
 */
export function reportDbUpgradeProgress(progress: DbUpgradeProgress): void {
  const stepChanged =
    !current || current.version !== progress.version || current.step !== progress.step;
  current = progress;
  notify(stepChanged);
}

/** Clears the progress state once the upgrade chain finished (or failed). */
export function clearDbUpgradeProgress(): void {
  current = null;
  notify(true);
}

/** Latest progress, or null when no upgrade step has reported yet. */
export function getDbUpgradeProgress(): DbUpgradeProgress | null {
  return current;
}

/**
 * Subscribe to progress updates. The callback fires immediately with the
 * current value, then on every (throttled) change. Returns an unsubscriber.
 */
export function subscribeDbUpgradeProgress(listener: Listener): () => void {
  listeners.add(listener);
  try {
    listener(current);
  } catch {
    // ignore
  }
  return () => {
    listeners.delete(listener);
  };
}
