import type { Record, TransactionParticipant } from './db-types';

export interface GraphNode {
  id: string;
  label: string;
  owner?: string;
  walletName?: string;
  tags: string[];
  syncDepth?: number;
  degree: number;
  community: number;
  centrality: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  txids: string[];
  weight: number;
}

export interface NetworkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: Map<number, string[]>;
  stats: GraphStats;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  largestCommunitySize: number;
  isolatedNodes: number;
  avgDegree: number;
  bridgeNodes: string[];
}

export const MAX_NODES = 3000;
export const MAX_PARTICIPANTS_SCAN = 500000;

export async function buildNetworkGraph(
  records: Record[],
  participants: TransactionParticipant[],
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<NetworkGraph> {
  onProgress?.('Building address-to-transaction index...');

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const addressRecordMap = new Map<string, Record>();
  for (const r of records) {
    if (r.type === 'address' && r.inputString) {
      addressRecordMap.set(r.inputString, r);
    }
  }

  const txToAddresses = new Map<string, Set<string>>();
  let processed = 0;
  for (const p of participants) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!p.address) continue;
    let addrs = txToAddresses.get(p.txid);
    if (!addrs) {
      addrs = new Set();
      txToAddresses.set(p.txid, addrs);
    }
    addrs.add(p.address);
    processed++;
    if (processed % 50000 === 0) {
      onProgress?.(`Indexed ${processed.toLocaleString()} participants across ${txToAddresses.size.toLocaleString()} transactions...`);
      await yieldToUI();
    }
  }

  onProgress?.('Building edge map...');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const edgeMap = new Map<string, { txids: Set<string> }>();
  const nodeAddresses = new Set<string>();
  let txProcessed = 0;

  for (const [txid, addrs] of txToAddresses) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const addrArr = Array.from(addrs);
    for (const addr of addrArr) {
      nodeAddresses.add(addr);
    }
    for (let i = 0; i < addrArr.length; i++) {
      for (let j = i + 1; j < addrArr.length; j++) {
        const a = addrArr[i] < addrArr[j] ? addrArr[i] : addrArr[j];
        const b = addrArr[i] < addrArr[j] ? addrArr[j] : addrArr[i];
        const key = `${a}|${b}`;
        let edge = edgeMap.get(key);
        if (!edge) {
          edge = { txids: new Set() };
          edgeMap.set(key, edge);
        }
        edge.txids.add(txid);
      }
    }
    txProcessed++;
    if (txProcessed % 10000 === 0) {
      onProgress?.(`Processed ${txProcessed.toLocaleString()} of ${txToAddresses.size.toLocaleString()} transactions...`);
      await yieldToUI();
    }
  }

  if (nodeAddresses.size > MAX_NODES) {
    throw new Error(
      `TOO_MANY_NODES:${nodeAddresses.size}:Your dataset contains ${nodeAddresses.size.toLocaleString()} addresses, which exceeds the safe limit of ${MAX_NODES.toLocaleString()}. Use the filters to narrow your data before running network analysis.`
    );
  }

  onProgress?.(`Building graph with ${nodeAddresses.size.toLocaleString()} nodes and ${edgeMap.size.toLocaleString()} edges...`);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const degreeMap = new Map<string, number>();
  for (const [key, edge] of edgeMap) {
    const [a, b] = key.split('|');
    edges.push({ source: a, target: b, txids: Array.from(edge.txids), weight: edge.txids.size });
    degreeMap.set(a, (degreeMap.get(a) || 0) + 1);
    degreeMap.set(b, (degreeMap.get(b) || 0) + 1);
  }

  for (const addr of nodeAddresses) {
    const rec = addressRecordMap.get(addr);
    nodes.push({
      id: addr,
      label: rec?.label || addr.slice(0, 8) + '...',
      owner: rec?.owner,
      walletName: rec?.walletName,
      tags: rec?.tags || [],
      syncDepth: rec?.syncDepth,
      degree: degreeMap.get(addr) || 0,
      community: -1,
      centrality: 0,
      x: Math.random() * 800 - 400,
      y: Math.random() * 800 - 400,
      vx: 0,
      vy: 0,
    });
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  onProgress?.('Running community detection...');
  await yieldToUI();

  const communities = louvainCommunities(nodes, edges, signal);

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  onProgress?.('Computing centrality...');
  await yieldToUI();

  computeApproxCentrality(nodes, edges, signal);

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  onProgress?.('Detecting bridge nodes...');
  await yieldToUI();

  const bridgeNodes = findBridgeNodes(nodes, edges);

  const communityGroups = new Map<number, string[]>();
  for (const n of nodes) {
    let group = communityGroups.get(n.community);
    if (!group) {
      group = [];
      communityGroups.set(n.community, group);
    }
    group.push(n.id);
  }

  const isolatedNodes = nodes.filter(n => n.degree === 0).length;
  const avgDegree = nodes.length > 0 ? edges.length * 2 / nodes.length : 0;
  let largestCommunitySize = 0;
  for (const group of communityGroups.values()) {
    if (group.length > largestCommunitySize) largestCommunitySize = group.length;
  }

  const stats: GraphStats = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    communityCount: communityGroups.size,
    largestCommunitySize,
    isolatedNodes,
    avgDegree: Math.round(avgDegree * 100) / 100,
    bridgeNodes,
  };

  onProgress?.('Analysis complete.');

  return { nodes, edges, communities: communityGroups, stats };
}

function louvainCommunities(
  nodes: GraphNode[],
  edges: GraphEdge[],
  signal?: AbortSignal,
): Map<number, string[]> {
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const community = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) community[i] = i;

  const adj: Map<number, Map<number, number>> = new Map();
  for (let i = 0; i < nodes.length; i++) adj.set(i, new Map());

  let totalWeight = 0;
  for (const e of edges) {
    const si = nodeIndex.get(e.source);
    const ti = nodeIndex.get(e.target);
    if (si === undefined || ti === undefined) continue;
    const w = e.weight;
    adj.get(si)!.set(ti, (adj.get(si)!.get(ti) || 0) + w);
    adj.get(ti)!.set(si, (adj.get(ti)!.get(si) || 0) + w);
    totalWeight += w;
  }

  if (totalWeight === 0) {
    for (let i = 0; i < nodes.length; i++) nodes[i].community = i;
    const result = new Map<number, string[]>();
    nodes.forEach(n => result.set(n.community, [n.id]));
    return result;
  }

  const m2 = totalWeight * 2;
  const kDeg = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    let sum = 0;
    for (const w of adj.get(i)!.values()) sum += w;
    kDeg[i] = sum;
  }

  const commWeight = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) commWeight[i] = kDeg[i];

  const order = Array.from({ length: nodes.length }, (_, i) => i);

  for (let pass = 0; pass < 15; pass++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let moved = false;

    for (let idx = 0; idx < order.length; idx++) {
      const i = order[idx];
      const ci = community[i];
      const ki = kDeg[i];

      const neighborComms = new Map<number, number>();
      for (const [j, w] of adj.get(i)!) {
        const cj = community[j];
        neighborComms.set(cj, (neighborComms.get(cj) || 0) + w);
      }

      commWeight[ci] -= ki;

      let bestComm = ci;
      let bestGain = 0;
      const kIn_ci = neighborComms.get(ci) || 0;
      const removeGain = kIn_ci - (ki * commWeight[ci]) / m2;

      for (const [c, kIn_c] of neighborComms) {
        const gain = kIn_c - (ki * commWeight[c]) / m2 - removeGain;
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = c;
        }
      }

      community[i] = bestComm;
      commWeight[bestComm] += ki;
      if (bestComm !== ci) moved = true;
    }

    if (!moved) break;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  const uniqueComms = new Map<number, number>();
  let nextId = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (!uniqueComms.has(community[i])) {
      uniqueComms.set(community[i], nextId++);
    }
    nodes[i].community = uniqueComms.get(community[i])!;
  }

  const result = new Map<number, string[]>();
  for (const n of nodes) {
    let group = result.get(n.community);
    if (!group) {
      group = [];
      result.set(n.community, group);
    }
    group.push(n.id);
  }
  return result;
}

function computeApproxCentrality(
  nodes: GraphNode[],
  edges: GraphEdge[],
  signal?: AbortSignal,
): void {
  if (nodes.length === 0) return;

  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const adj: number[][] = Array.from({ length: nodes.length }, () => []);
  for (const e of edges) {
    const si = nodeIndex.get(e.source);
    const ti = nodeIndex.get(e.target);
    if (si === undefined || ti === undefined) continue;
    adj[si].push(ti);
    adj[ti].push(si);
  }

  const centrality = new Float64Array(nodes.length);
  const sampleSize = Math.min(nodes.length, 50);
  const sampleStep = Math.max(1, Math.floor(nodes.length / sampleSize));

  for (let s = 0; s < nodes.length; s += sampleStep) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const dist = new Int32Array(nodes.length).fill(-1);
    const sigma = new Float64Array(nodes.length);
    const delta = new Float64Array(nodes.length);
    const stack: number[] = [];
    const pred: number[][] = Array.from({ length: nodes.length }, () => []);

    dist[s] = 0;
    sigma[s] = 1;
    const queue = [s];
    let qi = 0;

    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);
      for (const w of adj[v]) {
        if (dist[w] === -1) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          pred[w].push(v);
        }
      }
    }

    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred[w]) {
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      }
      if (w !== s) centrality[w] += delta[w];
    }
  }

  let maxCentrality = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (centrality[i] > maxCentrality) maxCentrality = centrality[i];
  }

  if (maxCentrality > 0) {
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].centrality = Math.round((centrality[i] / maxCentrality) * 1000) / 1000;
    }
  }
}

function findBridgeNodes(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  if (nodes.length === 0 || edges.length === 0) return [];

  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const adj: number[][] = Array.from({ length: nodes.length }, () => []);
  for (const e of edges) {
    const si = nodeIndex.get(e.source);
    const ti = nodeIndex.get(e.target);
    if (si === undefined || ti === undefined) continue;
    adj[si].push(ti);
    adj[ti].push(si);
  }

  const disc = new Int32Array(nodes.length).fill(-1);
  const low = new Int32Array(nodes.length);
  const articulationPoints = new Set<number>();
  let timer = 0;

  function dfs(u: number, parent: number) {
    disc[u] = low[u] = timer++;
    let children = 0;
    for (const v of adj[u]) {
      if (disc[v] === -1) {
        children++;
        dfs(v, u);
        if (low[v] < low[u]) low[u] = low[v];
        if (parent === -1 && children > 1) articulationPoints.add(u);
        if (parent !== -1 && low[v] >= disc[u]) articulationPoints.add(u);
      } else if (v !== parent) {
        if (disc[v] < low[u]) low[u] = disc[v];
      }
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    if (disc[i] === -1) dfs(i, -1);
  }

  return Array.from(articulationPoints)
    .map(i => nodes[i].id)
    .slice(0, 50);
}

function yieldToUI(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

export const COMMUNITY_COLORS = [
  'hsl(210, 70%, 55%)',
  'hsl(340, 65%, 55%)',
  'hsl(120, 50%, 45%)',
  'hsl(40, 80%, 50%)',
  'hsl(270, 55%, 55%)',
  'hsl(180, 55%, 45%)',
  'hsl(15, 70%, 55%)',
  'hsl(300, 50%, 55%)',
  'hsl(75, 55%, 45%)',
  'hsl(195, 65%, 50%)',
  'hsl(350, 55%, 45%)',
  'hsl(160, 50%, 40%)',
  'hsl(50, 60%, 50%)',
  'hsl(230, 55%, 55%)',
  'hsl(100, 45%, 45%)',
  'hsl(0, 50%, 50%)',
];

export function getCommunityColor(community: number): string {
  return COMMUNITY_COLORS[community % COMMUNITY_COLORS.length];
}
