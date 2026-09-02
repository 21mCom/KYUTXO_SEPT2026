// Dense-graph regression coverage for buildNetworkGraph. A real user vault
// with ~2.5k addresses produced ~3.1M edges (94% of a complete graph) and the
// page hung forever on "Laying out graph...": the graph builder expanded EVERY
// transaction into a complete address-pair clique, so a few huge
// consolidation/CoinJoin transactions generated millions of near-meaningless
// edges, and there was no edge-count guard. These tests pin the three
// defences: the per-transaction clique bound, the hard edge-count guard, and
// deterministic weight-based pruning of what reaches layout/render.

import { describe, it, expect } from "vitest";
import {
  buildNetworkGraph,
  selectLayoutEdges,
  MAX_NODES,
  MAX_EDGES,
  MAX_LAYOUT_EDGES,
  MAX_TX_CLIQUE_ADDRESSES,
  type GraphEdge,
} from "./network-analysis";
import type { Record as KRecord, TransactionParticipant } from "./db-types";

// Deterministic pseudo-random generator (mulberry32) so fixtures that scatter
// transactions across an address pool are stable across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRecord(id: number, address: string): KRecord {
  return {
    id,
    type: "address",
    inputString: address,
    label: "",
    tags: [],
    categories: [],
    syncDepth: 0,
  };
}

function makeParticipant(txid: string, address: string): TransactionParticipant {
  return { txid, role: "output", address, amount: 1000 };
}

// Address pool whose members differ in their first characters for readable
// failures; node testids are not used in this lib-level test.
function makeAddress(i: number): string {
  return `1addr${String(i).padStart(8, "0")}xxxxxxxxxxxxxxxxxxxx`;
}

describe("buildNetworkGraph — per-transaction clique bound", () => {
  it("skips pair expansion for transactions above the clique threshold but keeps their nodes, and discloses the skip", async () => {
    // One huge consolidation tx (above threshold) + one normal 3-address tx.
    const hugeSize = MAX_TX_CLIQUE_ADDRESSES + 50;
    const records: KRecord[] = [];
    const participants: TransactionParticipant[] = [];
    for (let i = 0; i < hugeSize; i++) {
      records.push(makeRecord(i + 1, makeAddress(i)));
      participants.push(makeParticipant("tx-huge", makeAddress(i)));
    }
    // Normal tx linking the first three addresses — must still expand fully.
    for (let i = 0; i < 3; i++) {
      participants.push(makeParticipant("tx-small", makeAddress(i)));
    }

    const graph = await buildNetworkGraph(records, participants);

    // All addresses (incl. those only seen in the oversized tx) remain nodes.
    expect(graph.stats.nodeCount).toBe(hugeSize);
    // Only the small tx's clique (3 choose 2 = 3 edges) exists.
    expect(graph.stats.edgeCount).toBe(3);
    expect(graph.edges).toHaveLength(3);
    // Disclosure: exactly one oversized transaction was skipped.
    expect(graph.stats.skippedCliqueTransactions).toBe(1);
    // Nothing pruned for layout on such a small graph.
    expect(graph.stats.hiddenEdgeCount).toBe(0);
    expect(graph.layoutEdges).toHaveLength(graph.edges.length);
  });

  it("fully expands a transaction at exactly the clique threshold", async () => {
    const records: KRecord[] = [];
    const participants: TransactionParticipant[] = [];
    for (let i = 0; i < MAX_TX_CLIQUE_ADDRESSES; i++) {
      records.push(makeRecord(i + 1, makeAddress(i)));
      participants.push(makeParticipant("tx-at-limit", makeAddress(i)));
    }

    const graph = await buildNetworkGraph(records, participants);

    const expectedEdges = (MAX_TX_CLIQUE_ADDRESSES * (MAX_TX_CLIQUE_ADDRESSES - 1)) / 2;
    expect(graph.stats.edgeCount).toBe(expectedEdges);
    expect(graph.stats.skippedCliqueTransactions).toBe(0);
  });
});

describe("buildNetworkGraph — hard edge-count guard", () => {
  it("fails fast with an actionable TOO_MANY_EDGES error before any layout work", async () => {
    // A node pool under MAX_NODES, with many medium transactions scattered
    // deterministically so the unique-edge count comfortably exceeds MAX_EDGES.
    // 1,200 txs x 100 addresses = 5.94M pair insertions over C(2900,2)=4.2M
    // possible pairs, so the pool saturates well past the 1M guard.
    const poolSize = MAX_NODES - 100;
    const records: KRecord[] = Array.from({ length: poolSize }, (_, i) =>
      makeRecord(i + 1, makeAddress(i)),
    );
    const rand = mulberry32(0xC1C0E);
    const participants: TransactionParticipant[] = [];
    const txCount = 1200;
    for (let t = 0; t < txCount; t++) {
      // Deterministic distinct subset of the pool: shuffled stride walk.
      const seen = new Set<number>();
      while (seen.size < MAX_TX_CLIQUE_ADDRESSES) {
        seen.add(Math.floor(rand() * poolSize));
      }
      for (const idx of seen) {
        participants.push(makeParticipant(`tx-${t}`, makeAddress(idx)));
      }
    }

    await expect(buildNetworkGraph(records, participants)).rejects.toThrow(
      /^TOO_MANY_EDGES:\d+:/,
    );

    const err = await buildNetworkGraph(records, participants).catch((e) => e);
    const parts = (err as Error).message.split(":");
    expect(Number(parts[1])).toBeGreaterThan(MAX_EDGES);
    // The user-facing part tells the user to narrow with a filter.
    expect(parts[2]).toMatch(/filter/);
  }, 120000);
});

describe("selectLayoutEdges — deterministic weight-based pruning", () => {
  const edge = (source: string, target: string, weight: number): GraphEdge => ({
    source,
    target,
    weight,
    txids: Array.from({ length: weight }, (_, i) => `tx-${source}-${target}-${i}`),
  });

  it("returns the input untouched when under the cap", () => {
    const edges = [edge("a", "b", 1), edge("c", "d", 2)];
    expect(selectLayoutEdges(edges, 10)).toBe(edges);
  });

  it("keeps the strongest edges, breaking weight ties by (source, target) deterministically", () => {
    const edges = [
      edge("m", "n", 1),
      edge("a", "z", 3),
      edge("a", "b", 2),
      edge("c", "d", 2), // tie with a-b: loses on source
      edge("e", "f", 1),
    ];
    const selected = selectLayoutEdges(edges, 3);
    expect(selected.map((e) => `${e.source}|${e.target}`)).toEqual(["a|z", "a|b", "c|d"]);
    // Deterministic: same selection every call regardless of input order.
    const shuffled = [edges[3], edges[0], edges[4], edges[2], edges[1]];
    expect(selectLayoutEdges(shuffled, 3).map((e) => `${e.source}|${e.target}`)).toEqual([
      "a|z",
      "a|b",
      "c|d",
    ]);
  });
});

describe("buildNetworkGraph — layout pruning disclosure", () => {
  it("caps layoutEdges at MAX_LAYOUT_EDGES while stats still describe the full graph", async () => {
    // Under the hard edge guard but above the layout cap: 400 txs x 60
    // addresses over a pool, giving ~120k unique edges (well over 50k, well
    // under 1M). Some txs are duplicated to create weight-2 edges.
    const poolSize = MAX_NODES - 100;
    const records: KRecord[] = Array.from({ length: poolSize }, (_, i) =>
      makeRecord(i + 1, makeAddress(i)),
    );
    const rand = mulberry32(0xDE7E);
    const participants: TransactionParticipant[] = [];
    const pickSubset = (size: number): number[] => {
      const seen = new Set<number>();
      while (seen.size < size) seen.add(Math.floor(rand() * poolSize));
      return Array.from(seen);
    };
    for (let t = 0; t < 400; t++) {
      for (const idx of pickSubset(60)) {
        participants.push(makeParticipant(`tx-${t}`, makeAddress(idx)));
      }
    }
    // Duplicate the first 20 txs under new txids so those pairs gain weight 2.
    const dupSources = participants.slice(0, 20 * 60);
    for (const p of dupSources) {
      participants.push({ ...p, txid: `${p.txid}-dup` });
    }

    const graph = await buildNetworkGraph(records, participants);

    // Full graph is preserved...
    expect(graph.edges.length).toBeGreaterThan(MAX_LAYOUT_EDGES);
    expect(graph.stats.edgeCount).toBe(graph.edges.length);
    // ...but layout/render only receives the capped, strongest subset.
    expect(graph.layoutEdges).toHaveLength(MAX_LAYOUT_EDGES);
    expect(graph.stats.hiddenEdgeCount).toBe(graph.edges.length - MAX_LAYOUT_EDGES);
    // Strongest-first: no hidden edge outweighs a kept edge.
    const minKept = Math.min(...graph.layoutEdges.map((e) => e.weight));
    const keptKeys = new Set(graph.layoutEdges.map((e) => `${e.source}|${e.target}`));
    const hidden = graph.edges.filter((e) => !keptKeys.has(`${e.source}|${e.target}`));
    expect(hidden).toHaveLength(graph.stats.hiddenEdgeCount);
    expect(hidden.every((e) => e.weight <= minKept)).toBe(true);
    // layoutEdges is in the deterministic (weight desc, source, target) order.
    const sortedKeys = graph.layoutEdges.map(
      (e) => `${String(1e6 - e.weight).padStart(9, "0")}|${e.source}|${e.target}`,
    );
    expect([...sortedKeys].sort()).toEqual(sortedKeys);
    // Nodes/clusters describe the full graph (no node dropped by pruning).
    expect(graph.stats.nodeCount).toBe(graph.nodes.length);
  }, 120000);
});
