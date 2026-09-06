import { UNASSIGNED_OWNER_VALUE } from "./owner-constants";

export const UNKNOWN_ORIGIN_ID = "unknown";

export type OriginBoundary = "deterministic" | "unknown" | "mixed";
export type OriginEventKind = "acquisition" | "transfer" | "consolidation" | "partial-spend" | "coinjoin" | "mixed";

export interface CoinOriginTransaction {
  txid: string;
  blockHeight?: number | null;
  blockTime?: number | null;
  fee?: number | null;
  acquisitionMethod?: string | null;
  /** User-entered transaction cost, never an inferred tax basis. */
  costBasisUsd?: number | null;
}

export interface CoinOriginParticipant {
  id?: number;
  txid: string;
  role: "input" | "output";
  address?: string | null;
  amount: number;
  vout?: number | null;
  prevTxid?: string | null;
  prevVout?: number | null;
}

export interface CoinOriginAddress {
  inputString: string;
  type?: string | null;
  addressImportance?: string | null;
  walletName?: string | null;
  owner?: string | null;
  seedName?: string | null;
  label?: string | null;
}

export interface OriginAllocation {
  lotId: string;
  sats: number;
}

export interface CoinOriginLot {
  lotId: string;
  acquiredTxid: string;
  acquiredVout: number;
  acquiredAt: number;
  acquiredSats: number;
  /** Upstream certainty at the point custody began. */
  sourceBoundary: OriginBoundary;
  address: string;
  walletName?: string | null;
  owner?: string | null;
  label?: string | null;
  acquisitionMethod?: string | null;
  costBasisUsd?: number | null;
  costProvenance: "provided" | "unknown";
}

export interface CoinOriginOutpoint {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  allocations: OriginAllocation[];
  /** Ordered transaction path used by the Coin Passport timeline. */
  hopTxids: string[];
  boundary: OriginBoundary;
  walletName?: string | null;
  owner?: string | null;
  /** A CoinJoin intentionally terminates recipe attribution at this output. */
  preMixTxids?: string[];
}

export interface CoinOriginDisposal {
  txid: string;
  vout?: number;
  kind: "external" | "fee";
  sats: number;
  allocations: OriginAllocation[];
  boundary: OriginBoundary;
}

export interface CoinOriginHop {
  txid: string;
  blockHeight: number;
  blockTime: number;
  inputSats: number;
  outputSats: number;
  feeSats: number;
  inputCount: number;
  outputCount: number;
  kind: OriginEventKind;
  boundary: OriginBoundary;
  unknownInputSats: number;
  ownedOutputSats: number;
  reconciled: boolean;
  /** Signed input minus output minus allocated fee; zero is exact. */
  residualSats: number;
}

export interface CoinOriginHolding {
  lotId: string;
  label: string;
  acquiredTxid?: string;
  acquiredVout?: number;
  acquiredAt?: number;
  sats: number;
  outpointCount: number;
  boundary: OriginBoundary;
  walletName?: string | null;
  owner?: string | null;
  ownerMixed?: boolean;
  costProvenance?: "provided" | "unknown" | "mixed";
}

export interface CoinOriginsSummary {
  currentSats: number;
  allocatedSats: number;
  knownSats: number;
  unknownSats: number;
  disposedSats: number;
  feeSats: number;
  acquisitionSats: number;
  reconciled: boolean;
}

export interface CoinOriginsLedger {
  version: 1;
  outpoints: CoinOriginOutpoint[];
  lots: CoinOriginLot[];
  disposals: CoinOriginDisposal[];
  hops: CoinOriginHop[];
  holdings: CoinOriginHolding[];
  summary: CoinOriginsSummary;
}

/**
 * A bounded view over a ledger. The native engine uses this shape for normal
 * screen reads so a broad wallet never crosses the renderer IPC boundary as one
 * large array. `fingerprint` identifies the source snapshot used to derive the
 * view; it is not a replacement for the engine freshness gate.
 */
export interface CoinOriginsPage {
  version: 1;
  fingerprint: string;
  checkpointKey: string;
  holdings: CoinOriginHolding[];
  outpoints: CoinOriginOutpoint[];
  summary: CoinOriginsSummary;
  holdingsOffset: number;
  outpointsOffset: number;
  holdingsTotal: number;
  outpointsTotal: number;
  lotsTotal: number;
  holdingsHasMore: boolean;
  outpointsHasMore: boolean;
  /** Present only for an explicitly requested passport detail. */
  detail?: {
    lots: CoinOriginLot[];
    hops: CoinOriginHop[];
    allocationsOffset: number;
    allocationsTotal: number;
    allocationsHasMore: boolean;
    hopsOffset: number;
    hopsTotal: number;
    hopsHasMore: boolean;
  };
}

export interface CoinOriginsInput {
  transactions: CoinOriginTransaction[];
  participants: CoinOriginParticipant[];
  addresses: CoinOriginAddress[];
  walletName?: string;
}

const OWNED_TIERS = new Set(["verified", "manual", "wallet-import", "xpub-derived"]);

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function unix(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function lotId(txid: string, vout: number): string {
  return `lot:${txid}:${vout}`;
}

function sortedTransactions(transactions: CoinOriginTransaction[]): CoinOriginTransaction[] {
  return [...transactions].sort((a, b) =>
    (unix(a.blockHeight) || Number.MAX_SAFE_INTEGER) - (unix(b.blockHeight) || Number.MAX_SAFE_INTEGER) ||
    unix(a.blockTime) - unix(b.blockTime) ||
    a.txid.localeCompare(b.txid),
  );
}

function addToMap(target: Map<string, number>, key: string, sats: number): void {
  if (sats <= 0) return;
  target.set(key, (target.get(key) ?? 0) + sats);
}

function mapTotal(map: Map<string, number>): number {
  let total = 0;
  for (const sats of map.values()) total += sats;
  return total;
}

function mapToAllocations(map: Map<string, number>): OriginAllocation[] {
  return [...map.entries()]
    .filter(([, sats]) => sats > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lotId, sats]) => ({ lotId, sats }));
}

/** Take exactly `wanted` sats in stable lot-id order, topping up as UNKNOWN. */
function take(map: Map<string, number>, wanted: number): Map<string, number> {
  const result = new Map<string, number>();
  let remaining = wanted;
  for (const key of [...map.keys()].sort()) {
    if (remaining <= 0) break;
    const available = map.get(key) ?? 0;
    const used = Math.min(available, remaining);
    if (used > 0) {
      addToMap(result, key, used);
      map.set(key, available - used);
      remaining -= used;
    }
  }
  if (remaining > 0) addToMap(result, UNKNOWN_ORIGIN_ID, remaining);
  return result;
}

function boundaryFor(map: Map<string, number>, lotBoundaries: Map<string, OriginBoundary>): OriginBoundary {
  let hasUnknown = false;
  let hasKnown = false;
  for (const [key, sats] of map) {
    if (sats <= 0) continue;
    const certainty = key === UNKNOWN_ORIGIN_ID ? "unknown" : (lotBoundaries.get(key) ?? "unknown");
    if (certainty === "mixed") {
      hasKnown = true;
      hasUnknown = true;
    } else if (certainty === "unknown") {
      hasUnknown = true;
    } else {
      hasKnown = true;
    }
  }
  return hasUnknown && hasKnown ? "mixed" : hasUnknown ? "unknown" : "deterministic";
}

function cloneMap(map: Map<string, number>): Map<string, number> {
  return new Map(map);
}

function eventKind(inputCount: number, outputCount: number, ownedOutputSats: number, inputSats: number, boundary: OriginBoundary, coinjoin: boolean): OriginEventKind {
  if (coinjoin) return "coinjoin";
  if (boundary !== "deterministic") return "mixed";
  if (inputCount === 0) return "acquisition";
  if (inputCount > 1 && outputCount < inputCount) return "consolidation";
  if (ownedOutputSats > 0 && ownedOutputSats < inputSats) return "partial-spend";
  return "transfer";
}

/**
 * Conservative CoinJoin detection.
 *
 * Equal outputs alone are not enough: an ordinary payment can equal its change.
 * Require a useful anonymity set and both a controlled and unresolved input.
 */
function isCoinjoin(
  inputs: CoinOriginParticipant[],
  outputs: CoinOriginParticipant[],
  knownInputSats: number,
  unknownInputSats: number,
): boolean {
  if (inputs.length < 3 || outputs.length < 3 || knownInputSats <= 0 || unknownInputSats <= 0) return false;
  const amounts = new Map<number, number>();
  for (const output of outputs) {
    const amount = int(output.amount);
    if (amount > 0) amounts.set(amount, (amounts.get(amount) ?? 0) + 1);
  }
  return [...amounts.values()].some((count) => count >= 3);
}

interface AncestryNode {
  txid: string;
  parents: AncestryNode[];
}

function flattenAncestry(node: AncestryNode, txOrder: Map<string, number>): string[] {
  const seen = new Set<string>();
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.txid)) continue;
    seen.add(current.txid);
    stack.push(...current.parents);
  }
  return [...seen].sort((a, b) => (txOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (txOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
}

function isOwned(record: CoinOriginAddress | undefined): boolean {
  return !!record && (record.addressImportance == null || OWNED_TIERS.has(record.addressImportance));
}

/**
 * Build a complete ledger from a snapshot of the three source tables.
 * Every output amount is allocated exactly once. Invalid/missing values are
 * represented as zero/UNKNOWN; they are never silently assigned to a lot.
 */
export function calculateCoinOrigins(input: CoinOriginsInput): CoinOriginsLedger {
  const addressByValue = new Map<string, CoinOriginAddress>();
  for (const address of input.addresses) {
    if (address.inputString && isOwned(address)) addressByValue.set(address.inputString, address);
  }
  const transactions = sortedTransactions(input.transactions);
  const txOrder = new Map(transactions.map((tx, index) => [tx.txid, index]));
  const txById = new Map(transactions.map((tx) => [tx.txid, tx]));
  const partsByTxid = new Map<string, { inputs: CoinOriginParticipant[]; outputs: CoinOriginParticipant[] }>();
  for (const p of input.participants) {
    const group = partsByTxid.get(p.txid) ?? { inputs: [], outputs: [] };
    (p.role === "input" ? group.inputs : group.outputs).push(p);
    partsByTxid.set(p.txid, group);
  }
  for (const group of partsByTxid.values()) {
    group.inputs.sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || (a.prevVout ?? -1) - (b.prevVout ?? -1));
    group.outputs.sort((a, b) => (a.vout ?? Number.MAX_SAFE_INTEGER) - (b.vout ?? Number.MAX_SAFE_INTEGER) || (a.id ?? 0) - (b.id ?? 0));
  }

  const outputCompositions = new Map<string, Map<string, number>>();
  const outputAncestry = new Map<string, AncestryNode>();
  const spent = new Set<string>();
  const outpoints: CoinOriginOutpoint[] = [];
  const lots: CoinOriginLot[] = [];
  const lotBoundaries = new Map<string, OriginBoundary>();
  const disposals: CoinOriginDisposal[] = [];
  const hops: CoinOriginHop[] = [];
  let acquisitionSats = 0;

  // Mark exact spends first. A missing prevout does not authorize guessing which
  // output was spent (especially important for Electrum inputs without address).
  for (const p of input.participants) {
    if (p.role === "input" && p.prevTxid && p.prevVout != null) spent.add(outpointKey(p.prevTxid, p.prevVout));
  }

  for (const tx of transactions) {
    const group = partsByTxid.get(tx.txid) ?? { inputs: [], outputs: [] };
    const txOutputs = group.outputs;
    const txInputSats = group.inputs.reduce((sum, p) => sum + int(p.amount), 0);
    const txOutputSats = txOutputs.reduce((sum, p) => sum + int(p.amount), 0);
    const pool = new Map<string, number>();
    const inputComposition = new Map<string, number>();
    let unknownInputSats = 0;
    let knownInputSats = 0;
    const alreadyConsumed = new Set<string>();
    const ancestryParents: AncestryNode[] = [];
    const ancestrySeen = new Set<AncestryNode>();
    let coinjoin = false;

    for (const p of group.inputs) {
      const amount = int(p.amount);
      const key = p.prevTxid && p.prevVout != null ? outpointKey(p.prevTxid, p.prevVout) : null;
      const source = key ? outputCompositions.get(key) : undefined;
      if (source && !alreadyConsumed.has(key!)) {
        alreadyConsumed.add(key!);
        const ancestor = outputAncestry.get(key!);
        if (ancestor && !ancestrySeen.has(ancestor)) {
          ancestrySeen.add(ancestor);
          ancestryParents.push(ancestor);
        }
        const sourceAmount = mapTotal(source);
        const taken = take(cloneMap(source), Math.min(amount || sourceAmount, sourceAmount));
        for (const [lot, sats] of taken) {
          addToMap(pool, lot, sats);
          addToMap(inputComposition, lot, sats);
        }
        const remainder = amount - mapTotal(taken);
        if (remainder > 0) {
          addToMap(pool, UNKNOWN_ORIGIN_ID, remainder);
          addToMap(inputComposition, UNKNOWN_ORIGIN_ID, remainder);
          unknownInputSats += remainder;
        }
        knownInputSats += mapTotal(taken);
      } else {
        addToMap(pool, UNKNOWN_ORIGIN_ID, amount);
        addToMap(inputComposition, UNKNOWN_ORIGIN_ID, amount);
        unknownInputSats += amount;
      }
    }
    coinjoin = isCoinjoin(group.inputs, txOutputs, knownInputSats, unknownInputSats);

    const declaredFee = int(tx.fee);
    // The transaction's actual conservation identity wins over an absent or
    // inconsistent API fee field. This is still integer-only.
    const feeSats = txInputSats >= txOutputSats ? txInputSats - txOutputSats : 0;
    const feeAllocation = take(pool, feeSats);
    // An incoming acquisition can include the sender's fee. It is visible on
    // the hop, but it is not a disposal from this wallet unless at least one
    // known owned input contributed to the transaction.
    if (feeSats > 0 && knownInputSats > 0) {
      disposals.push({
        txid: tx.txid,
        kind: "fee",
        sats: feeSats,
        allocations: mapToAllocations(feeAllocation),
        boundary: boundaryFor(feeAllocation, lotBoundaries),
      });
    }

    let ownedOutputSats = 0;
    for (const output of txOutputs) {
      const amount = int(output.amount);
      const address = output.address ?? "";
      const record = addressByValue.get(address);
      const owned = !!record;
      const vout = output.vout == null ? 0 : Math.max(0, Math.trunc(output.vout));
      let composition: Map<string, number>;
      const startsCustody = owned && (group.inputs.length === 0 || knownInputSats === 0);
      let acquisitionBoundary: OriginBoundary | null = null;
      if (startsCustody) {
        const id = lotId(tx.txid, vout);
        composition = new Map([[id, amount]]);
        acquisitionBoundary = group.inputs.length === 0 ? "deterministic" : "unknown";
        const lot: CoinOriginLot = {
          lotId: id,
          acquiredTxid: tx.txid,
          acquiredVout: vout,
          acquiredAt: unix(tx.blockTime),
          acquiredSats: amount,
          sourceBoundary: acquisitionBoundary,
          address,
          walletName: record?.walletName ?? null,
          owner: record?.owner ?? null,
          label: record?.label ?? null,
          acquisitionMethod: tx.acquisitionMethod ?? null,
          costBasisUsd: Number.isFinite(tx.costBasisUsd) ? tx.costBasisUsd! : null,
          costProvenance: Number.isFinite(tx.costBasisUsd) ? "provided" : "unknown",
        };
        lots.push(lot);
        lotBoundaries.set(id, acquisitionBoundary);
        acquisitionSats += amount;
      } else {
        composition = take(pool, amount);
        // Equal-denomination collaborative transactions cannot honestly map an
        // owned output to one of the contributed recipes. Preserve the earlier
        // history on the hop, but put a visible UNKNOWN boundary at the mix.
        if (coinjoin && owned) composition = new Map([[UNKNOWN_ORIGIN_ID, amount]]);
      }
      const boundary = acquisitionBoundary ?? boundaryFor(composition, lotBoundaries);
      const allocations = mapToAllocations(composition);
      if (owned) {
        ownedOutputSats += amount;
        outputCompositions.set(outpointKey(tx.txid, vout), composition);
        const ancestryNode: AncestryNode = { txid: tx.txid, parents: ancestryParents };
        outputAncestry.set(outpointKey(tx.txid, vout), ancestryNode);
        if (!spent.has(outpointKey(tx.txid, vout))) {
          outpoints.push({
            txid: tx.txid,
            vout,
            address,
            amountSats: amount,
            allocations,
            hopTxids: flattenAncestry(ancestryNode, txOrder),
            boundary,
            walletName: record?.walletName ?? null,
            owner: record?.owner ?? null,
            preMixTxids: coinjoin ? flattenAncestry(ancestryNode, txOrder).filter((id) => id !== tx.txid) : undefined,
          });
        }
      } else if (amount > 0 && knownInputSats > 0) {
        disposals.push({
          txid: tx.txid,
          vout,
          kind: "external",
          sats: amount,
          allocations,
          boundary: boundaryFor(composition, lotBoundaries),
        });
      }
    }

    const txBoundary = group.inputs.length === 0
      ? "deterministic"
      : boundaryFor(inputComposition, lotBoundaries);
    const residualSats = group.inputs.length === 0 ? 0 : txInputSats - txOutputSats - feeSats;
    hops.push({
      txid: tx.txid,
      blockHeight: unix(tx.blockHeight),
      blockTime: unix(tx.blockTime),
      inputSats: txInputSats,
      outputSats: txOutputSats,
      // Keep declaredFee available in debugging by using it only when it is
      // consistent; the reconciled fee is what the ledger displays.
      feeSats: feeSats >= 0 ? feeSats : declaredFee,
      inputCount: group.inputs.length,
      outputCount: txOutputs.length,
       kind: eventKind(group.inputs.length, txOutputs.length, ownedOutputSats, txInputSats, txBoundary, coinjoin),
       boundary: coinjoin ? "unknown" : txBoundary,
      unknownInputSats,
      ownedOutputSats,
      reconciled: residualSats === 0,
      residualSats,
    });
  }

  outpoints.sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
  const holdingMap = new Map<string, { sats: number; outpoints: number; boundary: OriginBoundary; wallets: Set<string>; owners: Set<string> }>();
  for (const output of outpoints) {
    for (const allocation of output.allocations) {
      const row = holdingMap.get(allocation.lotId) ?? { sats: 0, outpoints: 0, boundary: "deterministic" as OriginBoundary, wallets: new Set(), owners: new Set() };
      row.sats += allocation.sats;
      row.outpoints += 1;
      if (output.boundary === "mixed" || row.boundary === "mixed") row.boundary = "mixed";
      else if (output.boundary === "unknown" || row.boundary === "unknown") row.boundary = "unknown";
      if (output.walletName) row.wallets.add(output.walletName);
      if (output.owner?.trim()) row.owners.add(output.owner.trim());
      holdingMap.set(allocation.lotId, row);
    }
  }
  const lotById = new Map(lots.map((lot) => [lot.lotId, lot]));
  const holdings = [...holdingMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, row]) => {
    const lot = lotById.get(id);
    return {
      lotId: id,
      label: id === UNKNOWN_ORIGIN_ID ? "Unknown origin" : lot?.label || `${lot?.acquiredTxid.slice(0, 10) ?? "Unknown"}:${lot?.acquiredVout ?? ""}`,
      acquiredTxid: lot?.acquiredTxid,
      acquiredVout: lot?.acquiredVout,
      acquiredAt: lot?.acquiredAt,
      sats: row.sats,
      outpointCount: row.outpoints,
      boundary: row.boundary,
      walletName: row.wallets.size === 1 ? [...row.wallets][0] : null,
      owner: row.owners.size === 1 ? [...row.owners][0] : null,
      ownerMixed: row.owners.size > 1,
      costProvenance: id === UNKNOWN_ORIGIN_ID ? "unknown" : lot?.costProvenance ?? "unknown",
    };
  });
  const currentSats = outpoints.reduce((sum, row) => sum + row.amountSats, 0);
  const allocatedSats = outpoints.reduce((sum, row) => sum + row.allocations.reduce((s, a) => s + a.sats, 0), 0);
  const unknownSats = outpoints.reduce(
    (sum, row) => sum + row.allocations.reduce(
      (allocationSum, allocation) =>
        allocationSum + (
          allocation.lotId === UNKNOWN_ORIGIN_ID ||
          (lotBoundaries.get(allocation.lotId) ?? "unknown") !== "deterministic"
            ? allocation.sats
            : 0
        ),
      0,
    ),
    0,
  );
  const disposedSats = disposals.filter((d) => d.kind === "external").reduce((sum, d) => sum + d.sats, 0);
  const feeSats = disposals.filter((d) => d.kind === "fee").reduce((sum, d) => sum + d.sats, 0);

  return {
    version: 1,
    outpoints,
    lots,
    disposals,
    hops,
    holdings,
    summary: {
      currentSats,
      allocatedSats,
      knownSats: allocatedSats - unknownSats,
      unknownSats,
      disposedSats,
      feeSats,
      acquisitionSats,
      // For every currently-held output the allocation is exactly its output
      // amount. Historical tx identities are separately reconciled per hop.
      reconciled:
        hops.every((hop) => hop.reconciled) &&
        outpoints.every((row) => row.amountSats === row.allocations.reduce((s, a) => s + a.sats, 0)),
    },
  };
}

export interface CoinOriginsScope {
  walletName?: string;
  /** Empty string selects records with no assigned owner. */
  owner?: string;
}

export interface CoinOriginsPageOptions extends CoinOriginsScope {
  holdingsOffset?: number;
  outpointsOffset?: number;
  allocationsOffset?: number;
  hopsOffset?: number;
  limit?: number;
  outpoint?: string;
}

export function filterCoinOrigins(ledger: CoinOriginsLedger, scope: CoinOriginsScope = {}): CoinOriginsLedger {
  if (!scope.walletName && scope.owner === undefined) return ledger;
  const owner = scope.owner?.trim() ?? undefined;
  const keep = new Set(ledger.outpoints.filter((o) =>
    (!scope.walletName || o.walletName === scope.walletName) &&
    (owner === undefined || (owner === "" ? !o.owner?.trim() : o.owner?.trim() === owner)),
  ).map((o) => outpointKey(o.txid, o.vout)));
  const outpoints = ledger.outpoints.filter((o) => keep.has(outpointKey(o.txid, o.vout)));
  const scopedLotIds = new Set(
    outpoints.flatMap((output) => output.allocations.map((allocation) => allocation.lotId))
      .filter((id) => id !== UNKNOWN_ORIGIN_ID),
  );
  const lots = ledger.lots.filter((lot) => scopedLotIds.has(lot.lotId));
  const holdingMap = new Map<string, { sats: number; count: number; boundary: OriginBoundary }>();
  for (const output of outpoints) for (const allocation of output.allocations) {
    const row = holdingMap.get(allocation.lotId) ?? { sats: 0, count: 0, boundary: "deterministic" as OriginBoundary };
    row.sats += allocation.sats;
    row.count += 1;
    row.boundary = row.boundary === "mixed" || output.boundary === "mixed" ? "mixed" : row.boundary === "unknown" || output.boundary === "unknown" ? "unknown" : "deterministic";
    holdingMap.set(allocation.lotId, row);
  }
  const lotById = new Map(ledger.lots.map((l) => [l.lotId, l]));
  const holdings = [...holdingMap.entries()].map(([id, row]) => {
    const lot = lotById.get(id);
    return { lotId: id, label: id === UNKNOWN_ORIGIN_ID ? "Unknown origin" : lot?.label || id, acquiredTxid: lot?.acquiredTxid, acquiredVout: lot?.acquiredVout, acquiredAt: lot?.acquiredAt, sats: row.sats, outpointCount: row.count, boundary: row.boundary };
  }).sort((a, b) => a.lotId.localeCompare(b.lotId));
  const currentSats = outpoints.reduce((s, o) => s + o.amountSats, 0);
  const scopedLotBoundaries = new Map(ledger.lots.map((lot) => [lot.lotId, lot.sourceBoundary]));
  const unknownSats = outpoints.reduce(
    (sum, output) => sum + output.allocations.reduce(
      (allocationSum, allocation) =>
        allocationSum + (
          allocation.lotId === UNKNOWN_ORIGIN_ID ||
          (scopedLotBoundaries.get(allocation.lotId) ?? "unknown") !== "deterministic"
            ? allocation.sats
            : 0
        ),
      0,
    ),
    0,
  );
  return {
    ...ledger,
    outpoints,
    lots,
    holdings,
    summary: {
      currentSats,
      allocatedSats: currentSats,
      knownSats: currentSats - unknownSats,
      unknownSats,
      disposedSats: 0,
      feeSats: 0,
      acquisitionSats: currentSats,
      reconciled:
        ledger.hops.every((hop) => hop.reconciled) &&
        outpoints.every((o) => o.amountSats === o.allocations.reduce((s, a) => s + a.sats, 0)),
    },
  };
}

/** Backward-compatible wallet-only facade for existing callers. */
export function filterCoinOriginsByWallet(ledger: CoinOriginsLedger, walletName?: string): CoinOriginsLedger {
  return filterCoinOrigins(ledger, { walletName });
}

/** Owner counterpart to wallet scoping; empty selection deliberately means all. */
export function filterCoinOriginsByOwner(ledger: CoinOriginsLedger, owners?: string[]): CoinOriginsLedger {
  if (!owners?.length) return ledger;
  const keep = new Set(ledger.outpoints
    .filter((outpoint) => owners.includes(outpoint.owner?.trim() || UNASSIGNED_OWNER_VALUE))
    .map((outpoint) => outpointKey(outpoint.txid, outpoint.vout)));
  // Reuse the wallet scoping reducer by presenting each kept outpoint under a
  // unique temporary wallet key; this retains allocation/summary invariants.
  const token = '__owner_scope__';
  return filterCoinOriginsByWallet({
    ...ledger,
    outpoints: ledger.outpoints.map(outpoint =>
      keep.has(outpointKey(outpoint.txid, outpoint.vout)) ? { ...outpoint, walletName: token } : outpoint),
  }, token);
}

/** Build the same bounded renderer payload used by the native worker. */
export function pageCoinOriginsLedger(
  source: CoinOriginsLedger,
  checkpointKey: string,
  opts: CoinOriginsPageOptions = {},
): CoinOriginsPage {
  const ledger = filterCoinOrigins(source, opts);
  const limit = Math.min(250, Math.max(1, Math.trunc(opts.limit ?? 100)));
  const holdingsOffset = Math.max(0, Math.trunc(opts.holdingsOffset ?? 0));
  const outpointsOffset = Math.max(0, Math.trunc(opts.outpointsOffset ?? 0));
  const allocationsOffset = Math.max(0, Math.trunc(opts.allocationsOffset ?? 0));
  const hopsOffset = Math.max(0, Math.trunc(opts.hopsOffset ?? 0));
  const detailOutpoint = opts.outpoint
    ? ledger.outpoints.find((row) => `${row.txid}:${row.vout}` === opts.outpoint)
    : undefined;
  const detailAllocations = detailOutpoint?.allocations.slice(allocationsOffset, allocationsOffset + limit);
  const detailHopTxids = detailOutpoint?.hopTxids.slice(hopsOffset, hopsOffset + limit);
  const outpoints = detailOutpoint
    ? [{ ...detailOutpoint, allocations: detailAllocations!, hopTxids: detailHopTxids! }]
    : ledger.outpoints
      .slice(outpointsOffset, outpointsOffset + limit)
      .map((row) => ({ ...row, allocations: [], hopTxids: [] }));
  const detailLotIds = detailOutpoint
    ? new Set(detailAllocations!.map((allocation) => allocation.lotId))
    : undefined;
  const holdings = detailLotIds
    ? ledger.holdings.filter((holding) => detailLotIds.has(holding.lotId))
    : ledger.holdings.slice(holdingsOffset, holdingsOffset + limit);
  const result: CoinOriginsPage = {
    version: 1,
    fingerprint: checkpointKey,
    checkpointKey,
    holdings,
    outpoints,
    summary: ledger.summary,
    holdingsOffset,
    outpointsOffset,
    holdingsTotal: ledger.holdings.length,
    outpointsTotal: ledger.outpoints.length,
    lotsTotal: ledger.lots.length,
    holdingsHasMore: holdingsOffset + holdings.length < ledger.holdings.length,
    outpointsHasMore: outpointsOffset + outpoints.length < ledger.outpoints.length,
  };
  if (detailOutpoint) {
    const hopIds = new Set(detailHopTxids);
    result.detail = {
      lots: ledger.lots.filter((lot) => detailLotIds!.has(lot.lotId)),
      hops: ledger.hops.filter((hop) => hopIds.has(hop.txid)),
      allocationsOffset,
      allocationsTotal: detailOutpoint.allocations.length,
      allocationsHasMore: allocationsOffset + detailAllocations!.length < detailOutpoint.allocations.length,
      hopsOffset,
      hopsTotal: detailOutpoint.hopTxids.length,
      hopsHasMore: hopsOffset + detailHopTxids!.length < detailOutpoint.hopTxids.length,
    };
  }
  return result;
}
