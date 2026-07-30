/**
 * adversary-view.ts
 *
 * Blind adversary chain-analysis engine + ground-truth comparison layer.
 *
 * Simulates what a blockchain analyst would infer about the user's wallet
 * using only public on-chain heuristics, then compares those inferences
 * against the user's own record metadata to produce three finding categories:
 *
 *   Exposure             — adversary correctly clusters multiple owned addresses
 *   Preserved Separation — verified distinct wallet groups the adversary cannot link
 *   Protective Confusion — adversary's change-guess contradicts our ground truth
 *
 * Plus context-merge warnings for multi-input txs that join distinct
 * acquisition contexts (acquisitionMethod / counterpartyName on address records).
 *
 * The adversary uses TWO heuristics (both without ground truth):
 *   1. Common-Input-Ownership (CIO): every address co-spending as inputs in the
 *      same transaction belongs to the same wallet (certain tier).
 *   2. Change-output guess: in a 2-output transaction, the smaller output is
 *      assumed to be internal change going back to the spender (likely tier).
 *      This adds "likely" links on top of the certain CIO graph.
 *
 * We build both tiers and compare against ground truth:
 *   - Certain exposure  → same cluster in the CIO-only graph
 *   - Likely exposure   → same cluster only after adding change-guess links
 *   - Separation        → groups in DIFFERENT clusters even in the combined
 *                         (CIO + change-guess) graph, backed by real xpub data
 *
 * Runs entirely offline. Makes no network requests.
 */

import { db } from "@/lib/database";
import type { TransactionParticipant } from "@/lib/db-types";
import { getParticipantsByAddressesWithOutpointSpends } from "@/lib/data/record-queries";
import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import type { Record as DbRecord } from "@/lib/db-types";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * How certain the adversary's link is:
 *   certain     — co-spend (CIO): provably same wallet per the public chain
 *   likely      — change-guess heuristic: high probability but not certain
 *   speculative — context-difference only: possible inference, not proven
 */
export type AdversaryConfidence = "certain" | "likely" | "speculative";

/**
 * The three output categories produced by comparing the adversary's blind
 * clustering against the user's ground truth.
 */
export type AdversaryCategory =
  | "exposure"
  | "preserved-separation"
  | "protective-confusion";

export interface AdversaryFinding {
  category: AdversaryCategory;
  confidence: AdversaryConfidence;
  /** Plain-language narrative (pass through renderSourceNote in the UI) */
  narrative: string;
  txids: string[];
  addresses: string[];
  /** False when no chainType data exists for the relevant addresses */
  groundTruthAvailable: boolean;
}

export interface ContextMergeContext {
  address: string;
  acquisitionMethod?: string;
  counterpartyName?: string;
  /** Human-readable summary label for display */
  label: string;
}

export interface ContextMergeWarning {
  txid: string;
  /** Plain-language narrative (pass through renderSourceNote in the UI) */
  narrative: string;
  contexts: ContextMergeContext[];
  /** True when at least one input has no acquisition context (partial ground truth) */
  hasUnknownContext: boolean;
}

export interface AdversaryGroundTruthDegradation {
  reason: "no-xpub-import" | "partial-chaintype" | "no-data";
  message: string;
}

export interface AdversaryViewResult {
  /** Clusters where the adversary correctly links multiple of our addresses */
  exposureFindings: AdversaryFinding[];
  /** Verified distinct wallet groups the adversary CANNOT connect */
  separationFindings: AdversaryFinding[];
  /** Cases where the adversary's change-guess contradicts our ground truth */
  confusionFindings: AdversaryFinding[];
  /** Txs that join inputs from distinct acquisition contexts */
  contextMergeWarnings: ContextMergeWarning[];
  summary: {
    exposureCount: number;
    separationCount: number;
    confusionCount: number;
    contextMergeCount: number;
    /** Distinct owned addresses that appear in at least one exposure finding */
    addressesExposed: number;
    /** Distinct owned addresses in preserved-separation findings */
    addressesSeparated: number;
  };
  /** Non-null when chainType coverage is insufficient for full analysis */
  degradation: AdversaryGroundTruthDegradation | null;
  /** Fraction of owned addresses that have chainType data (0.0–1.0) */
  chainTypeCoverage: number;
}

// ─── Internal: adversary context ─────────────────────────────────────────────

interface AdversaryContext {
  userAddresses: Set<string>;
  participantsByTxid: Map<string, TransactionParticipant[]>;
}

// ─── Internal: Union-Find with txid tracking ──────────────────────────────────
//
// Each cluster root maintains the full set of transaction IDs that contributed
// to building its cluster (CIO co-inputs + change-guess links). This lets us
// provide concrete linking evidence in finding narratives even for transitive
// connections where no single tx has two owned inputs.

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();
  // All txids that contributed any edge to the cluster rooted at this key
  private clusterTxids = new Map<string, Set<string>>();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
      this.clusterTxids.set(x, new Set());
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(x: string, y: string, txid?: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    // Ensure txid sets exist for both roots before merging
    if (!this.clusterTxids.has(rx)) this.clusterTxids.set(rx, new Set());
    if (!this.clusterTxids.has(ry)) this.clusterTxids.set(ry, new Set());

    if (rx === ry) {
      // Same cluster already — just record the txid for completeness
      if (txid) this.clusterTxids.get(rx)!.add(txid);
      return;
    }

    const rankX = this.rank.get(rx) ?? 0;
    const rankY = this.rank.get(ry) ?? 0;

    let newRoot: string;
    let oldRoot: string;
    if (rankX < rankY) {
      this.parent.set(rx, ry);
      newRoot = ry;
      oldRoot = rx;
    } else if (rankX > rankY) {
      this.parent.set(ry, rx);
      newRoot = rx;
      oldRoot = ry;
    } else {
      this.parent.set(ry, rx);
      this.rank.set(rx, rankX + 1);
      newRoot = rx;
      oldRoot = ry;
    }

    // Merge txid sets into the new root
    const mergedTxids = this.clusterTxids.get(newRoot)!;
    for (const t of this.clusterTxids.get(oldRoot) ?? []) {
      mergedTxids.add(t);
    }
    if (txid) mergedTxids.add(txid);
    this.clusterTxids.delete(oldRoot);
  }

  has(x: string): boolean {
    return this.parent.has(x);
  }

  /** All txids that contributed to the cluster containing address x */
  getTxids(x: string): string[] {
    const root = this.find(x);
    return Array.from(this.clusterTxids.get(root) ?? []);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

function fmtTxid(txid: string): string {
  if (!txid || txid.length < 12) return txid;
  return `${txid.slice(0, 8)}\u2026`;
}

/**
 * Script type derivable from an address prefix. Used by the adversary's
 * script-type-consistency change heuristic.
 */
export type ScriptType =
  | "p2wpkh"
  | "p2wsh"
  | "p2tr"
  | "p2sh"
  | "p2pkh"
  | "unknown";

/**
 * Classify an address by prefix. Edge cases handled deliberately:
 * - BIP-173 allows bech32 addresses in ALL-UPPERCASE, but forbids mixed
 *   case — mixed-case bech32-looking strings return "unknown" rather than
 *   feeding a wrong type into the heuristic.
 * - P2WSH (witness v0, 32-byte program) is distinguished from P2WPKH
 *   (20-byte program) by the length of the part after the "hrp1" prefix:
 *   39 chars for P2WPKH, 59 for P2WSH.
 * - Base58 prefixes (1/3 mainnet, m/n/2 testnet) are case-sensitive, so we
 *   check the original string: an uppercase "M…"/"N…" is NOT a testnet
 *   P2PKH address and must not be classified as one.
 */
export function getScriptType(address: string): ScriptType {
  if (!address) return "unknown";

  const lower = address.toLowerCase();
  const upper = address.toUpperCase();
  const isBech32Like =
    lower.startsWith("bc1") || lower.startsWith("tb1") || lower.startsWith("bcrt1");

  if (isBech32Like) {
    // BIP-173: mixed case is invalid. Accept only all-lower or all-upper.
    if (address !== lower && address !== upper) return "unknown";
    const a = lower;
    if (a.startsWith("bc1p") || a.startsWith("tb1p") || a.startsWith("bcrt1p"))
      return "p2tr";
    if (a.startsWith("bc1q") || a.startsWith("tb1q") || a.startsWith("bcrt1q")) {
      // Length of everything after "<hrp>1": witness version char + data +
      // checksum. 39 chars → 20-byte program (P2WPKH); 59 → 32-byte (P2WSH).
      const hrpLen = a.startsWith("bcrt1") ? 5 : 3;
      const rest = a.length - hrpLen;
      if (rest === 39) return "p2wpkh";
      if (rest === 59) return "p2wsh";
      return "unknown";
    }
    return "unknown";
  }

  if (address.startsWith("3") || address.startsWith("2")) return "p2sh";
  if (address.startsWith("1") || address.startsWith("m") || address.startsWith("n"))
    return "p2pkh";
  return "unknown";
}

const RECORD_BATCH = 500;
const PARTICIPANT_BATCH = 500;

// ─── Context builder ──────────────────────────────────────────────────────────

/**
 * Build the adversary context from a list of owned addresses.
 * Loads all transaction participants that touch those addresses, then also
 * loads all participants for those same transactions (for the full tx picture).
 */
async function buildAdversaryContext(
  userAddresses: string[],
  report: (msg: string) => void,
  signal?: AbortSignal,
): Promise<AdversaryContext> {
  const userSet = new Set(userAddresses);

  report("Adversary view: loading transaction participants\u2026");
  // Outpoint-aware load: Electrum-synced spend inputs carry a blank address,
  // so a pure address-keyed load would miss spend txs whose only link to an
  // owned address is such an input. The helper merges those rows in, so the
  // adversary's txid universe includes those spends too.
  const ownedParticipants = await getParticipantsByAddressesWithOutpointSpends(userAddresses, signal);

  // Collect all txids that touch any owned address
  const ourTxids = new Set(ownedParticipants.map((p) => p.txid));
  const txidArray = Array.from(ourTxids);

  // Load ALL participants for those transactions (not just our owned ones)
  // so the adversary can see co-inputs from external addresses too.
  report("Adversary view: loading full transaction data\u2026");
  const allParts: TransactionParticipant[] = [];
  for (let i = 0; i < txidArray.length; i += PARTICIPANT_BATCH) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = txidArray.slice(i, i + PARTICIPANT_BATCH);
    const batchParts = await db.transactionParticipants
      .where("txid")
      .anyOf(batch)
      .toArray();
    allParts.push(...batchParts);
    if (i + PARTICIPANT_BATCH < txidArray.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Attribute blank-address (Electrum-synced) spend inputs back to the
  // address that owns the spent output. A real chain adversary sees the true
  // prevout address on the public chain, so the blind heuristics (CIO,
  // change-guess) must not skip those rows just because our local sync
  // stored them with an empty address.
  const addrByOutpoint = new Map<string, string>();
  for (const p of allParts) {
    if (p.role === "output" && p.vout !== undefined && p.vout !== null && p.address) {
      addrByOutpoint.set(`${p.txid}:${p.vout}`, p.address);
    }
  }

  const participantsByTxid = new Map<string, TransactionParticipant[]>();
  for (const raw of allParts) {
    let p = raw;
    if (p.role === "input" && !p.address && p.prevTxid && p.prevVout !== undefined && p.prevVout !== null) {
      const owner = addrByOutpoint.get(`${p.prevTxid}:${p.prevVout}`);
      if (owner) p = { ...p, address: owner };
    }
    const list = participantsByTxid.get(p.txid);
    if (list) list.push(p);
    else participantsByTxid.set(p.txid, [p]);
  }

  return { userAddresses: userSet, participantsByTxid };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the adversary-view analysis for the given owned addresses.
 *
 * Builds its own transaction context from the local DB (same data the privacy
 * audit uses), so no AuditContext object needs to be threaded through from the
 * caller.
 *
 * @param userAddresses Owned Bitcoin addresses to analyse
 * @param report        Optional progress callback
 * @param signal        Optional AbortSignal to cancel the DB-loading phase
 */
export async function runAdversaryView(
  userAddresses: string[],
  report?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<AdversaryViewResult> {
  const progress = (msg: string) => report?.(msg);

  if (userAddresses.length === 0) {
    return emptyResult();
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Build the adversary context (load DB participants)
  const ctx = await buildAdversaryContext(userAddresses, progress, signal);

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  return runAdversaryViewFromContext(ctx, progress);
}

/**
 * Run the adversary-view analysis over a pre-built context.
 * Exported for unit tests that inject a synthetic context without hitting Dexie.
 */
export async function runAdversaryViewFromContext(
  ctx: AdversaryContext,
  report?: (msg: string) => void,
): Promise<AdversaryViewResult> {
  const progress = (msg: string) => report?.(msg);

  if (ctx.userAddresses.size === 0) {
    return emptyResult();
  }

  progress("Adversary view: building blind CIO clusters\u2026");

  // ── Step 1: CIO clustering — certain tier ─────────────────────────────────
  // Every address that appears as an input in the same transaction is assumed
  // to belong to the same wallet (common-input-ownership heuristic).
  // No ground truth used — only the public tx graph.

  const certainUF = new UnionFind();

  for (const [txid, parts] of ctx.participantsByTxid) {
    const inputAddrs = parts
      .filter((p) => p.role === "input" && p.address)
      .map((p) => p.address);

    if (inputAddrs.length < 2) continue;

    for (const addr of inputAddrs) {
      certainUF.find(addr); // initialise node
    }
    for (let i = 1; i < inputAddrs.length; i++) {
      certainUF.union(inputAddrs[0], inputAddrs[i], txid);
    }
  }

  // ── Step 2: Change-guess extension — likely tier ──────────────────────────
  // The adversary also applies the change-output heuristic: in a 2-output tx,
  // the smaller output is assumed to be internal change (going back to the
  // sender's wallet). The analyst unions that guessed-change address with the
  // tx inputs, creating "likely" co-ownership links beyond what CIO proves.
  //
  // We build a SECOND union-find (likelyUF) that starts with the same CIO
  // edges and then adds these change-guess edges on top. This combined graph
  // represents the adversary's full blind reconstruction.

  const likelyUF = new UnionFind();

  // Replay all CIO edges onto likelyUF first
  for (const [txid, parts] of ctx.participantsByTxid) {
    const inputAddrs = parts
      .filter((p) => p.role === "input" && p.address)
      .map((p) => p.address);

    if (inputAddrs.length < 2) continue;

    for (const addr of inputAddrs) {
      likelyUF.find(addr);
    }
    for (let i = 1; i < inputAddrs.length; i++) {
      likelyUF.union(inputAddrs[0], inputAddrs[i], txid);
    }
  }

  // Add change-guess (likely) edges
  for (const [txid, parts] of ctx.participantsByTxid) {
    const inputs = parts.filter((p) => p.role === "input" && p.address);
    const outputs = parts.filter((p) => p.role === "output");
    if (outputs.length !== 2) continue;

    const [outA, outB] = outputs as [TransactionParticipant, TransactionParticipant];
    const guessedChange = outA.amount <= outB.amount ? outA : outB;
    if (!guessedChange.address) continue;

    for (const inp of inputs) {
      if (inp.address) {
        likelyUF.union(inp.address, guessedChange.address, txid);
      }
    }
  }

  // ── Step 3: Load ground truth from records ────────────────────────────────
  progress("Adversary view: loading ground-truth metadata\u2026");

  const ownedAddresses = Array.from(ctx.userAddresses);
  const recordMap = new Map<string, DbRecord>();

  for (let i = 0; i < ownedAddresses.length; i += RECORD_BATCH) {
    const chunk = ownedAddresses.slice(i, i + RECORD_BATCH);
    const recs = await getRecordsByInputStrings(chunk);
    for (const r of recs) {
      if (r.inputString) recordMap.set(r.inputString, r);
    }
    if (i + RECORD_BATCH < ownedAddresses.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  let withChainType = 0;
  for (const addr of ownedAddresses) {
    if (recordMap.get(addr)?.chainType) withChainType++;
  }
  const chainTypeCoverage =
    ownedAddresses.length > 0 ? withChainType / ownedAddresses.length : 0;

  progress("Adversary view: comparing clusters against ground truth\u2026");

  // ── Step 4: Map each owned address to its adversary cluster roots ─────────
  // Track roots in BOTH graphs so we can classify exposure as certain vs likely.

  const ownedToCertainRoot = new Map<string, string>();
  const ownedToLikelyRoot = new Map<string, string>();
  for (const addr of ownedAddresses) {
    ownedToCertainRoot.set(
      addr,
      certainUF.has(addr) ? certainUF.find(addr) : `singleton:${addr}`,
    );
    ownedToLikelyRoot.set(
      addr,
      likelyUF.has(addr) ? likelyUF.find(addr) : `singleton:${addr}`,
    );
  }

  // Group owned addresses by their likelyUF cluster root
  // (the combined graph gives the adversary's best reconstruction)
  const likelyRootToOwned = new Map<string, string[]>();
  for (const [addr, root] of ownedToLikelyRoot) {
    const list = likelyRootToOwned.get(root) ?? [];
    list.push(addr);
    likelyRootToOwned.set(root, list);
  }

  // ── Step 5: Exposure findings ─────────────────────────────────────────────
  // A cluster with ≥2 owned addresses → the adversary has linked them.
  // Confidence = certain if they share a CIO cluster; likely if only linked
  // via the change-guess extension.
  const exposureFindings: AdversaryFinding[] = [];

  for (const [, ownedInCluster] of likelyRootToOwned) {
    if (ownedInCluster.length < 2) continue;

    // Check if all members share a single CIO (certain) cluster
    const certainRoots = new Set(
      ownedInCluster.map((a) => ownedToCertainRoot.get(a) ?? `singleton:${a}`),
    );
    const confidence: AdversaryConfidence =
      certainRoots.size === 1 ? "certain" : "likely";

    // Use the combined likelyUF txids as linking evidence — guaranteed
    // non-empty because every edge stored its contributing txid.
    const linkingTxids = likelyUF.getTxids(ownedInCluster[0]).slice(0, 10);

    const hasChainTypeData = ownedInCluster.some(
      (a) => !!recordMap.get(a)?.chainType,
    );
    const txWord = linkingTxids.length === 1 ? "transaction" : "transactions";
    const linkDesc =
      confidence === "certain"
        ? "co-spent as inputs"
        : "linked via co-input and change-output inference";
    const narrative =
      ownedInCluster.length === 2
        ? `${fmtAddr(ownedInCluster[0])} and ${fmtAddr(ownedInCluster[1])} were ${linkDesc} in ${linkingTxids.length} ${txWord}. A chain analyst clusters them as the same wallet${confidence === "likely" ? " with high likelihood" : " with certainty"}.`
        : `${ownedInCluster.length} of your addresses are ${linkDesc} across ${linkingTxids.length} ${txWord}. A chain analyst treats them as one wallet${confidence === "likely" ? " with high likelihood" : ""}.`;

    exposureFindings.push({
      category: "exposure",
      confidence,
      narrative,
      txids: linkingTxids,
      addresses: ownedInCluster,
      groundTruthAvailable: hasChainTypeData,
    });
  }

  // ── Step 6: Preserved-separation findings ─────────────────────────────────
  // Pairs of xpub/descriptor-identified wallet groups that are in DIFFERENT
  // clusters in the COMBINED (likelyUF) graph, meaning even with both CIO and
  // change-guess heuristics the adversary cannot link them.
  //
  // We only compare groups backed by real xpub/descriptor data; per-address
  // singleton groups (no xpub) cannot prove separation — comparing those would
  // fabricate a ground-truth claim we don't have.
  const separationFindings: AdversaryFinding[] = [];

  // Build the full group map (all addresses), then filter to xpub-identified
  // groups only for the separation comparison.
  const walletGroups = new Map<string, string[]>();
  for (const addr of ownedAddresses) {
    const key = recordMap.get(addr)?.xpub ?? `addr:${addr}`;
    const list = walletGroups.get(key) ?? [];
    list.push(addr);
    walletGroups.set(key, list);
  }

  // Only keep groups whose key is a real xpub (not the `addr:` fallback)
  const xpubGroups = new Map<string, string[]>();
  for (const [key, addrs] of walletGroups) {
    if (!key.startsWith("addr:")) {
      xpubGroups.set(key, addrs);
    }
  }

  if (xpubGroups.size >= 2) {
    // Map each xpub group to its set of likelyUF roots
    const groupLikelyRoots = new Map<string, Set<string>>();
    for (const [key, addrs] of xpubGroups) {
      const roots = new Set(
        addrs.map((a) => ownedToLikelyRoot.get(a) ?? `singleton:${a}`),
      );
      groupLikelyRoots.set(key, roots);
    }

    const keys = Array.from(xpubGroups.keys());
    outer: for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (separationFindings.length >= 20) break outer;

        const rootsA = groupLikelyRoots.get(keys[i])!;
        const rootsB = groupLikelyRoots.get(keys[j])!;
        // If any root overlaps between the two groups → exposed, not separated
        const overlaps = [...rootsA].some((r) => rootsB.has(r));
        if (overlaps) continue;

        const addrsA = xpubGroups.get(keys[i])!;
        const addrsB = xpubGroups.get(keys[j])!;
        const labelA =
          addrsA.length === 1
            ? fmtAddr(addrsA[0])
            : `${fmtAddr(addrsA[0])} (+${addrsA.length - 1} related)`;
        const labelB =
          addrsB.length === 1
            ? fmtAddr(addrsB[0])
            : `${fmtAddr(addrsB[0])} (+${addrsB.length - 1} related)`;

        separationFindings.push({
          category: "preserved-separation",
          confidence: "certain",
          narrative: `${labelA} and ${labelB} are verified distinct wallets (by descriptor/XPUB) with no on-chain link \u2014 neither CIO co-spending nor change-output inference connects them. Their relationship is not visible from the chain.`,
          txids: [],
          addresses: [...addrsA, ...addrsB],
          groundTruthAvailable: [...addrsA, ...addrsB].some(
            (a) => !!recordMap.get(a)?.chainType,
          ),
        });
      }
    }
  }

  // ── Step 7: Protective confusion (change-guess heuristics) ────────────────
  // For each tx with exactly 2 outputs where at least one is owned and has
  // chainType, compare the adversary's change-guess against our ground truth.
  // When the guess is wrong, that works in our favour by misdirecting analysis.
  //
  // The adversary applies TWO change-detection heuristics:
  //   1. Amount ordering: the smaller output is assumed to be change.
  //   2. Script-type consistency: if the majority of inputs share a script
  //      type and exactly one output matches that type, that output is the
  //      more likely change (wallets typically send change back to the same
  //      script type they spend from).
  // When both heuristics agree the adversary is confident (confidence stays
  // "certain"-adjacent, i.e. "certain"); when they disagree the guess is only
  // "speculative"; when the script-type heuristic gives no signal (unknown
  // types, both outputs the same type, or no matching output) the finding
  // remains at the amount-only "likely" tier.
  const confusionFindings: AdversaryFinding[] = [];
  const confusionSeen = new Set<string>();

  for (const [txid, parts] of ctx.participantsByTxid) {
    if (confusionSeen.has(txid)) continue;

    const outputs = parts.filter((p) => p.role === "output");
    if (outputs.length !== 2) continue;

    const ownedOutputs = outputs.filter((p) =>
      ctx.userAddresses.has(p.address),
    );
    if (ownedOutputs.length === 0) continue;

    const [outA, outB] = outputs as [TransactionParticipant, TransactionParticipant];
    const adversaryChange = outA.amount <= outB.amount ? outA : outB;
    const adversaryPayment = outA.amount <= outB.amount ? outB : outA;

    // Script-type heuristic: find the majority script type among the inputs,
    // then see whether exactly one output matches it.
    const inputs = parts.filter((p) => p.role === "input");
    const inputTypeCounts = new Map<ScriptType, number>();
    for (const inp of inputs) {
      const t = getScriptType(inp.address);
      if (t === "unknown") continue;
      inputTypeCounts.set(t, (inputTypeCounts.get(t) ?? 0) + 1);
    }
    let majorityInputType: ScriptType | null = null;
    let majorityCount = 0;
    let tied = false;
    for (const [t, count] of inputTypeCounts) {
      if (count > majorityCount) {
        majorityInputType = t;
        majorityCount = count;
        tied = false;
      } else if (count === majorityCount) {
        tied = true;
      }
    }
    if (tied) majorityInputType = null;

    let scriptTypeChange: TransactionParticipant | null = null;
    if (majorityInputType) {
      const typeA = getScriptType(outA.address);
      const typeB = getScriptType(outB.address);
      const aMatches = typeA === majorityInputType;
      const bMatches = typeB === majorityInputType;
      if (aMatches && !bMatches) scriptTypeChange = outA;
      else if (bMatches && !aMatches) scriptTypeChange = outB;
    }

    // Combine the two heuristics into a confidence tier for the finding.
    let confusionConfidence: AdversaryConfidence = "likely";
    if (scriptTypeChange) {
      confusionConfidence =
        scriptTypeChange.address === adversaryChange.address
          ? "certain"
          : "speculative";
    }

    for (const ownedOut of ownedOutputs) {
      const rec = recordMap.get(ownedOut.address);
      if (!rec?.chainType) continue;

      const adversaryThinkChange = adversaryChange.address === ownedOut.address;
      const weKnowChange = rec.chainType === "change";

      if (adversaryThinkChange && !weKnowChange) {
        confusionFindings.push({
          category: "protective-confusion",
          confidence: confusionConfidence,
          narrative: `In ${fmtTxid(txid)}, the adversary\u2019s change-detection heuristic guesses ${fmtAddr(ownedOut.address)} is internal change \u2014 but your records show it is a receive address. This misdirects analysis and hides the true payment recipient.`,
          txids: [txid],
          addresses: [ownedOut.address, adversaryPayment.address].filter(
            Boolean,
          ),
          groundTruthAvailable: true,
        });
        confusionSeen.add(txid);
        break;
      } else if (!adversaryThinkChange && weKnowChange) {
        confusionFindings.push({
          category: "protective-confusion",
          confidence: confusionConfidence,
          narrative: `In ${fmtTxid(txid)}, the adversary\u2019s heuristic misidentifies ${fmtAddr(ownedOut.address)} as a payment output \u2014 but it is actually your change address. The adversary over-estimates the outflow and misreads the true change retention.`,
          txids: [txid],
          addresses: [ownedOut.address],
          groundTruthAvailable: true,
        });
        confusionSeen.add(txid);
        break;
      }
    }
  }

  // ── Step 8: Context-merge warnings ────────────────────────────────────────
  // For each tx where ≥2 owned addresses appear as inputs with differing
  // acquisition contexts, warn that those contexts are now publicly linked.
  const contextMergeWarnings: ContextMergeWarning[] = [];

  for (const [txid, parts] of ctx.participantsByTxid) {
    const ownedInputParts = parts.filter(
      (p) => p.role === "input" && ctx.userAddresses.has(p.address),
    );
    if (ownedInputParts.length < 2) continue;

    const contexts: ContextMergeContext[] = ownedInputParts.map((p) => {
      const rec = recordMap.get(p.address);
      const acqMethod = rec?.acquisitionMethod;
      const cpName = rec?.counterpartyName;
      let label = "unlabeled";
      if (cpName) label = cpName;
      else if (acqMethod) label = acqMethod;
      return { address: p.address, acquisitionMethod: acqMethod, counterpartyName: cpName, label };
    });

    const knownContexts = contexts.filter(
      (c) => c.acquisitionMethod || c.counterpartyName,
    );
    if (knownContexts.length < 2) continue;

    const first = knownContexts[0];
    const hasDiff = knownContexts.some(
      (c) =>
        c.acquisitionMethod !== first.acquisitionMethod ||
        c.counterpartyName !== first.counterpartyName,
    );
    if (!hasDiff) continue;

    const hasUnknown = contexts.some(
      (c) => !c.acquisitionMethod && !c.counterpartyName,
    );
    const distinctLabels = [...new Set(knownContexts.map((c) => c.label))];

    const narrative =
      `Transaction ${fmtTxid(txid)} combines coins from different acquisition contexts: ` +
      distinctLabels.join(" and ") +
      `. A chain analyst can now link these histories together.` +
      (hasUnknown
        ? " Some inputs lack context labels \u2014 the full extent of the merge may be wider."
        : "");

    contextMergeWarnings.push({ txid, narrative, contexts, hasUnknownContext: hasUnknown });
  }

  // ── Step 9: Degradation note ──────────────────────────────────────────────
  let degradation: AdversaryGroundTruthDegradation | null = null;
  if (ownedAddresses.length > 0) {
    if (chainTypeCoverage === 0) {
      degradation = {
        reason: "no-xpub-import",
        message:
          "No XPUB/descriptor imports found. Import wallets via XPUB or descriptor to enable " +
          "change-address detection (protective confusion analysis) and wallet-separation " +
          "verification. Manually-added addresses cannot prove separation between wallets.",
      };
    } else if (chainTypeCoverage < 0.5) {
      degradation = {
        reason: "partial-chaintype",
        message: `Only ${Math.round(chainTypeCoverage * 100)}% of your addresses have chain-type data. Protective confusion detection is partial \u2014 import more wallets via XPUB for better coverage.`,
      };
    }
  }

  // ── Step 10: Summary ──────────────────────────────────────────────────────
  const addressesExposed = new Set(
    exposureFindings.flatMap((f) => f.addresses),
  ).size;
  const addressesSeparated = new Set(
    separationFindings.flatMap((f) => f.addresses),
  ).size;

  return {
    exposureFindings,
    separationFindings,
    confusionFindings,
    contextMergeWarnings,
    summary: {
      exposureCount: exposureFindings.length,
      separationCount: separationFindings.length,
      confusionCount: confusionFindings.length,
      contextMergeCount: contextMergeWarnings.length,
      addressesExposed,
      addressesSeparated,
    },
    degradation,
    chainTypeCoverage,
  };
}

function emptyResult(): AdversaryViewResult {
  return {
    exposureFindings: [],
    separationFindings: [],
    confusionFindings: [],
    contextMergeWarnings: [],
    summary: {
      exposureCount: 0,
      separationCount: 0,
      confusionCount: 0,
      contextMergeCount: 0,
      addressesExposed: 0,
      addressesSeparated: 0,
    },
    degradation: null,
    chainTypeCoverage: 0,
  };
}
