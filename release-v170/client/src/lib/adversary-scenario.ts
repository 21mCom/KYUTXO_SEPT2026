/**
 * adversary-scenario.ts
 *
 * "What if they knew?" counterparty-knowledge scenarios for the Privacy
 * Audit's Adversary View.
 *
 * A scenario names ONE counterparty (exchange, merchant, ex-employer, …) and
 * the addresses/transactions that counterparty plausibly knows are the
 * user's. Running a scenario recomputes the adversary analysis with that
 * assumed knowledge seeded in (see adversary-view.ts `AssumedKnowledge`) and
 * diffs the result against a fresh baseline run over the same address set:
 *
 *   newlyExposedAddresses — owned addresses a blind analyst could NOT link
 *     into any exposure cluster, which the informed counterparty now can.
 *   mergedClusters        — scenario clusters that collapse ≥2 previously
 *     DISTINCT baseline exposure clusters into one.
 *   brokenSeparations     — baseline preserved-separation findings (verified
 *     distinct xpub/descriptor wallets) the scenario can now connect.
 *   newContextMerges      — transactions that newly merge distinct
 *     acquisition contexts under the assumed knowledge.
 *
 * Everything runs offline against local data. The heavy DB load happens ONCE
 * (baseline context); the scenario context extends it incrementally, so large
 * vaults stay responsive and cancellation rides the same AbortSignal pattern
 * as the main audit.
 */

import { canonicalizeRecordIdentifier } from "./bitcoin";
import { getRecordsByInputStrings } from "./data/record-crud";
import { getTransactionsByTxids } from "./data/transaction-crud";
import {
  buildAdversaryContext,
  extendAdversaryContextWithAssumed,
  runAdversaryViewFromContext,
  type AdversaryViewResult,
  type AdversaryFinding,
  type AdversaryConfidence,
  type ContextMergeWarning,
  type AssumedKnowledge,
} from "./adversary-view";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ScenarioDeltaAddress {
  address: string;
  /** Carried over from the certain/likely model of the scenario run. */
  confidence: AdversaryConfidence;
}

export interface ScenarioMergedCluster {
  /** Owned addresses in the scenario cluster (the collapsed whole). */
  addresses: string[];
  confidence: AdversaryConfidence;
  /** Linking evidence txids (may be empty for knowledge-only links). */
  txids: string[];
  /** How many distinct baseline exposure clusters collapsed into this one. */
  baselineClusterCount: number;
}

export interface AdversaryScenarioDelta {
  newlyExposedAddresses: ScenarioDeltaAddress[];
  mergedClusters: ScenarioMergedCluster[];
  brokenSeparations: AdversaryFinding[];
  newContextMerges: ContextMergeWarning[];
  /**
   * Scenario exposure findings that contain at least one newly exposed
   * address — the concrete evidence behind the headline numbers.
   */
  newExposureFindings: AdversaryFinding[];
  summary: {
    /** Distinct owned addresses in baseline exposure findings. */
    baselineExposed: number;
    /** Distinct owned addresses in scenario exposure findings. */
    scenarioExposed: number;
    newlyExposedCount: number;
    mergedClusterCount: number;
    brokenSeparationCount: number;
    newContextMergeCount: number;
  };
  /** Plain-language headline (pass through renderSourceNote in the UI). */
  narrative: string;
  baseline: AdversaryViewResult;
  scenario: AdversaryViewResult;
}

export interface ScenarioRunMeta {
  counterpartyName: string;
}

// ─── Delta computation ────────────────────────────────────────────────────────

const CONFIDENCE_RANK: Record<AdversaryConfidence, number> = {
  certain: 0,
  likely: 1,
  speculative: 2,
};

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/** All address pairs co-clustered in at least one exposure finding. */
function exposurePairs(findings: AdversaryFinding[]): Set<string> {
  const pairs = new Set<string>();
  for (const f of findings) {
    for (let i = 0; i < f.addresses.length; i++) {
      for (let j = i + 1; j < f.addresses.length; j++) {
        pairs.add(pairKey(f.addresses[i], f.addresses[j]));
      }
    }
  }
  return pairs;
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * Diff a scenario adversary result against the baseline result computed over
 * the SAME address set. Pure function — exported for unit tests.
 */
export function computeScenarioDelta(
  baseline: AdversaryViewResult,
  scenario: AdversaryViewResult,
  meta: ScenarioRunMeta & { knownAddressCount: number; knownTxidCount: number },
): AdversaryScenarioDelta {
  const baselinePairs = exposurePairs(baseline.exposureFindings);
  const scenarioPairs = exposurePairs(scenario.exposureFindings);

  const baselineExposedAddrs = new Set(
    baseline.exposureFindings.flatMap((f) => f.addresses),
  );

  // Distinct addresses the scenario exposes, with their best (most certain)
  // confidence across the scenario findings that contain them.
  const confidenceByAddr = new Map<string, AdversaryConfidence>();
  const scenarioExposedAddrs = new Set<string>();
  for (const f of scenario.exposureFindings) {
    for (const a of f.addresses) {
      scenarioExposedAddrs.add(a);
      const prev = confidenceByAddr.get(a);
      if (!prev || CONFIDENCE_RANK[f.confidence] < CONFIDENCE_RANK[prev]) {
        confidenceByAddr.set(a, f.confidence);
      }
    }
  }

  const newlyExposedAddresses: ScenarioDeltaAddress[] = [];
  for (const a of scenarioExposedAddrs) {
    if (baselineExposedAddrs.has(a)) continue;
    newlyExposedAddresses.push({
      address: a,
      confidence: confidenceByAddr.get(a) ?? "likely",
    });
  }
  newlyExposedAddresses.sort(
    (x, y) =>
      CONFIDENCE_RANK[x.confidence] - CONFIDENCE_RANK[y.confidence] ||
      x.address.localeCompare(y.address),
  );
  const newlySet = new Set(newlyExposedAddresses.map((e) => e.address));

  // Baseline cluster membership: address → index of the baseline exposure
  // finding that cluster belongs to (addresses live in at most one cluster
  // per run, since clusters are a partition).
  const baselineClusterOf = new Map<string, number>();
  baseline.exposureFindings.forEach((f, idx) => {
    for (const a of f.addresses) baselineClusterOf.set(a, idx);
  });

  // Scenario clusters that collapse ≥2 DISTINCT baseline exposure clusters
  // (the "previously separate wallets now merge" case). Clusters that merely
  // absorb baseline singletons are reported via newlyExposedAddresses
  // instead, so the two numbers never double-count.
  const mergedClusters: ScenarioMergedCluster[] = [];
  for (const f of scenario.exposureFindings) {
    const baselineClusters = new Set<number>();
    for (const a of f.addresses) {
      const idx = baselineClusterOf.get(a);
      if (idx !== undefined) baselineClusters.add(idx);
    }
    if (baselineClusters.size < 2) continue;
    mergedClusters.push({
      addresses: f.addresses,
      confidence: f.confidence,
      txids: f.txids,
      baselineClusterCount: baselineClusters.size,
    });
  }

  // Baseline preserved-separation findings the scenario can now connect: at
  // least one pair of addresses from the finding is scenario-linked but was
  // NOT baseline-linked (pairs already linked in the baseline — e.g. within
  // one wallet group — don't break anything).
  const brokenSeparations = baseline.separationFindings.filter((sep) => {
    const addrs = sep.addresses;
    for (let i = 0; i < addrs.length; i++) {
      for (let j = i + 1; j < addrs.length; j++) {
        const key = pairKey(addrs[i], addrs[j]);
        if (!baselinePairs.has(key) && scenarioPairs.has(key)) return true;
      }
    }
    return false;
  });

  const baselineMergeTxids = new Set(
    baseline.contextMergeWarnings.map((w) => w.txid),
  );
  const newContextMerges = scenario.contextMergeWarnings.filter(
    (w) => !baselineMergeTxids.has(w.txid),
  );

  const newExposureFindings = scenario.exposureFindings.filter((f) =>
    f.addresses.some((a) => newlySet.has(a)),
  );

  const summary = {
    baselineExposed: baselineExposedAddrs.size,
    scenarioExposed: scenarioExposedAddrs.size,
    newlyExposedCount: newlyExposedAddresses.length,
    mergedClusterCount: mergedClusters.length,
    brokenSeparationCount: brokenSeparations.length,
    newContextMergeCount: newContextMerges.length,
  };

  // ── Plain-language headline ─────────────────────────────────────────────
  const cp = meta.counterpartyName.trim() || "this counterparty";
  const knowledgeParts: string[] = [];
  if (meta.knownAddressCount > 0) {
    knowledgeParts.push(
      `${meta.knownAddressCount} ${plural(meta.knownAddressCount, "address", "addresses")}`,
    );
  }
  if (meta.knownTxidCount > 0) {
    knowledgeParts.push(
      `${meta.knownTxidCount} ${plural(meta.knownTxidCount, "transaction")}`,
    );
  }
  const knowledge =
    knowledgeParts.length > 0 ? knowledgeParts.join(" and ") : "this knowledge";

  let narrative: string;
  if (
    summary.newlyExposedCount === 0 &&
    summary.mergedClusterCount === 0 &&
    summary.brokenSeparationCount === 0 &&
    summary.newContextMergeCount === 0
  ) {
    narrative =
      `Knowing ${knowledge} does not let ${cp} connect any more of your ` +
      `addresses beyond what a blind chain analyst already sees.`;
  } else {
    const sentences: string[] = [];
    if (summary.newlyExposedCount > 0) {
      const certainCount = newlyExposedAddresses.filter(
        (e) => e.confidence === "certain",
      ).length;
      const likelyCount = summary.newlyExposedCount - certainCount;
      const confidenceNote =
        certainCount > 0 && likelyCount > 0
          ? ` — ${certainCount} with certainty, ${likelyCount} with high likelihood`
          : likelyCount > 0
            ? " with high likelihood"
            : " with certainty";
      sentences.push(
        `Knowing ${knowledge} lets ${cp} connect ` +
          `${summary.newlyExposedCount} more of your ${plural(summary.newlyExposedCount, "address", "addresses")}${confidenceNote}.`,
      );
    } else {
      sentences.push(
        `Knowing ${knowledge} does not expose additional addresses to ${cp}, but it strengthens what they can already see.`,
      );
    }
    if (summary.mergedClusterCount > 0) {
      sentences.push(
        `${summary.mergedClusterCount} previously separate address ${plural(summary.mergedClusterCount, "cluster")} ` +
          `collapse${summary.mergedClusterCount === 1 ? "s" : ""} into one wallet in their analysis.`,
      );
    }
    if (summary.brokenSeparationCount > 0) {
      sentences.push(
        `The on-chain separation of ${summary.brokenSeparationCount} verified wallet ` +
          `${plural(summary.brokenSeparationCount, "pair")} — invisible to a blind analyst — is now broken.`,
      );
    }
    if (summary.newContextMergeCount > 0) {
      sentences.push(
        `${summary.newContextMergeCount} ${plural(summary.newContextMergeCount, "transaction")} now publicly ` +
          `${summary.newContextMergeCount === 1 ? "merges" : "merge"} distinct acquisition contexts.`,
      );
    }
    narrative = sentences.join(" ");
  }

  return {
    newlyExposedAddresses,
    mergedClusters,
    brokenSeparations,
    newContextMerges,
    newExposureFindings,
    summary,
    narrative,
    baseline,
    scenario,
  };
}

// ─── Saved-reference resolution ───────────────────────────────────────────────

export interface ScenarioReferenceResolution {
  /** Saved assumed addresses that no longer match any vault record. */
  unresolvedAddresses: string[];
  /** Saved assumed txids that no longer match any synced transaction. */
  unresolvedTxids: string[];
  /** Total unresolved references (addresses + txids). */
  unresolvedCount: number;
}

/**
 * Check which of a saved scenario's assumed references still resolve against
 * the vault: addresses against records (any type — exact identifier match),
 * txids against synced blockchain transactions. Purely informational — a
 * scenario always runs with whatever the analysis can still find; this only
 * explains why the numbers may understate the saved assumption set.
 *
 * Lookup keys are canonicalized the same way the CRUD write paths store them
 * (trim; lowercase bech32/txid), so a saved reference never counts as
 * "missing" merely because of casing/whitespace differences.
 */
export async function resolveScenarioReferences(refs: {
  knownAddresses: string[];
  knownTxids: string[];
}): Promise<ScenarioReferenceResolution> {
  const unresolvedAddresses: string[] = [];
  const unresolvedTxids: string[] = [];

  if (refs.knownAddresses.length > 0) {
    const found = await getRecordsByInputStrings(refs.knownAddresses);
    const foundSet = new Set(found.map((r) => r.inputString));
    for (const addr of refs.knownAddresses) {
      if (!foundSet.has(canonicalizeRecordIdentifier(addr))) {
        unresolvedAddresses.push(addr);
      }
    }
  }

  if (refs.knownTxids.length > 0) {
    const canonicalTxids = refs.knownTxids.map((t) =>
      canonicalizeRecordIdentifier(t),
    );
    const found = await getTransactionsByTxids(canonicalTxids);
    const foundSet = new Set(found.map((t) => t.txid));
    for (let i = 0; i < refs.knownTxids.length; i++) {
      if (!foundSet.has(canonicalTxids[i])) {
        unresolvedTxids.push(refs.knownTxids[i]);
      }
    }
  }

  return {
    unresolvedAddresses,
    unresolvedTxids,
    unresolvedCount: unresolvedAddresses.length + unresolvedTxids.length,
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

/**
 * Run a "what if they knew?" scenario: compute a fresh baseline adversary
 * view over `userAddresses`, extend the same context with the assumed
 * knowledge, recompute, and diff.
 *
 * The baseline is recomputed (rather than reusing the page's cached result)
 * so the delta is always internally consistent — same address set, same data
 * snapshot, same code path. The heavy participant load happens once; the
 * scenario context extends it incrementally.
 */
export async function runAdversaryScenario(
  userAddresses: string[],
  assumed: AssumedKnowledge,
  meta: ScenarioRunMeta,
  report?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<AdversaryScenarioDelta> {
  const progress = (msg: string) => {
    if (!signal?.aborted) report?.(msg);
  };

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  progress("Scenario: building baseline adversary view…");
  const baseCtx = await buildAdversaryContext(userAddresses, progress, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const baseline = await runAdversaryViewFromContext(baseCtx, progress);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  progress("Scenario: applying assumed counterparty knowledge…");
  const scenarioCtx = await extendAdversaryContextWithAssumed(
    baseCtx,
    assumed,
    progress,
    signal,
  );
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const scenario = await runAdversaryViewFromContext(scenarioCtx, progress);

  return computeScenarioDelta(baseline, scenario, {
    counterpartyName: meta.counterpartyName,
    knownAddressCount: assumed.knownAddresses.length,
    knownTxidCount: assumed.knownTxids.length,
  });
}
