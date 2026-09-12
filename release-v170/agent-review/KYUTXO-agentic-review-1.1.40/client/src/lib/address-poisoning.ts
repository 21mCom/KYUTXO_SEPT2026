import { db } from "./database";
import { getRecordsPageByTypeIdReverseKeyset } from "./data/record-crud";
import { getGroupKeys, type GroupBy } from "./balance-grouping";
import type { Record as DbRecord } from "./database";

// ── Address-poisoning scanner ────────────────────────────────────────────────
//
// Address poisoning is an attack where an adversary sends a tiny dust output
// from a lookalike address (one sharing the first/last characters of one of the
// victim's own addresses) hoping the victim later copies the attacker's address
// out of their transaction history. This module scans the vault's synced
// transaction data for that signal: dust-sized inbound outputs to scoped
// addresses whose transaction counterparties resemble a vault address.
//
// Modelled on computeDustings (DustedPage) and the dust detectors in
// privacy-audit.ts.

export const DEFAULT_DUST_THRESHOLD_SATS = 1000;
export const DEFAULT_MATCH_LENGTH = 4;

const ADDRESS_BATCH = 500;
const PARTICIPANT_BATCH = 500;
const TXID_BATCH = 200;
const COUNTERPARTY_BATCH = 500;

export type PoisoningScopeType = "all" | GroupBy;

export interface PoisoningSettings {
  dustThresholdSats: number;
  matchLength: number;
}

export type PoisoningHeuristic =
  | "dust-sized"
  | "lookalike"
  | "unknown-sender"
  | "one-time-counterparty";

export type PoisoningConfidence = "high" | "medium" | "low";

export interface PoisoningSuspect {
  /** Vault address the suspect address resembles (the poisoning target). */
  targetAddress: string;
  /** Record id of the target address, when it has a vault record. */
  targetRecordId?: number;
  /** Scoped address that received the dust output. */
  dustRecipient: string;
  /** Counterparty address suspected of poisoning. */
  suspectAddress: string;
  txid: string;
  vout: number;
  amountSats: number;
  /** Shared leading/trailing character counts between suspect and target. */
  leadingMatch: number;
  trailingMatch: number;
  heuristics: PoisoningHeuristic[];
  confidence: PoisoningConfidence;
}

export interface PoisoningScanOutcome {
  results: PoisoningSuspect[];
  /** Every address that was in scope for this scan. */
  scannedAddresses: Set<string>;
}

export type ScanPhase = "addresses" | "transactions" | "counterparties";

// ── Script-family classification ─────────────────────────────────────────────
//
// A lookalike only works visually when it belongs to the same address family
// (an attacker can't mimic a "bc1q…" victim with a "3…" address — the very
// first characters differ). Matching is therefore restricted to pairs in the
// same family.
export function addressFamily(address: string): string {
  const a = address.trim();
  const lower = a.toLowerCase();
  if (lower.startsWith("bc1q")) return "bc1q";
  if (lower.startsWith("bc1p")) return "bc1p";
  if (lower.startsWith("tb1q")) return "tb1q";
  if (lower.startsWith("tb1p")) return "tb1p";
  if (lower.startsWith("bcrt1")) return "bcrt1";
  if (lower.startsWith("ltc1")) return "ltc1";
  if (a.startsWith("1")) return "p2pkh";
  if (a.startsWith("3")) return "p2sh";
  if (a.startsWith("m") || a.startsWith("n")) return "testnet-p2pkh";
  if (a.startsWith("2")) return "testnet-p2sh";
  // Unknown family: match only against the exact same leading character so
  // wildly different formats never pair.
  return `other:${a.charAt(0).toLowerCase()}`;
}

export interface LookalikeMatch {
  leading: number;
  trailing: number;
}

/**
 * Compute the lookalike similarity between a suspect and a target address.
 *
 * Returns null when the pair cannot be a poisoning lookalike:
 *  - exact same address (a real address matching itself is not an attack),
 *  - different script families,
 *  - shared leading or trailing run shorter than minMatch.
 *
 * Otherwise returns the shared leading/trailing character counts. The
 * comparison is case-sensitive: copy-paste confusion is character-exact.
 */
export function computeLookalikeMatch(
  suspect: string,
  target: string,
  minMatch: number,
): LookalikeMatch | null {
  if (!suspect || !target) return null;
  if (suspect === target) return null;
  if (minMatch < 1) minMatch = 1;
  if (addressFamily(suspect) !== addressFamily(target)) return null;

  const maxLeading = Math.min(suspect.length, target.length);
  let leading = 0;
  while (leading < maxLeading && suspect[leading] === target[leading]) {
    leading++;
  }

  let trailing = 0;
  while (
    trailing < maxLeading - leading &&
    suspect[suspect.length - 1 - trailing] === target[target.length - 1 - trailing]
  ) {
    trailing++;
  }

  if (leading < minMatch || trailing < minMatch) return null;
  return { leading, trailing };
}

function classifyConfidence(heuristics: PoisoningHeuristic[]): PoisoningConfidence {
  const unknown = heuristics.includes("unknown-sender");
  const oneTime = heuristics.includes("one-time-counterparty");
  if (unknown && oneTime) return "high";
  if (unknown || oneTime) return "medium";
  return "low";
}

const CONFIDENCE_RANK: Record<PoisoningConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Scan the scoped addresses for address-poisoning attempts.
 *
 * Pass 1 — page every address record, collecting the in-scope addresses (dust
 * recipients + record ids) and the full vault address set (used for the
 * lookalike comparison and the unknown-sender heuristic).
 *
 * Pass 2 — stream transaction participants for the scoped addresses and
 * collect dust-sized inbound outputs (amount ≤ dustThresholdSats).
 *
 * Pass 3 — for every dust transaction, load ALL its participant rows and
 * collect the counterparty addresses (every address in the tx other than the
 * dust recipient). Each counterparty is compared against every scoped address
 * with computeLookalikeMatch; matches become suspects.
 *
 * Pass 4 — per unique suspect address compute the remaining heuristics:
 * unknown-sender (no vault record) and one-time-counterparty (appears in
 * exactly one transaction in the vault's participant data).
 *
 * Returns null when cancelled via the AbortSignal.
 */
export async function scanAddressPoisoning(
  scopeType: PoisoningScopeType,
  scopeValues: string[],
  settings: PoisoningSettings,
  signal: AbortSignal,
  onProgress: (processed: number, phase: ScanPhase) => void,
): Promise<PoisoningScanOutcome | null> {
  const threshold = settings.dustThresholdSats;
  const minMatch = Math.max(1, settings.matchLength);

  // ── Pass 1: scoped addresses + full vault address set ────────────────────
  const scopedMap = new Map<string, { recordId: number }>();
  const vaultAddresses = new Set<string>();
  let beforeIdExclusive: number | undefined = undefined;
  let addrProcessed = 0;

  while (true) {
    if (signal.aborted) return null;
    const batch = await getRecordsPageByTypeIdReverseKeyset("address", {
      limit: ADDRESS_BATCH,
      beforeIdExclusive,
    });
    if (batch.length === 0) break;

    for (const rec of batch) {
      const addr = rec.inputString;
      if (!addr) continue;
      vaultAddresses.add(addr);
      if (rec.id == null) continue;
      if (scopeType === "all") {
        scopedMap.set(addr, { recordId: rec.id });
      } else {
        const keys = getGroupKeys(rec as DbRecord, scopeType as GroupBy);
        if (keys.some((key) => scopeValues.includes(key))) {
          scopedMap.set(addr, { recordId: rec.id });
        }
      }
    }

    addrProcessed += batch.length;
    onProgress(addrProcessed, "addresses");

    beforeIdExclusive = batch[batch.length - 1].id ?? undefined;
    if (batch.length < ADDRESS_BATCH || beforeIdExclusive == null) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (signal.aborted) return null;
  const scannedAddresses = new Set(scopedMap.keys());
  if (scopedMap.size === 0) return { results: [], scannedAddresses };

  // ── Pass 2: dust-sized inbound outputs to scoped addresses ───────────────
  interface DustOutput {
    recipient: string;
    txid: string;
    vout: number;
    amountSats: number;
  }
  const dustOutputs: DustOutput[] = [];
  const scopedList = Array.from(scopedMap.keys());
  let partProcessed = 0;

  for (let i = 0; i < scopedList.length; i += PARTICIPANT_BATCH) {
    if (signal.aborted) return null;
    const batch = scopedList.slice(i, i + PARTICIPANT_BATCH);
    const participants = await db.transactionParticipants
      .where("address")
      .anyOf(batch)
      .toArray();

    for (const p of participants) {
      if (p.role !== "output") continue;
      if (!scopedMap.has(p.address)) continue;
      const sats = Math.round(p.amount);
      if (sats > 0 && sats <= threshold) {
        dustOutputs.push({
          recipient: p.address,
          txid: p.txid,
          vout: p.vout ?? 0,
          amountSats: sats,
        });
      }
    }

    partProcessed += batch.length;
    onProgress(partProcessed, "transactions");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (signal.aborted) return null;
  if (dustOutputs.length === 0) return { results: [], scannedAddresses };

  // ── Pass 3: counterparty addresses of every dust transaction ─────────────
  const dustByTxid = new Map<string, DustOutput[]>();
  for (const d of dustOutputs) {
    const list = dustByTxid.get(d.txid);
    if (list) list.push(d);
    else dustByTxid.set(d.txid, [d]);
  }

  interface Candidate {
    suspectAddress: string;
    dust: DustOutput;
  }
  const candidates: Candidate[] = [];
  const txids = Array.from(dustByTxid.keys());
  let cpProcessed = 0;

  for (let i = 0; i < txids.length; i += TXID_BATCH) {
    if (signal.aborted) return null;
    const batch = txids.slice(i, i + TXID_BATCH);
    const participants = await db.transactionParticipants
      .where("txid")
      .anyOf(batch)
      .toArray();

    // Group each tx's counterparty addresses (everything except the dust
    // recipient itself — that includes the user's other addresses, which the
    // heuristics will downgrade rather than hide).
    const counterpartiesByTxid = new Map<string, Set<string>>();
    for (const p of participants) {
      if (!p.address) continue;
      let set = counterpartiesByTxid.get(p.txid);
      if (!set) {
        set = new Set();
        counterpartiesByTxid.set(p.txid, set);
      }
      set.add(p.address);
    }

    for (const txid of batch) {
      const outputs = dustByTxid.get(txid);
      const counterparties = counterpartiesByTxid.get(txid);
      if (!outputs || !counterparties) continue;
      for (const dust of outputs) {
        for (const addr of counterparties) {
          if (addr === dust.recipient) continue;
          candidates.push({ suspectAddress: addr, dust });
        }
      }
    }

    cpProcessed += batch.length;
    onProgress(cpProcessed, "counterparties");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (signal.aborted) return null;

  // ── Lookalike matching: each candidate vs the pre-bucketed scoped set ────
  //
  // A lookalike match requires BOTH a shared leading run and a shared
  // trailing run of at least minMatch characters, which means the suspect and
  // target must agree exactly on their first minMatch and last minMatch
  // characters. Bucketing the scoped addresses by that prefix+suffix key
  // turns the former O(candidates x scoped) pairwise loop into a hash lookup
  // plus a (typically tiny) bucket scan — the shared bech32 "bc1q…" prefix
  // alone can't blow the bucket up because the suffix half of the key stays
  // diverse. computeLookalikeMatch still performs the full check (family,
  // exact-match exclusion, overlap-aware run lengths), so this is purely a
  // superset pre-filter and cannot change results.
  const bucketKey = (addr: string) =>
    `${addr.slice(0, minMatch)}\u0000${addr.slice(-minMatch)}`;
  const targetsByAffix = new Map<string, string[]>();
  for (const target of scopedList) {
    const key = bucketKey(target);
    const list = targetsByAffix.get(key);
    if (list) list.push(target);
    else targetsByAffix.set(key, [target]);
  }

  interface RawMatch {
    suspectAddress: string;
    targetAddress: string;
    dust: DustOutput;
    leading: number;
    trailing: number;
  }
  const rawMatches: RawMatch[] = [];
  const seenMatch = new Set<string>();

  // Even with bucketing, keep this loop cooperative: yield to the event loop
  // and honour cancellation every LOOKALIKE_YIELD candidates so a huge dust
  // set can never freeze the UI.
  const LOOKALIKE_YIELD = 2000;
  for (let ci = 0; ci < candidates.length; ci++) {
    if (ci > 0 && ci % LOOKALIKE_YIELD === 0) {
      if (signal.aborted) return null;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const cand = candidates[ci];
    const bucket = targetsByAffix.get(bucketKey(cand.suspectAddress));
    if (!bucket) continue;
    let best: { target: string; leading: number; trailing: number } | null = null;
    for (const target of bucket) {
      const m = computeLookalikeMatch(cand.suspectAddress, target, minMatch);
      if (!m) continue;
      if (!best || m.leading + m.trailing > best.leading + best.trailing) {
        best = { target, leading: m.leading, trailing: m.trailing };
      }
    }
    if (!best) continue;
    const key = `${cand.suspectAddress}${best.target}${cand.dust.txid}:${cand.dust.vout}`;
    if (seenMatch.has(key)) continue;
    seenMatch.add(key);
    rawMatches.push({
      suspectAddress: cand.suspectAddress,
      targetAddress: best.target,
      dust: cand.dust,
      leading: best.leading,
      trailing: best.trailing,
    });
  }

  if (rawMatches.length === 0) return { results: [], scannedAddresses };

  // ── Pass 4: per-suspect heuristics ───────────────────────────────────────
  const uniqueSuspects = Array.from(new Set(rawMatches.map((m) => m.suspectAddress)));

  // Distinct txids each suspect appears in (one-time-counterparty heuristic).
  const txidsBySuspect = new Map<string, Set<string>>();
  for (const s of uniqueSuspects) txidsBySuspect.set(s, new Set());

  for (let i = 0; i < uniqueSuspects.length; i += COUNTERPARTY_BATCH) {
    if (signal.aborted) return null;
    const batch = uniqueSuspects.slice(i, i + COUNTERPARTY_BATCH);
    const rows = await db.transactionParticipants
      .where("address")
      .anyOf(batch)
      .toArray();
    for (const p of rows) {
      txidsBySuspect.get(p.address)?.add(p.txid);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (signal.aborted) return null;

  const results: PoisoningSuspect[] = [];
  for (const m of rawMatches) {
    const heuristics: PoisoningHeuristic[] = ["dust-sized", "lookalike"];
    if (!vaultAddresses.has(m.suspectAddress)) {
      heuristics.push("unknown-sender");
    }
    if ((txidsBySuspect.get(m.suspectAddress)?.size ?? 0) <= 1) {
      heuristics.push("one-time-counterparty");
    }
    results.push({
      targetAddress: m.targetAddress,
      targetRecordId: scopedMap.get(m.targetAddress)?.recordId,
      dustRecipient: m.dust.recipient,
      suspectAddress: m.suspectAddress,
      txid: m.dust.txid,
      vout: m.dust.vout,
      amountSats: m.dust.amountSats,
      leadingMatch: m.leading,
      trailingMatch: m.trailing,
      heuristics,
      confidence: classifyConfidence(heuristics),
    });
  }

  results.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      b.leadingMatch + b.trailingMatch - (a.leadingMatch + a.trailingMatch) ||
      a.targetAddress.localeCompare(b.targetAddress) ||
      a.suspectAddress.localeCompare(b.suspectAddress),
  );

  return { results, scannedAddresses };
}

/** Default tag the scanner applies to suspect counterparty addresses. */
export const SUSPECTED_POISONING_TAG = "suspected-poisoning";

/**
 * User-facing explanation for why a flagged address is dangerous. Shown by
 * copy/send guards before the user copies or uses the address.
 */
export function poisoningWarningText(tags: readonly string[]): string {
  const names = tags.length > 0 ? tags.join(", ") : SUSPECTED_POISONING_TAG;
  return (
    `This address is tagged "${names}" — the Address Poisoning scan flagged it ` +
    `as a lookalike of one of your own addresses. Attackers plant such ` +
    `addresses in your history hoping you copy theirs instead of yours. ` +
    `Verify every character before using it.`
  );
}

/** The subset of a record's tags that mark it as a suspected poisoning address. */
export function getSuspectedPoisoningTags(tags: readonly string[] | null | undefined): string[] {
  return (tags ?? []).filter(isSuspectedPoisoningTag);
}

/**
 * Whether a tag marks an address as a suspected poisoning lookalike.
 *
 * Matches any tag mentioning "poison" EXCEPT target-style tags
 * ("poisoning-target"), which mark the user's own attacked address rather
 * than the attacker's lookalike.
 */
export function isSuspectedPoisoningTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  if (!t.includes("poison")) return false;
  if (t.includes("target") || t.includes("victim")) return false;
  return true;
}
