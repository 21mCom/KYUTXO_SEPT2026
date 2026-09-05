/**
 * Dormant Coins scanner — read-only, offline-first.
 *
 * Hunts for forgotten or lost-key coins in the vault's synced transaction
 * history: old outputs that are still unspent, on both the user's own tracked
 * addresses (forgotten change, old receive addresses) and unknown counterparty
 * addresses connected to old transactions (co-spend clue clustering via the
 * common-input-ownership heuristic).
 *
 * Everything is computed from LOCAL data only (transactionParticipants,
 * blockchainTransactions, records, utxoLineage) — no live balance lookups.
 *
 * Spent detection is EXACT outpoint matching only (`[prevTxid+prevVout]`) and
 * deliberately never falls back to the approximate FIFO address:amount
 * heuristic the UTXOs page uses: a false "unspent" here would report coins as
 * recoverable that were actually spent long ago. Inputs that lack outpoint
 * data are counted (`missingOutpointInputs`) and surfaced as a warning, so the
 * user knows the report may overstate "still holds coins" for those.
 *
 * Dust rules: dust-sized outputs are excluded from the results, and dust-sized
 * activity is ignored when computing an address's last meaningful activity
 * date — so an old address that keeps getting dusted still surfaces with its
 * true dormancy date. Both rules can be disabled with `ignoreDust`.
 *
 * No writes are performed anywhere in this module (CRUD-guard compliant);
 * persistence is the caller's job via the awaited onBatch/onGroupBatch
 * callbacks (backpressure), which the page wires to the scratch report store.
 */

import type { UtxoLineage } from './database';
import { isUserCuratedImportance } from './db-types';
import { canonicalizeRecordIdentifier } from './bitcoin';
import { DEFAULT_DUST_THRESHOLD_SATS } from './address-poisoning';
import { getRecordsPageByTypeIdReverseKeyset } from './data/record-crud';
import {
  countTransactions,
  getTransactionParticipantsAfterId,
  getTransactionsAfterId,
} from './data/transaction-crud';
import { getVaultRepository } from './repository';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DormantClueType =
  | 'own-dormant'      // unspent old output on one of the user's own addresses
  | 'co-spent'         // unknown address that shared inputs with owned keys in an old tx
  | 'paid-alongside'   // unknown output paid in the same old tx as an owned output
  | 'suspected-change';// unknown output lineage flags as change back to the user

export const DORMANT_CLUE_LABELS: Record<DormantClueType, string> = {
  'own-dormant': 'Own dormant output',
  'co-spent': 'Co-spent with your keys',
  'paid-alongside': 'Paid alongside you',
  'suspected-change': 'Suspected change',
};

export interface DormantOutputRow {
  address: string;
  txid: string;
  vout: number;
  amountSats: number;
  /** Creation time (block time of the funding transaction), unix seconds. */
  blockTime: number;
  blockHeight: number;
  /** True when the address is a user-curated ("owned") vault record. */
  owned: boolean;
  recordId?: number;
  label?: string;
  clueType: DormantClueType;
  /**
   * The address's last MEANINGFUL activity (dust-sized movements ignored),
   * unix seconds. This is the dormancy date shown to the user: an old address
   * that keeps receiving dust still reports its true last activity.
   */
  lastActivity: number;
  /** 1-based co-spend clue group number, set only for 'co-spent' rows. */
  groupId?: number;
}

export interface DormantClueGroup {
  /** 1-based, assigned after ranking by combined dormant amount. */
  groupId: number;
  /** Member addresses (capped at MAX_GROUP_ADDRESSES; see addressCount). */
  addresses: string[];
  addressCount: number;
  /** How many old transactions co-spent these addresses with owned keys. */
  coSpendTxCount: number;
  /** Oldest dormant output creation time across the group, unix seconds. */
  oldestBlockTime: number;
  totalDormantSats: number;
  dormantOutputCount: number;
}

export interface DormantScanParams {
  /** Minimum dormancy age in years (output creation AND last activity older). */
  minAgeYears: number;
  /** Minimum output amount in satoshis. */
  minAmountSats: number;
  /** Outputs at or below this size count as dust. */
  dustThresholdSats: number;
  /** When true, the dust rules are disabled entirely. */
  ignoreDust: boolean;
  /** Injectable "now" (unix seconds) for deterministic tests. */
  nowSec?: number;
}

export const DEFAULT_MIN_AGE_YEARS = 3;
export const DEFAULT_MIN_AMOUNT_SATS = 10_000;
export { DEFAULT_DUST_THRESHOLD_SATS };

export type DormantScanPhase =
  | 'records'
  | 'transactions'
  | 'participants'
  | 'classify'
  | 'store';

export interface DormantScanProgress {
  phase: DormantScanPhase;
  processed: number;
  total?: number;
}

export interface DormantScanSummary {
  rowCount: number;
  groupCount: number;
  totalSats: number;
  ownSats: number;
  clueSats: number;
  scannedParticipants: number;
  scannedTransactions: number;
  /**
   * Spend inputs that carry no prevTxid/prevVout. Their spends CANNOT be
   * matched exactly, so outputs they consumed may be wrongly reported as
   * unspent — surfaced as a warning, never silently FIFO-matched.
   */
  missingOutpointInputs: number;
  /** Oldest dormant output creation time in the result set, unix seconds. */
  oldestBlockTime?: number;
  params: DormantScanParams;
}

export interface DormantScanOptions {
  signal: AbortSignal;
  onProgress?: (progress: DormantScanProgress) => void;
  /** Awaited per batch — persist before the next batch is produced. */
  onBatch?: (rows: DormantOutputRow[]) => Promise<void>;
  onGroupBatch?: (groups: DormantClueGroup[]) => Promise<void>;
  /** Test hook: fires after every cooperative yield. */
  onYield?: () => void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const RECORDS_BATCH = 500;
const TX_BATCH = 1000;
const PARTICIPANT_BATCH = 1000;
const OUT_BATCH = 500;
const LINEAGE_BATCH = 500;
const MAX_GROUP_ADDRESSES = 200;

/** In-memory iterations between cooperative yields to the event loop. */
const SCAN_YIELD_EVERY = 5000;

const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;

async function scanYield(signal: AbortSignal, onYield?: () => void): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise((r) => setTimeout(r, 0));
  onYield?.();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

interface AddressClass {
  owned: boolean;
  recordId?: number;
  label?: string;
}

interface CandidateOutput {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  blockTime: number;
  blockHeight: number;
}

interface OldTxClues {
  ownedInput: boolean;
  unknownInputs: Set<string>;
  ownedOutput: boolean;
}

// ---------------------------------------------------------------------------
// Union-find for co-spend clustering
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== this.parent.get(root)!) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Runs the dormancy scan. Returns the summary, or null when cancelled.
 * Result rows and clue groups are streamed out through the awaited batch
 * callbacks; nothing is written to the vault itself.
 */
export async function runDormantScan(
  params: DormantScanParams,
  options: DormantScanOptions,
): Promise<DormantScanSummary | null> {
  const { signal, onProgress, onBatch, onGroupBatch, onYield } = options;
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
  const ageCutoff = nowSec - Math.max(0, params.minAgeYears) * SECONDS_PER_YEAR;
  const dustLimit = Math.max(0, params.dustThresholdSats);
  const isDust = (amount: number) => !params.ignoreDust && amount <= dustLimit;

  try {
    // ── Phase 1: address records → owned/unknown classification ──────────
    const addrClass = new Map<string, AddressClass>();
    let beforeIdExclusive: number | undefined = undefined;
    let recordsProcessed = 0;
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = await getRecordsPageByTypeIdReverseKeyset('address', {
        limit: RECORDS_BATCH,
        beforeIdExclusive,
      });
      if (batch.length === 0) break;
      for (const rec of batch) {
        if (!rec.inputString) continue;
        // Records are stored canonical; key the map the same way.
        addrClass.set(rec.inputString, {
          owned: isUserCuratedImportance(rec.addressImportance),
          recordId: rec.id,
          label: rec.label || undefined,
        });
      }
      recordsProcessed += batch.length;
      beforeIdExclusive = batch[batch.length - 1].id;
      onProgress?.({ phase: 'records', processed: recordsProcessed });
      await scanYield(signal, onYield);
      if (batch.length < RECORDS_BATCH) break;
    }

    // ── Phase 2: transactions → txid ⇒ block time/height ─────────────────
    const txInfo = new Map<string, { blockTime: number; blockHeight: number }>();
    const txTotal = await countTransactions();
    let txAfterId = 0;
    let txProcessed = 0;
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = await getTransactionsAfterId(txAfterId, TX_BATCH);
      if (batch.length === 0) break;
      for (const tx of batch) {
        txInfo.set(tx.txid, { blockTime: tx.blockTime ?? 0, blockHeight: tx.blockHeight ?? 0 });
      }
      txProcessed += batch.length;
      txAfterId = batch[batch.length - 1].id ?? txAfterId;
      onProgress?.({ phase: 'transactions', processed: txProcessed, total: txTotal });
      await scanYield(signal, onYield);
      if (batch.length < TX_BATCH) break;
    }

    // ── Phase 3: streaming pass over all participants ────────────────────
    //
    // Exact outpoint spent detection only: an input with prevTxid/prevVout
    // is authoritative evidence that the referenced output was spent. We fail
    // closed — such inputs count as spends even when the spending transaction
    // row is missing or undated, because claiming coins are still held when
    // they were spent is the dangerous direction. Inputs WITHOUT outpoint
    // data are only counted (warning), never FIFO-matched.
    const spentOutpoints = new Set<string>();
    const lastActivity = new Map<string, number>();
    const oldTxClues = new Map<string, OldTxClues>();
    const candidates: CandidateOutput[] = [];
    let missingOutpointInputs = 0;
    let scanned = 0;
    let pAfterId = 0;
    let sinceYield = 0;

    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = await getTransactionParticipantsAfterId(pAfterId, PARTICIPANT_BATCH);
      if (batch.length === 0) break;

      for (const p of batch) {
        scanned++;
        if (++sinceYield >= SCAN_YIELD_EVERY) {
          sinceYield = 0;
          onProgress?.({ phase: 'participants', processed: scanned });
          await scanYield(signal, onYield);
        }

        if (p.role === 'input') {
          if (p.prevTxid != null && p.prevVout != null) {
            spentOutpoints.add(`${p.prevTxid}:${p.prevVout}`);
          } else {
            missingOutpointInputs++;
          }
        }

        const address = p.address && p.address.trim() ? canonicalizeRecordIdentifier(p.address) : '';
        const tx = txInfo.get(p.txid);
        const blockTime = tx?.blockTime ?? 0;
        if (!address || blockTime <= 0) continue;

        // Last meaningful activity ignores dust-sized movements entirely.
        if (!isDust(p.amount)) {
          const prev = lastActivity.get(address) ?? 0;
          if (blockTime > prev) lastActivity.set(address, blockTime);
        }

        // Clue context is only needed for transactions old enough to matter.
        if (blockTime <= ageCutoff) {
          let clues = oldTxClues.get(p.txid);
          if (!clues) {
            clues = { ownedInput: false, unknownInputs: new Set(), ownedOutput: false };
            oldTxClues.set(p.txid, clues);
          }
          const owned = addrClass.get(address)?.owned ?? false;
          if (p.role === 'input') {
            if (owned) clues.ownedInput = true;
            else clues.unknownInputs.add(address);
          } else if (owned) {
            clues.ownedOutput = true;
          }

          // Candidate dormant outputs: old, non-dust, above the amount floor.
          if (
            p.role === 'output' &&
            p.amount >= params.minAmountSats &&
            !isDust(p.amount)
          ) {
            candidates.push({
              txid: p.txid,
              vout: p.vout ?? 0,
              address,
              amountSats: p.amount,
              blockTime,
              blockHeight: tx?.blockHeight ?? 0,
            });
          }
        }
      }

      pAfterId = batch[batch.length - 1].id ?? pAfterId;
      onProgress?.({ phase: 'participants', processed: scanned });
      await scanYield(signal, onYield);
      if (batch.length < PARTICIPANT_BATCH) break;
    }

    // ── Phase 4: classify candidates & build co-spend clue groups ────────
    onProgress?.({ phase: 'classify', processed: 0, total: candidates.length });

    // Co-spend clustering: unknown input addresses that shared an old
    // transaction's inputs with owned keys are likely the same entity —
    // possibly the user's own lost keys.
    const uf = new UnionFind();
    const groupTxids = new Map<string, Set<string>>(); // root → co-spend txids
    const groupMembers = new Map<string, Set<string>>(); // root → all unknown members
    let classifyIter = 0;
    for (const [txid, clues] of oldTxClues) {
      if (++classifyIter % SCAN_YIELD_EVERY === 0) await scanYield(signal, onYield);
      if (!clues.ownedInput || clues.unknownInputs.size === 0) continue;
      const members = [...clues.unknownInputs];
      for (let i = 1; i < members.length; i++) uf.union(members[0], members[i]);
      const root = uf.find(members[0]);
      let txs = groupTxids.get(root);
      if (!txs) {
        txs = new Set();
        groupTxids.set(root, txs);
      }
      txs.add(txid);
      let mem = groupMembers.get(root);
      if (!mem) {
        mem = new Set();
        groupMembers.set(root, mem);
      }
      for (const m of members) mem.add(m);
    }

    // Normalize cluster keys: a union performed for a LATER transaction can
    // re-root a cluster recorded under an earlier root, so re-key both maps by
    // the current root before they are consulted.
    for (const [root, txs] of [...groupTxids]) {
      const r = uf.find(root);
      if (r === root) continue;
      groupTxids.delete(root);
      const into = groupTxids.get(r) ?? new Set<string>();
      for (const t of txs) into.add(t);
      groupTxids.set(r, into);
    }
    for (const [root, mem] of [...groupMembers]) {
      const r = uf.find(root);
      if (r === root) continue;
      groupMembers.delete(root);
      const into = groupMembers.get(r) ?? new Set<string>();
      for (const m of mem) into.add(m);
      groupMembers.set(r, into);
    }

    // Lineage change signals for unknown candidates (batched on the compound
    // [createdTxid+createdVout] index; read-only).
    const unknownCandidates = candidates.filter(
      (c) => !(addrClass.get(c.address)?.owned ?? false),
    );
    const changeOutpoints = new Set<string>();
    for (let i = 0; i < unknownCandidates.length; i += LINEAGE_BATCH) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = unknownCandidates.slice(i, i + LINEAGE_BATCH);
      const outpoints = batch.map((c) => [c.txid, c.vout] as [string, number]);
      const rows = await getVaultRepository().query<UtxoLineage>(
        'utxoLineage',
        'lineage.byCreatedOutpoints',
        outpoints,
        outpoints.length,
      );
      for (const l of rows) {
        if (l.isChange) changeOutpoints.add(`${l.createdTxid}:${l.createdVout}`);
      }
      onProgress?.({
        phase: 'classify',
        processed: Math.min(i + LINEAGE_BATCH, unknownCandidates.length),
        total: Math.max(candidates.length, unknownCandidates.length),
      });
      await scanYield(signal, onYield);
    }

    const rows: DormantOutputRow[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (i % SCAN_YIELD_EVERY === 0 && i > 0) await scanYield(signal, onYield);
      const c = candidates[i];

      // Exact outpoint spent check — never FIFO.
      if (spentOutpoints.has(`${c.txid}:${c.vout}`)) continue;

      // Address dormancy gate: the address's last MEANINGFUL activity (dust
      // ignored) must itself be older than the cutoff. This is what lets a
      // repeatedly dusted old address surface with its true dormancy date.
      const addrLast = lastActivity.get(c.address) ?? c.blockTime;
      if (addrLast > ageCutoff) continue;

      const cls = addrClass.get(c.address);
      if (cls?.owned) {
        rows.push({
          ...c,
          owned: true,
          recordId: cls.recordId,
          label: cls.label,
          clueType: 'own-dormant',
          lastActivity: addrLast,
        });
        continue;
      }

      // Unknown address: include only when an old-transaction clue connects
      // it to the user's own activity.
      if (changeOutpoints.has(`${c.txid}:${c.vout}`)) {
        rows.push({ ...c, owned: false, clueType: 'suspected-change', lastActivity: addrLast });
        continue;
      }
      const inCoSpend = groupTxids.has(uf.find(c.address));
      if (inCoSpend) {
        rows.push({ ...c, owned: false, clueType: 'co-spent', lastActivity: addrLast });
        continue;
      }
      if (oldTxClues.get(c.txid)?.ownedOutput) {
        rows.push({ ...c, owned: false, clueType: 'paid-alongside', lastActivity: addrLast });
        continue;
      }
      // No clue tying this unknown output to the user's history: skip.
    }

    // Rank by age (oldest first), then amount (largest first), deterministically.
    rows.sort((a, b) => {
      if (a.blockTime !== b.blockTime) return a.blockTime - b.blockTime;
      if (a.amountSats !== b.amountSats) return b.amountSats - a.amountSats;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    });

    // Build groups from the co-spend clusters, ranked by combined dormant
    // amount. Membership comes from the clustering phase (every unknown that
    // co-spent with owned keys), so members with no dormant output still
    // appear; clusters with NO dormant outputs at all are dropped — there is
    // nothing recoverable to hunt there.
    const groupStats = new Map<
      string,
      { members: Set<string>; txids: Set<string>; totalSats: number; outputCount: number; oldest: number }
    >();
    for (const row of rows) {
      if (row.clueType !== 'co-spent') continue;
      const root = uf.find(row.address);
      let g = groupStats.get(root);
      if (!g) {
        g = {
          members: new Set(groupMembers.get(root) ?? [row.address]),
          txids: groupTxids.get(root) ?? new Set(),
          totalSats: 0,
          outputCount: 0,
          oldest: Number.POSITIVE_INFINITY,
        };
        groupStats.set(root, g);
      }
      g.totalSats += row.amountSats;
      g.outputCount++;
      if (row.blockTime < g.oldest) g.oldest = row.blockTime;
    }
    const sortedGroups = [...groupStats.values()].sort((a, b) => {
      if (a.totalSats !== b.totalSats) return b.totalSats - a.totalSats;
      return a.oldest - b.oldest;
    });
    const groupIdByMember = new Map<string, number>();
    const groups: DormantClueGroup[] = sortedGroups.map((g, idx) => {
      const groupId = idx + 1;
      const members = [...g.members].sort();
      for (const m of members) groupIdByMember.set(m, groupId);
      return {
        groupId,
        addresses: members.slice(0, MAX_GROUP_ADDRESSES),
        addressCount: members.length,
        coSpendTxCount: g.txids.size,
        oldestBlockTime: Number.isFinite(g.oldest) ? g.oldest : 0,
        totalDormantSats: g.totalSats,
        dormantOutputCount: g.outputCount,
      };
    });
    for (const row of rows) {
      if (row.clueType === 'co-spent') {
        row.groupId = groupIdByMember.get(row.address);
      }
    }

    // ── Phase 5: stream results to the caller's store ────────────────────
    let stored = 0;
    for (let i = 0; i < rows.length; i += OUT_BATCH) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = rows.slice(i, i + OUT_BATCH);
      await onBatch?.(batch);
      stored += batch.length;
      onProgress?.({ phase: 'store', processed: stored, total: rows.length });
      await scanYield(signal, onYield);
    }
    if (onGroupBatch && groups.length > 0) {
      await onGroupBatch(groups);
      await scanYield(signal, onYield);
    }

    let totalSats = 0;
    let ownSats = 0;
    for (const row of rows) {
      totalSats += row.amountSats;
      if (row.owned) ownSats += row.amountSats;
    }

    return {
      rowCount: rows.length,
      groupCount: groups.length,
      totalSats,
      ownSats,
      clueSats: totalSats - ownSats,
      scannedParticipants: scanned,
      scannedTransactions: txInfo.size,
      missingOutpointInputs,
      oldestBlockTime: rows.length > 0 ? rows[0].blockTime : undefined,
      params,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    if (signal.aborted) return null;
    throw err;
  }
}

/** Human-readable age in whole years (one decimal below 10 years). */
export function formatAgeYears(blockTimeSec: number, nowSec: number): string {
  const years = Math.max(0, (nowSec - blockTimeSec) / SECONDS_PER_YEAR);
  return years < 10 ? years.toFixed(1) : String(Math.round(years));
}
