import {
  lookupEntities,
  getActiveEntityCount,
  getActiveEntitySource,
  ENTITY_CATEGORY_LABELS,
} from "@/lib/privacy-entity-list";

export interface AmlDirectMatch {
  address: string;
  entityName: string;
  categoryLabel: string;
  sourceNote?: string;
}

export interface AmlScreeningResult {
  screeningDate: string;
  entityListSource: "bundled" | "imported";
  entityListCount: number;
  entityListImportedAt: number | null;
  entityListSourceLabel: string | null;
  screenedCount: number;
  directMatches: AmlDirectMatch[];
  nearestHopDistance: number | null;
  nearestHopEntityName: string | null;
  nearestHopCategoryLabel: string | null;
  hasGraphData: boolean;
}

export async function runAmlScreening(addresses: string[]): Promise<AmlScreeningResult> {
  const screeningDate = new Date().toISOString().slice(0, 10);
  const entityListSource = getActiveEntitySource();
  const entityListCount = getActiveEntityCount();

  const { getSettings } = await import("@/lib/data/settings-crud");
  const settings = await getSettings("default");
  const snap = (settings as any)?.entityListSnapshot as
    | { importedAt?: number; sourceLabel?: string }
    | undefined;
  const entityListImportedAt = snap?.importedAt ?? null;
  const entityListSourceLabel = snap?.sourceLabel ?? null;

  const directEntityMap = lookupEntities(addresses);
  const directMatches: AmlDirectMatch[] = [];
  for (const [addr, entry] of directEntityMap) {
    directMatches.push({
      address: addr,
      entityName: entry.name,
      categoryLabel: ENTITY_CATEGORY_LABELS[entry.category],
      sourceNote: entry.sourceNote,
    });
  }

  const { getParticipantsByAddressesWithOutpointSpends } = await import("@/lib/data/record-queries");
  const { getParticipantsByTxids } = await import("@/lib/data/transaction-crud");

  // Includes spend txs reachable only via blank-address (Electrum-synced)
  // outpoint inputs, which a pure address-keyed load would miss.
  const ownParticipants = await getParticipantsByAddressesWithOutpointSpends(addresses);

  if (ownParticipants.length === 0) {
    return {
      screeningDate,
      entityListSource,
      entityListCount,
      entityListImportedAt,
      entityListSourceLabel,
      screenedCount: addresses.length,
      directMatches,
      nearestHopDistance: null,
      nearestHopEntityName: null,
      nearestHopCategoryLabel: null,
      hasGraphData: false,
    };
  }

  const ourTxids = [...new Set(ownParticipants.map((p) => p.txid))];
  const MAX_TXIDS = 2000;
  const txidSlice = ourTxids.slice(0, MAX_TXIDS);

  const BATCH = 500;
  // Total-participant cap: 2000 txids × hundreds of participants each can
  // otherwise balloon allParts to millions of rows and freeze the UI. When the
  // cap is hit we stop loading and continue with the partial graph — a partial
  // hop-distance result is still meaningful (it can only under-report
  // proximity, never invent it).
  const MAX_TOTAL_PARTICIPANTS = 100_000;
  const allParts: typeof ownParticipants = [];
  for (let i = 0; i < txidSlice.length; i += BATCH) {
    const batch = txidSlice.slice(i, i + BATCH);
    const parts = await getParticipantsByTxids(batch);
    const remaining = MAX_TOTAL_PARTICIPANTS - allParts.length;
    if (parts.length > remaining) {
      allParts.push(...parts.slice(0, remaining));
      console.warn(
        `[aml-screening] Participant cap of ${MAX_TOTAL_PARTICIPANTS} reached ` +
          `after ${Math.min(i + BATCH, txidSlice.length)} of ${txidSlice.length} txids; ` +
          `continuing with partial graph data.`,
      );
      break;
    }
    allParts.push(...parts);
  }

  const addressToTxids = new Map<string, string[]>();
  for (const p of allParts) {
    const list = addressToTxids.get(p.address);
    if (list) list.push(p.txid);
    else addressToTxids.set(p.address, [p.txid]);
  }

  const txidToParticipants = new Map<string, typeof allParts>();
  for (const p of allParts) {
    const list = txidToParticipants.get(p.txid);
    if (list) list.push(p);
    else txidToParticipants.set(p.txid, [p]);
  }

  // Electrum-synced spend inputs carry a BLANK address (only
  // prevTxid/prevVout), so they contribute no address→txid edge above. Link
  // each such spend tx to the address that owns the spent output so the hop
  // walk can traverse through it; otherwise a spend tx whose only link to an
  // owned address is a blank-address input is unreachable in the graph.
  const outpointOwner = new Map<string, string>();
  for (const p of allParts) {
    if (p.role === "output" && p.address && p.vout !== undefined && p.vout !== null) {
      outpointOwner.set(`${p.txid}:${p.vout}`, p.address);
    }
  }
  for (const p of allParts) {
    if (p.role !== "input" || p.address || p.prevTxid === undefined) continue;
    const owner = outpointOwner.get(`${p.prevTxid}:${p.prevVout}`);
    if (!owner) continue;
    const list = addressToTxids.get(owner);
    if (list) {
      if (!list.includes(p.txid)) list.push(p.txid);
    } else {
      addressToTxids.set(owner, [p.txid]);
    }
  }

  const graphAddresses = Array.from(addressToTxids.keys());
  const entityInGraph = lookupEntities(graphAddresses);

  if (entityInGraph.size === 0) {
    return {
      screeningDate,
      entityListSource,
      entityListCount,
      entityListImportedAt,
      entityListSourceLabel,
      screenedCount: addresses.length,
      directMatches,
      nearestHopDistance: null,
      nearestHopEntityName: null,
      nearestHopCategoryLabel: null,
      hasGraphData: true,
    };
  }

  const ownedSet = new Set(addresses);
  const MAX_HOPS = 4;
  const MAX_NODES = 500;

  let globalMinHop = Infinity;
  let globalMinEntityName: string | null = null;
  let globalMinCategoryLabel: string | null = null;

  for (const startAddr of addresses) {
    if (!addressToTxids.has(startAddr)) continue;

    const visited = new Set<string>([startAddr]);
    const visitedTxids = new Set<string>();
    let frontier = [startAddr];

    for (let hop = 1; hop <= MAX_HOPS && frontier.length > 0; hop++) {
      const nextFrontier: string[] = [];
      for (const addr of frontier) {
        const txids = addressToTxids.get(addr) ?? [];
        for (const txid of txids) {
          if (visitedTxids.has(txid)) continue;
          visitedTxids.add(txid);
          const parts = txidToParticipants.get(txid) ?? [];
          for (const p of parts) {
            if (!p.address || visited.has(p.address)) continue;
            visited.add(p.address);
            const entity = entityInGraph.get(p.address);
            if (entity) {
              if (hop < globalMinHop) {
                globalMinHop = hop;
                globalMinEntityName = entity.name;
                globalMinCategoryLabel = ENTITY_CATEGORY_LABELS[entity.category];
              }
            } else if (!ownedSet.has(p.address)) {
              nextFrontier.push(p.address);
            }
          }
        }
      }
      frontier = nextFrontier;
      if (visited.size > MAX_NODES) break;
    }
  }

  return {
    screeningDate,
    entityListSource,
    entityListCount,
    entityListImportedAt,
    entityListSourceLabel,
    screenedCount: addresses.length,
    directMatches,
    nearestHopDistance: globalMinHop === Infinity ? null : globalMinHop,
    nearestHopEntityName: globalMinEntityName,
    nearestHopCategoryLabel: globalMinCategoryLabel,
    hasGraphData: true,
  };
}
