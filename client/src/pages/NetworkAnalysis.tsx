import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useGuardedAddressCopy } from "@/hooks/use-guarded-address-copy";
import {
  Play,
  StopCircle,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Info,
  AlertTriangle,
  Network,
  Users,
  GitBranch,
  Circle,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import {
  getRecordsByType,
  countTransactionParticipants,
  getAllTransactionParticipants,
  getParticipantsByRecordIds,
  getParticipantsByTxids,
  getTransactionsByTxids,
} from "@/lib/dataFacade";
import type { Record as KRecord, TransactionParticipant } from "@/lib/db-types";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { createGraphNodeActivation } from "@/lib/graph-node-interaction";
import { SearchableEntityPicker } from "@/components/SearchableEntityPicker";
import {
  DateRangeFilter,
  ANY_DATE_RANGE_FILTER,
  dateRangeFilterToUnixRange,
  type DateRangeFilterValue,
} from "@/components/DateRangeFilter";
import {
  buildNetworkGraph,
  MAX_NODES,
  MAX_TX_CLIQUE_ADDRESSES,
  type NetworkGraph,
  type GraphNode,
  type GraphEdge,
  type GraphStats,
  getCommunityColor,
} from "@/lib/network-analysis";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  owner?: string;
  walletName?: string;
  degree: number;
  community: number;
  centrality: number;
  tags: string[];
  syncDepth?: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  weight: number;
  txids: string[];
}

type FilterMode = "all" | "user-only" | "by-owner" | "by-wallet";

export default function NetworkAnalysis() {
  const { toast } = useToast();
  const { openRecordPreviewByAddress } = useRecordPreview();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState("");
  const [graph, setGraph] = useState<NetworkGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>("user-only");
  const [filterValue, setFilterValue] = useState<string>("");
  const [owners, setOwners] = useState<string[]>([]);
  const [wallets, setWallets] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRangeFilterValue>(ANY_DATE_RANGE_FILTER);
  const abortRef = useRef<AbortController | null>(null);

  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [simLinks, setSimLinks] = useState<SimLink[]>([]);
  const [isSimulating, setIsSimulating] = useState(false);
  const simulationRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const rawRecords = await getRecordsByType('address');
        const ownerSet = new Set<string>();
        const walletSet = new Set<string>();
        for (const r of rawRecords) {
          if (r.owner) ownerSet.add(r.owner);
          if (r.walletName) walletSet.add(r.walletName);
        }
        setOwners(Array.from(ownerSet).sort());
        setWallets(Array.from(walletSet).sort());
      } catch {
        // non-critical
      }
    })();
  }, []);

  const runAnalysis = useCallback(async () => {
    if (simulationRef.current) {
      simulationRef.current.stop();
      simulationRef.current = null;
    }
    setError(null);
    setGraph(null);
    setSelectedNode(null);
    setSimNodes([]);
    setSimLinks([]);
    setIsAnalyzing(true);
    setProgress("Loading records...");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let rawRecords = await getRecordsByType('address');
      if (controller.signal.aborted) return;

      if (controller.signal.aborted) return;

      let filteredRecords: KRecord[];
      if (filterMode === "user-only") {
        filteredRecords = rawRecords.filter(r => (r.syncDepth ?? 0) === 0);
      } else if (filterMode === "by-owner" && filterValue) {
        filteredRecords = rawRecords.filter(r => r.owner === filterValue);
      } else if (filterMode === "by-wallet" && filterValue) {
        filteredRecords = rawRecords.filter(r => r.walletName === filterValue);
      } else {
        filteredRecords = rawRecords;
      }

      if (filteredRecords.length === 0) {
        setError("No address records found matching your filter. Try a different filter.");
        setIsAnalyzing(false);
        return;
      }

      setProgress(`Found ${filteredRecords.length.toLocaleString()} addresses. Loading transaction data...`);

      let participants: TransactionParticipant[];

      if (filterMode === "all") {
        const totalParticipants = await countTransactionParticipants();
        if (totalParticipants > MAX_NODES * 200) {
          setError(
            `Your transaction participant table has ${totalParticipants.toLocaleString()} entries. ` +
            `This is too large for "All Addresses" mode. Please use a filter to narrow the data.`
          );
          setIsAnalyzing(false);
          return;
        }
        participants = await getAllTransactionParticipants();
      } else {
        const batchSize = 500;
        const recordIds = filteredRecords.map(r => r.id).filter((id): id is number => id !== undefined);
        const txidSet = new Set<string>();

        for (let i = 0; i < recordIds.length; i += batchSize) {
          if (controller.signal.aborted) return;
          const batch = recordIds.slice(i, i + batchSize);
          const batchParticipants = await getParticipantsByRecordIds(batch);
          for (const p of batchParticipants) txidSet.add(p.txid);
          setProgress(`Loaded participants for ${Math.min(i + batchSize, recordIds.length).toLocaleString()} of ${recordIds.length.toLocaleString()} records...`);
        }

        participants = [];
        const txids = Array.from(txidSet);
        for (let i = 0; i < txids.length; i += batchSize) {
          if (controller.signal.aborted) return;
          const batch = txids.slice(i, i + batchSize);
          const batchP = await getParticipantsByTxids(batch);
          participants.push(...batchP);
          if (i % (batchSize * 5) === 0) {
            setProgress(`Loaded participants for ${Math.min(i + batchSize, txids.length).toLocaleString()} of ${txids.length.toLocaleString()} transactions...`);
          }
        }
      }

      if (controller.signal.aborted) return;

      const unixRange = dateRangeFilterToUnixRange(dateRange);
      if (unixRange) {
        setProgress("Filtering transaction data by date...");
        const txids = Array.from(new Set(participants.map(p => p.txid)));
        const includedTxids = new Set<string>();
        const batchSize = 500;

        for (let i = 0; i < txids.length; i += batchSize) {
          if (controller.signal.aborted) return;
          const transactions = await getTransactionsByTxids(txids.slice(i, i + batchSize));
          for (const transaction of transactions) {
            if (
              (unixRange.start === undefined || transaction.blockTime >= unixRange.start) &&
              (unixRange.end === undefined || transaction.blockTime <= unixRange.end)
            ) {
              includedTxids.add(transaction.txid);
            }
          }
        }
        participants = participants.filter(p => includedTxids.has(p.txid));
      }

      if (controller.signal.aborted) return;

      const result = await buildNetworkGraph(
        filterMode === "all" ? rawRecords : filteredRecords,
        participants,
        controller.signal,
        setProgress,
      );

      if (controller.signal.aborted) return;
      setGraph(result);
      startSimulation(result);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setProgress("Analysis cancelled.");
        return;
      }
      if (err?.message?.startsWith('TOO_MANY_NODES:') || err?.message?.startsWith('TOO_MANY_EDGES:')) {
        const parts = err.message.split(':');
        setError(parts[2]);
      } else {
        console.error('Network analysis error:', err);
        setError(`Analysis failed: ${err?.message || 'Unknown error'}. Your data is safe — this feature is read-only.`);
      }
    } finally {
      setIsAnalyzing(false);
      abortRef.current = null;
    }
  }, [filterMode, filterValue, dateRange]);

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
    // Also cancel the layout phase: stop the force simulation so the page
    // returns to an idle, non-stuck state (the graph stays visible, frozen at
    // its last laid-out positions).
    if (simulationRef.current) {
      simulationRef.current.stop();
      simulationRef.current = null;
      setIsSimulating(false);
    }
    setIsAnalyzing(false);
    setProgress("Cancelled.");
  }, []);

  const tickCountRef = useRef(0);

  const startSimulation = useCallback((g: NetworkGraph) => {
    if (simulationRef.current) {
      simulationRef.current.stop();
    }

    const sNodes: SimNode[] = g.nodes.map(n => ({
      id: n.id,
      label: n.label,
      owner: n.owner,
      walletName: n.walletName,
      degree: n.degree,
      community: n.community,
      centrality: n.centrality,
      tags: n.tags,
      syncDepth: n.syncDepth,
      x: n.x,
      y: n.y,
    }));

    const nodeMap = new Map(sNodes.map(n => [n.id, n]));
    // layoutEdges is the (possibly weight-pruned) display subset — the full
    // edge set would freeze the simulation and the SVG renderer on dense
    // graphs. Clusters/stats already describe the full graph.
    const sLinks: SimLink[] = g.layoutEdges
      .map(e => {
        const source = nodeMap.get(e.source);
        const target = nodeMap.get(e.target);
        if (!source || !target) return null;
        return { source, target, weight: e.weight, txids: e.txids };
      })
      .filter(Boolean) as SimLink[];

    setIsSimulating(true);
    tickCountRef.current = 0;
    // Seed the first frame immediately so the graph is visible before the
    // first simulation tick — and so cancelling the layout early still leaves
    // a rendered (frozen) graph instead of an empty canvas.
    setSimNodes([...sNodes]);
    setSimLinks([...sLinks]);

    const throttleInterval = sNodes.length > 500 ? 5 : 2;

    const sim = forceSimulation<SimNode>(sNodes)
      .force("link", forceLink<SimNode, SimLink>(sLinks).id(d => d.id).distance(60).strength(0.3))
      .force("charge", forceManyBody<SimNode>().strength(-120).distanceMax(400))
      .force("center", forceCenter(0, 0).strength(0.05))
      .force("collide", forceCollide<SimNode>().radius(d => getNodeRadius(d) + 2).strength(0.5))
      .alphaDecay(0.02)
      .on("tick", () => {
        tickCountRef.current++;
        if (tickCountRef.current % throttleInterval === 0) {
          setSimNodes([...sNodes]);
          setSimLinks([...sLinks]);
        }
      })
      .on("end", () => {
        setSimNodes([...sNodes]);
        setSimLinks([...sLinks]);
        setIsSimulating(false);
      });

    simulationRef.current = sim;
  }, []);

  useEffect(() => {
    return () => {
      simulationRef.current?.stop();
      abortRef.current?.abort();
    };
  }, []);

  const getNodeRadius = (node: SimNode | GraphNode): number => {
    const base = 4;
    const degreeBonus = Math.min(node.degree * 0.5, 8);
    const centralityBonus = node.centrality * 6;
    return base + degreeBonus + centralityBonus;
  };

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.1, Math.min(10, z * factor)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-graph-node]')) return;
    setDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setPanStart(pan);
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({
      x: panStart.x + (e.clientX - dragStart.x),
      y: panStart.y + (e.clientY - dragStart.y),
    });
  }, [dragging, dragStart, panStart]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const connectedEdges = useMemo(() => {
    if (!hoveredNode && !selectedNode) return new Set<number>();
    const targetId = hoveredNode || selectedNode?.id;
    const indices = new Set<number>();
    simLinks.forEach((link, i) => {
      const sId = typeof link.source === 'object' ? (link.source as SimNode).id : link.source;
      const tId = typeof link.target === 'object' ? (link.target as SimNode).id : link.target;
      if (sId === targetId || tId === targetId) indices.add(i);
    });
    return indices;
  }, [hoveredNode, selectedNode, simLinks]);

  const connectedNodeIds = useMemo(() => {
    if (!hoveredNode && !selectedNode) return new Set<string>();
    const targetId = hoveredNode || selectedNode?.id;
    const ids = new Set<string>();
    if (targetId) ids.add(targetId);
    simLinks.forEach(link => {
      const sId = typeof link.source === 'object' ? (link.source as SimNode).id : link.source;
      const tId = typeof link.target === 'object' ? (link.target as SimNode).id : link.target;
      if (sId === targetId) ids.add(tId as string);
      if (tId === targetId) ids.add(sId as string);
    });
    return ids;
  }, [hoveredNode, selectedNode, simLinks]);

  const hasHighlight = hoveredNode !== null || selectedNode !== null;

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="page-network-analysis">
      <div className="p-4 border-b space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold" data-testid="text-page-title">Network Analysis</h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {graph && (
              <>
                <Button size="icon" variant="ghost" onClick={() => setZoom(z => Math.min(10, z * 1.3))} data-testid="button-zoom-in">
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setZoom(z => Math.max(0.1, z / 1.3))} data-testid="button-zoom-out">
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={resetView} data-testid="button-reset-view">
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <Label className="text-xs">Filter</Label>
            <Select
              value={filterMode}
              onValueChange={(v) => {
                setFilterMode(v as FilterMode);
                setFilterValue("");
              }}
            >
              <SelectTrigger className="w-44" data-testid="select-filter-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user-only">My Addresses Only</SelectItem>
                <SelectItem value="by-owner">By Owner</SelectItem>
                <SelectItem value="by-wallet">By Wallet</SelectItem>
                <SelectItem value="all">All Addresses</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(filterMode === "by-owner" || filterMode === "by-wallet") && (
            <div className="space-y-1">
              <Label className="text-xs">{filterMode === "by-owner" ? "Owner" : "Wallet"}</Label>
              <SearchableEntityPicker
                options={(filterMode === "by-owner" ? owners : wallets).map(value => ({
                  value,
                  label: value,
                }))}
                value={filterValue}
                onChange={setFilterValue}
                placeholder={`Select ${filterMode === "by-owner" ? "owner" : "wallet"}`}
                searchPlaceholder={`Search ${filterMode === "by-owner" ? "owners" : "wallets"}...`}
                testId="network-analysis-filter-value"
                className="w-64"
              />
            </div>
          )}

          <DateRangeFilter
            value={dateRange}
            onChange={setDateRange}
            label="Date Range"
            testId="network-analysis-date-range"
          />

          {!isAnalyzing && !isSimulating ? (
            <Button
              onClick={runAnalysis}
              disabled={(filterMode === "by-owner" || filterMode === "by-wallet") && !filterValue}
              data-testid="button-run-analysis"
            >
              <Play className="h-4 w-4 mr-1" />
              Analyze
            </Button>
          ) : (
            <Button onClick={cancelAnalysis} variant="destructive" data-testid="button-cancel-analysis">
              <StopCircle className="h-4 w-4 mr-1" />
              Cancel
            </Button>
          )}
        </div>

        {(isAnalyzing || progress) && !graph && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {isAnalyzing && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />}
            <span data-testid="text-progress">{progress}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span data-testid="text-error">{error}</span>
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        {!graph && !isAnalyzing && !error && (
          <div className="flex-1 flex items-center justify-center p-8">
            <Card className="max-w-lg">
              <CardContent className="pt-6 space-y-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-2 text-foreground font-medium">
                  <Info className="h-4 w-4" />
                  How It Works
                </div>
                <p>
                  Network Analysis builds a graph of your Bitcoin addresses connected through shared transactions.
                  It then runs three algorithms:
                </p>
                <ul className="space-y-1.5 pl-4">
                  <li className="flex items-start gap-2">
                    <Users className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
                    <span><strong>Cluster Detection</strong> — finds groups of addresses that frequently transact together</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Circle className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
                    <span><strong>Centrality Analysis</strong> — identifies hub addresses with the most influence</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <GitBranch className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
                    <span><strong>Bridge Detection</strong> — finds addresses that connect otherwise separate clusters</span>
                  </li>
                </ul>
                <p>
                  This is read-only analysis. No data is modified. Select a filter and click Analyze to begin.
                </p>
                <p className="text-xs">
                  Safe for datasets up to {MAX_NODES.toLocaleString()} addresses. Very dense
                  connection graphs are pruned to their strongest links for display (this is always
                  disclosed), and oversized consolidation/CoinJoin transactions are not expanded
                  into pairwise connections.
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {graph && (
          <>
            <div
              className="flex-1 relative bg-muted/20 cursor-grab active:cursor-grabbing"
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              {isSimulating && (
                <div className="absolute top-2 left-2 z-10 flex items-center gap-2 text-xs text-muted-foreground bg-background/80 px-2 py-1 rounded-md">
                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary" />
                  Laying out graph...
                </div>
              )}
              <svg
                ref={svgRef}
                className="w-full h-full"
                data-testid="svg-network-graph"
              >
                <g transform={`translate(${pan.x + (svgRef.current?.clientWidth ?? 800) / 2}, ${pan.y + (svgRef.current?.clientHeight ?? 600) / 2}) scale(${zoom})`}>
                  {simLinks.map((link, i) => {
                    const s = link.source as SimNode;
                    const t = link.target as SimNode;
                    if (s.x == null || s.y == null || t.x == null || t.y == null) return null;
                    const highlighted = connectedEdges.has(i);
                    const dimmed = hasHighlight && !highlighted;
                    return (
                      <line
                        key={i}
                        x1={s.x}
                        y1={s.y}
                        x2={t.x}
                        y2={t.y}
                        stroke={highlighted ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"}
                        strokeOpacity={dimmed ? 0.05 : (highlighted ? 0.7 : 0.15)}
                        strokeWidth={Math.max(0.5, Math.min(link.weight * 0.5, 3))}
                      />
                    );
                  })}

                  {simNodes.map(node => {
                    if (node.x == null || node.y == null) return null;
                    const r = getNodeRadius(node);
                    const color = getCommunityColor(node.community);
                    const isBridge = graph.stats.bridgeNodes.includes(node.id);
                    const isSelected = selectedNode?.id === node.id;
                    const isHovered = hoveredNode === node.id;
                    const isConnected = connectedNodeIds.has(node.id);
                    const dimmed = hasHighlight && !isConnected && !isSelected && !isHovered;

                    return (
                      <g
                        key={node.id}
                        data-graph-node="true"
                        data-testid={`node-address-${node.id.slice(0, 8)}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`Address ${node.id} — click or press Enter to open record and highlight connections`}
                        className="outline-none focus-visible:opacity-100"
                        style={{ cursor: 'pointer' }}
                        {...createGraphNodeActivation<SVGGElement>(() => {
                          const gNode = graph.nodes.find(n => n.id === node.id);
                          setSelectedNode(gNode || null);
                          void openRecordPreviewByAddress(node.id);
                        })}
                        onMouseEnter={() => setHoveredNode(node.id)}
                        onMouseLeave={() => setHoveredNode(null)}
                      >
                        {isBridge && (
                          <circle
                            cx={node.x}
                            cy={node.y}
                            r={r + 4}
                            fill="none"
                            stroke="hsl(var(--destructive))"
                            strokeWidth={1.5}
                            strokeDasharray="3 2"
                            opacity={dimmed ? 0.1 : 0.8}
                          />
                        )}
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={r}
                          fill={color}
                          fillOpacity={dimmed ? 0.1 : (isSelected || isHovered ? 1 : 0.8)}
                          stroke={isSelected ? "hsl(var(--foreground))" : (isHovered ? "hsl(var(--primary))" : "none")}
                          strokeWidth={isSelected ? 2 : (isHovered ? 1.5 : 0)}
                        />
                        {(r > 6 || isHovered || isSelected) && zoom > 0.5 && (
                          <text
                            x={node.x}
                            y={node.y! + r + 10}
                            textAnchor="middle"
                            fontSize={Math.max(8, 10 / zoom)}
                            fill="hsl(var(--foreground))"
                            fillOpacity={dimmed ? 0.1 : 0.8}
                            className="pointer-events-none select-none"
                          >
                            {node.label.length > 12 ? node.label.slice(0, 12) + '...' : node.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
            </div>

            <div className="w-72 border-l overflow-y-auto p-4 space-y-4 flex-shrink-0">
              <StatsPanel stats={graph.stats} />
              {selectedNode && (
                <NodeDetail
                  node={selectedNode}
                  stats={graph.stats}
                  edges={graph.edges}
                  onClose={() => setSelectedNode(null)}
                  onOpenRecord={openRecordPreviewByAddress}
                />
              )}
              <CommunityLegend communities={graph.communities} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatsPanel({ stats }: { stats: GraphStats }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Graph Statistics</h3>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">Addresses</span>
        <span className="font-medium" data-testid="text-stat-nodes">{stats.nodeCount.toLocaleString()}</span>
        <span className="text-muted-foreground">Connections</span>
        <span className="font-medium" data-testid="text-stat-edges">{stats.edgeCount.toLocaleString()}</span>
        <span className="text-muted-foreground">Clusters</span>
        <span className="font-medium" data-testid="text-stat-communities">{stats.communityCount.toLocaleString()}</span>
        <span className="text-muted-foreground">Largest Cluster</span>
        <span className="font-medium">{stats.largestCommunitySize.toLocaleString()}</span>
        <span className="text-muted-foreground">Isolated</span>
        <span className="font-medium">{stats.isolatedNodes.toLocaleString()}</span>
        <span className="text-muted-foreground">Avg Connections</span>
        <span className="font-medium">{stats.avgDegree}</span>
        <span className="text-muted-foreground">Bridge Nodes</span>
        <span className="font-medium">{stats.bridgeNodes.length}</span>
        {stats.hiddenEdgeCount > 0 && (
          <>
            <span className="text-muted-foreground">Shown Connections</span>
            <span className="font-medium" data-testid="text-stat-shown-edges">
              {(stats.edgeCount - stats.hiddenEdgeCount).toLocaleString()}
            </span>
          </>
        )}
        {stats.skippedCliqueTransactions > 0 && (
          <>
            <span className="text-muted-foreground">Oversized Txs Skipped</span>
            <span className="font-medium" data-testid="text-stat-skipped-cliques">
              {stats.skippedCliqueTransactions.toLocaleString()}
            </span>
          </>
        )}
      </div>
      {stats.hiddenEdgeCount > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="notice-hidden-edges">
          This graph is very dense — showing the strongest{" "}
          {(stats.edgeCount - stats.hiddenEdgeCount).toLocaleString()} of{" "}
          {stats.edgeCount.toLocaleString()} connections; {stats.hiddenEdgeCount.toLocaleString()}{" "}
          lower-weight connections are hidden from the layout. All statistics above still describe
          the full graph.
        </p>
      )}
      {stats.skippedCliqueTransactions > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="notice-skipped-cliques">
          {stats.skippedCliqueTransactions.toLocaleString()} oversized transaction
          {stats.skippedCliqueTransactions === 1 ? "" : "s"} (more than {MAX_TX_CLIQUE_ADDRESSES}{" "}
          addresses each — typically huge consolidations or CoinJoins){" "}
          {stats.skippedCliqueTransactions === 1 ? "was" : "were"} not expanded into pairwise
          connections. Their addresses still appear as nodes.
        </p>
      )}
    </div>
  );
}

export function CopyAddressButton({ address }: { address: string }) {
  const { copyAddress, isCopied } = useGuardedAddressCopy();
  const copied = isCopied(address);

  const handleCopy = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    void copyAddress(address);
  };

  const handleCopyKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCopy(e);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      onKeyDown={handleCopyKeyDown}
      aria-label={copied ? "Copied" : "Copy address"}
      className="p-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex-shrink-0"
      data-testid={`button-copy-network-address-${address.slice(-8)}`}
    >
      {copied
        ? <Check className="h-3 w-3 text-green-600" />
        : <Copy className="h-3 w-3" />}
    </button>
  );
}

function NodeDetail({
  node,
  stats,
  edges,
  onClose,
  onOpenRecord,
}: {
  node: GraphNode;
  stats: GraphStats;
  edges: GraphEdge[];
  onClose: () => void;
  onOpenRecord: (address: string) => void;
}) {
  const connectedEdges = edges.filter(e => e.source === node.id || e.target === node.id);
  const totalTxs = new Set(connectedEdges.flatMap(e => e.txids)).size;
  const isBridge = stats.bridgeNodes.includes(node.id);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Selected Address</h3>
        <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-detail">
          <span className="text-xs">&times;</span>
        </Button>
      </div>
      <Button
        size="sm"
        variant="default"
        className="w-full"
        onClick={() => onOpenRecord(node.id)}
        data-testid="button-view-record"
      >
        <ExternalLink className="h-3 w-3" />
        View record
      </Button>
      <div className="space-y-1.5 text-xs">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <span className="text-muted-foreground">Address: </span>
            <span
              role="button"
              tabIndex={0}
              onClick={() => onOpenRecord(node.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenRecord(node.id);
                }
              }}
              className="font-mono break-all text-primary underline underline-offset-2 cursor-pointer hover:opacity-80 outline-none focus-visible:opacity-80"
              title="Click to view this address record"
              data-testid="text-selected-address"
            >
              {node.id}
            </span>
          </div>
          <CopyAddressButton address={node.id} />
        </div>
        {node.label && node.label !== node.id.slice(0, 8) + '...' && (
          <div>
            <span className="text-muted-foreground">Label: </span>
            <span>{node.label}</span>
          </div>
        )}
        {node.owner && (
          <div>
            <span className="text-muted-foreground">Owner: </span>
            <span>{node.owner}</span>
          </div>
        )}
        {node.walletName && (
          <div>
            <span className="text-muted-foreground">Wallet: </span>
            <span>{node.walletName}</span>
          </div>
        )}
        <div>
          <span className="text-muted-foreground">Connections: </span>
          <span>{node.degree}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Shared Transactions: </span>
          <span>{totalTxs}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Centrality: </span>
          <span>{(node.centrality * 100).toFixed(1)}%</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Cluster: </span>
          <span
            className="inline-block w-3 h-3 rounded-full"
            style={{ backgroundColor: getCommunityColor(node.community) }}
          />
          <span>{node.community}</span>
        </div>
        {isBridge && (
          <Badge variant="destructive" className="text-xs">Bridge Node</Badge>
        )}
        {node.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {node.tags.slice(0, 5).map(tag => (
              <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommunityLegend({ communities }: { communities: Map<number, string[]> }) {
  const sorted = Array.from(communities.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Clusters</h3>
      <div className="space-y-1">
        {sorted.map(([id, members]) => (
          <div key={id} className="flex items-center gap-2 text-xs">
            <span
              className="inline-block w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: getCommunityColor(id) }}
            />
            <span className="text-muted-foreground">Cluster {id}</span>
            <span className="font-medium">{members.length} addresses</span>
          </div>
        ))}
      </div>
    </div>
  );
}
