import Dexie, { type Table } from 'dexie';
import type { PrivacyAuditResult } from '@/lib/privacy-audit';
import type { AdversaryViewResult } from '@/lib/adversary-view';

/**
 * Scratch persistence for the last Privacy Audit run (main result + Adversary
 * View result) so a page refresh does not silently discard everything.
 *
 * Lives in its own local IndexedDB database (separate from the main vault DB):
 * this is purely derived, transient session data — it is recomputed from the
 * vault's own records on every run, is overwritten by each new audit, and never
 * touches the guarded CRUD tables. A single row (id = 'current') tracks the
 * lifecycle:
 *
 *   phase 'auditing'  → the main audit started but has not produced a result
 *                       yet. Seeing this on page load means a refresh happened
 *                       mid-analysis; the UI shows an "interrupted" notice.
 *   phase 'complete'  → the main audit finished. `result` is set. If
 *                       `adversaryPending` is still true, the adversary
 *                       analysis was interrupted by a refresh and the UI shows
 *                       a notice offering to re-run.
 */

export interface PrivacyAuditSession {
  id: string;
  phase: 'auditing' | 'complete';
  savedAt: number;
  /** Owner filter that was active for this run ('all' when unfiltered) */
  owner: string;
  /** Wallet filter that was active for this run ('all' when unfiltered) */
  walletName: string;
  result?: PrivacyAuditResult;
  /** True while the async adversary analysis has not completed for this run */
  adversaryPending?: boolean;
  adversaryResult?: AdversaryViewResult;
}

const SESSION_ID = 'current';

class PrivacyAuditSessionDb extends Dexie {
  session!: Table<PrivacyAuditSession, string>;

  constructor() {
    super('kyutxo-privacy-audit-session');
    this.version(1).stores({ session: 'id' });
  }
}

let instance: PrivacyAuditSessionDb | null = null;

function getStore(): PrivacyAuditSessionDb {
  if (!instance) instance = new PrivacyAuditSessionDb();
  return instance;
}

/** Load the persisted session from the last run, if any. */
export async function loadAuditSession(): Promise<PrivacyAuditSession | null> {
  const row = await getStore().session.get(SESSION_ID);
  return row ?? null;
}

/**
 * Mark that a new audit has started. Replaces any previous session so a
 * refresh mid-analysis is detectable (phase stays 'auditing' with no result).
 */
export async function beginAuditSession(owner: string, walletName: string): Promise<void> {
  await getStore().session.put({
    id: SESSION_ID,
    phase: 'auditing',
    savedAt: Date.now(),
    owner,
    walletName,
  });
}

/**
 * Persist the completed main audit result. `adversaryPending` starts true and
 * is cleared by `saveAdversaryResult` (or `clearAdversaryPending` on failure).
 */
export async function saveAuditResult(
  owner: string,
  walletName: string,
  result: PrivacyAuditResult,
): Promise<void> {
  await getStore().session.put({
    id: SESSION_ID,
    phase: 'complete',
    savedAt: Date.now(),
    owner,
    walletName,
    result,
    adversaryPending: true,
  });
}

/** Attach the completed adversary analysis to the current session. */
export async function saveAdversaryResult(advResult: AdversaryViewResult): Promise<void> {
  const store = getStore();
  const row = await store.session.get(SESSION_ID);
  if (!row || row.phase !== 'complete') return;
  await store.session.put({
    ...row,
    savedAt: Date.now(),
    adversaryPending: false,
    adversaryResult: advResult,
  });
}

/** Clear the pending flag without a result (adversary run failed/aborted). */
export async function clearAdversaryPending(): Promise<void> {
  const store = getStore();
  const row = await store.session.get(SESSION_ID);
  if (!row) return;
  await store.session.put({ ...row, adversaryPending: false });
}

/** Drop the persisted session entirely (used when an audit finds no records). */
export async function clearAuditSession(): Promise<void> {
  await getStore().session.delete(SESSION_ID);
}
