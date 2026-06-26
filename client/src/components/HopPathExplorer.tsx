import { useState, useMemo, useCallback, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { 
  Circle, ArrowDown, ArrowUp, MoveDown,
  ExternalLink, Home, Loader2, AlertCircle
} from "lucide-react";
import { type FlowNode, type FlowLink } from "@/hooks/use-flow-data";

interface FlatNode {
  id: string;
  address: string;
  fullAddress: string;
  amount: number;
  timestamp: string;
  hop: number;
  direction: "source" | "center" | "destination";
  isOwned: boolean;
  isUnclassified: boolean;
  owner?: string;
  label?: string;
  txid?: string;
}

interface HopPathExplorerProps {
  nodes: FlowNode[];
  links: FlowLink[];
  centerAddress: string;
  onExploreAddress?: (address: string) => void;
  onNodeClick?: (address: string) => void;
  isLoading?: boolean;
}

const formatBtc = (btc: number): string => {
  if (btc >= 1) return `${btc.toFixed(4)} BTC`;
  if (btc >= 0.001) return `${btc.toFixed(6)} BTC`;
  return `${btc.toFixed(8)} BTC`;
};

const getNodeStatus = (node: FlowNode): { isOwned: boolean; isUnclassified: boolean } => {
  const isOwned = node.isLabeled || !!node.owner;
  const isUnclassified = !node.isLabeled && !node.owner && !node.label;
  return { isOwned, isUnclassified };
};

const parseTimestamp = (ts: string): number => {
  const date = new Date(ts);
  return isNaN(date.getTime()) ? 0 : date.getTime();
};

const FlowArrow = ({ fromIndent, toIndent, direction }: { 
  fromIndent: number; 
  toIndent: number; 
  direction: "down" | "up";
}) => {
  const minIndent = Math.min(fromIndent, toIndent);
  const arrowColor = direction === "down" ? "text-blue-400" : "text-purple-400";
  
  return (
    <div 
      className="flex items-center h-6 relative"
      style={{ marginLeft: `${minIndent + 6}px` }}
    >
      <div className="flex items-center gap-1">
        <div className={`w-px h-full bg-border absolute left-1 top-0 bottom-0`} />
        <MoveDown className={`h-4 w-4 ${arrowColor} ${direction === "up" ? "" : ""}`} />
        <span className="text-xs text-muted-foreground/60 italic">funds flow</span>
      </div>
    </div>
  );
};

export function HopPathExplorer({ 
  nodes, 
  links, 
  centerAddress,
  onExploreAddress,
  onNodeClick,
  isLoading = false
}: HopPathExplorerProps) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [exploringAddress, setExploringAddress] = useState<string | null>(null);

  const handleExplore = useCallback((address: string) => {
    if (onExploreAddress && !isLoading) {
      setExploringAddress(address);
      onExploreAddress(address);
    }
  }, [onExploreAddress, isLoading]);

  useEffect(() => {
    if (!isLoading && exploringAddress) {
      setExploringAddress(null);
    }
  }, [isLoading, exploringAddress]);

  const nodeLinks = useMemo(() => {
    const linkMap = new Map<string, FlowLink[]>();
    for (const link of links) {
      if (!linkMap.has(link.source)) linkMap.set(link.source, []);
      if (!linkMap.has(link.target)) linkMap.set(link.target, []);
      linkMap.get(link.source)!.push(link);
      linkMap.get(link.target)!.push(link);
    }
    return linkMap;
  }, [links]);

  const { incomingNodes, centerNode, outgoingNodes } = useMemo(() => {
    const incoming: FlatNode[] = [];
    const outgoing: FlatNode[] = [];
    let center: FlatNode | null = null;

    for (const node of nodes) {
      const { isOwned, isUnclassified } = getNodeStatus(node);
      
      const flatNode: FlatNode = {
        id: node.id === "selected" ? "center" : node.id,
        address: node.address.length > 16 
          ? `${node.address.slice(0, 8)}...${node.address.slice(-6)}`
          : node.address,
        fullAddress: node.address,
        amount: node.amount,
        timestamp: node.timestamp,
        hop: node.hop,
        direction: node.type === "selected" ? "center" 
          : node.type === "input" ? "source" 
          : "destination",
        isOwned,
        isUnclassified,
        owner: node.owner,
        label: node.label,
        txid: node.txid,
      };

      if (node.type === "selected") {
        center = flatNode;
      } else if (node.type === "input") {
        incoming.push(flatNode);
      } else if (node.type === "output") {
        outgoing.push(flatNode);
      }
    }

    // Sort incoming: oldest first (by timestamp), then by hop (furthest first for same time)
    // Furthest hop at top = oldest transactions
    incoming.sort((a, b) => {
      const timeA = parseTimestamp(a.timestamp);
      const timeB = parseTimestamp(b.timestamp);
      if (timeA !== timeB) return timeA - timeB; // Oldest first
      return b.hop - a.hop; // Further hops first if same time
    });

    // Sort outgoing: oldest first at top, newest at bottom
    outgoing.sort((a, b) => {
      const timeA = parseTimestamp(a.timestamp);
      const timeB = parseTimestamp(b.timestamp);
      if (timeA !== timeB) return timeA - timeB; // Oldest first
      return a.hop - b.hop; // Closer hops first if same time
    });

    return {
      incomingNodes: incoming,
      centerNode: center,
      outgoingNodes: outgoing,
    };
  }, [nodes]);

  const getNodeColorClasses = (node: FlatNode): string => {
    if (node.direction === "center") {
      return "bg-primary text-primary-foreground";
    }
    if (node.isOwned) {
      return "bg-green-500/20 border-green-500 text-green-700 dark:text-green-300";
    }
    if (node.isUnclassified) {
      return "bg-orange-500/20 border-orange-500 text-orange-700 dark:text-orange-300";
    }
    return "bg-muted border-muted-foreground/30";
  };

  const getNodeDotColor = (node: FlatNode): string => {
    if (node.direction === "center") return "text-primary";
    if (node.isOwned) return "text-green-500";
    if (node.isUnclassified) return "text-orange-500";
    return "text-muted-foreground";
  };

  const handleNodeRowClick = useCallback((node: FlatNode) => {
    // Always update local selection for visual highlight
    setSelectedNode(node.id === selectedNode ? null : node.id);
    // Also trigger the sidebar callback if provided
    if (onNodeClick) {
      onNodeClick(node.fullAddress);
    }
  }, [onNodeClick, selectedNode]);

  const renderNode = (node: FlatNode): JSX.Element => {
    const isSelected = selectedNode === node.id;
    // Center has 0 indent, other nodes indent by their absolute hop distance
    const indent = node.direction === "center" ? 0 : Math.abs(node.hop) * 32;

    return (
      <div
        key={node.id}
        role="button"
        tabIndex={0}
        aria-label={`Address ${node.fullAddress} — view record`}
        className={`flex items-center gap-2 py-2 px-3 rounded-lg cursor-pointer transition-colors select-none outline-none focus-visible:ring-1 focus-visible:ring-primary ${
          isSelected ? "bg-primary/10 ring-1 ring-primary" : "hover-elevate"
        }`}
        style={{ marginLeft: `${indent}px` }}
        onClick={() => handleNodeRowClick(node)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleNodeRowClick(node);
          }
        }}
        data-testid={`hop-node-${node.id}`}
      >
        <Circle className={`h-3 w-3 fill-current ${getNodeDotColor(node)}`} />

        <div className={`flex items-center gap-2 px-2 py-1 rounded border ${getNodeColorClasses(node)}`}>
          {node.direction === "center" && <Home className="h-3 w-3" />}
          {node.direction === "source" && (
            <ArrowDown className="h-3 w-3 text-blue-500" />
          )}
          {node.direction === "destination" && (
            <ArrowUp className="h-3 w-3 text-purple-500" />
          )}
          
          <span className="font-mono text-xs">{node.address}</span>
        </div>

        <span className="text-xs text-muted-foreground">
          {formatBtc(node.amount)}
        </span>

        {node.hop !== 0 && (
          <Badge variant="outline" className="text-xs">
            {node.direction === "source" ? `-${Math.abs(node.hop)}` : `+${Math.abs(node.hop)}`}
          </Badge>
        )}

        {node.owner && (
          <Badge variant="secondary" className="text-xs">
            {node.owner}
          </Badge>
        )}

        {node.label && (
          <Badge variant="outline" className="text-xs">
            {node.label}
          </Badge>
        )}

        <span className="text-xs text-muted-foreground ml-auto">
          {node.timestamp}
        </span>

        {onExploreAddress && node.direction !== "center" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                disabled={isLoading}
                onClick={(e) => {
                  e.stopPropagation();
                  handleExplore(node.fullAddress);
                }}
                data-testid={`explore-${node.id}`}
              >
                {isLoading && exploringAddress === node.fullAddress ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ExternalLink className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Explore this address</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  };

  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    
    if (selectedNode === "center") return centerNode;
    
    const allNodes = [...incomingNodes, ...outgoingNodes];
    return allNodes.find(n => n.id === selectedNode) || null;
  }, [selectedNode, centerNode, incomingNodes, outgoingNodes]);

  const selectedNodeLinksData = useMemo(() => {
    if (!selectedNode) return [];
    return nodeLinks.get(selectedNode) || [];
  }, [selectedNode, nodeLinks]);

  if (!centerNode) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <AlertCircle className="h-5 w-5 mr-2" />
        No flow data available
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Badge variant="outline">HOP</Badge>
                  Hop Path Explorer
                </CardTitle>
                <CardDescription>
                  Chronological fund flow. Incoming sources above, outgoing destinations below.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge className="bg-green-500/20 text-green-700 dark:text-green-300 border-green-500">
                  <Circle className="h-2 w-2 fill-green-500 mr-1" />
                  Owned
                </Badge>
                <Badge className="bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-500">
                  <Circle className="h-2 w-2 fill-orange-500 mr-1" />
                  Unclassified
                </Badge>
                <Badge variant="outline">
                  <Circle className="h-2 w-2 fill-muted-foreground mr-1" />
                  External
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[450px]">
              <div className="space-y-1">
                {/* Incoming section */}
                {incomingNodes.length > 0 && (
                  <div className="mb-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 px-3">
                      <ArrowDown className="h-3 w-3 text-blue-500" />
                      <span className="font-medium">INCOMING ({incomingNodes.length})</span>
                      <span className="text-muted-foreground/60">— funds received from these addresses</span>
                    </div>
                    {incomingNodes.map((node, index) => {
                      const currentIndent = Math.abs(node.hop) * 32;
                      const nextNode = incomingNodes[index + 1];
                      const nextIndent = nextNode ? Math.abs(nextNode.hop) * 32 : 0;
                      const showArrow = index < incomingNodes.length - 1 || true;
                      
                      return (
                        <div key={node.id}>
                          {renderNode(node)}
                          {showArrow && (
                            <FlowArrow 
                              fromIndent={currentIndent} 
                              toIndent={nextNode ? nextIndent : 0} 
                              direction="down" 
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Center node */}
                <div className="py-1 border-y border-primary/20 bg-primary/5">
                  {renderNode(centerNode)}
                </div>

                {/* Outgoing section */}
                {outgoingNodes.length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 px-3">
                      <ArrowDown className="h-3 w-3 text-purple-500" />
                      <span className="font-medium">OUTGOING ({outgoingNodes.length})</span>
                      <span className="text-muted-foreground/60">— funds sent to these addresses</span>
                    </div>
                    {outgoingNodes.map((node, index) => {
                      const currentIndent = Math.abs(node.hop) * 32;
                      const showArrow = index < outgoingNodes.length - 1;
                      const nextNode = outgoingNodes[index + 1];
                      const nextIndent = nextNode ? Math.abs(nextNode.hop) * 32 : currentIndent;
                      
                      return (
                        <div key={node.id}>
                          {index === 0 && (
                            <FlowArrow fromIndent={0} toIndent={currentIndent} direction="down" />
                          )}
                          {renderNode(node)}
                          {showArrow && (
                            <FlowArrow 
                              fromIndent={currentIndent} 
                              toIndent={nextIndent} 
                              direction="down" 
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Empty state */}
                {incomingNodes.length === 0 && outgoingNodes.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <p className="text-sm">No connected transactions found for this address</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-1">
        <Card className="sticky top-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Node Details</CardTitle>
            <CardDescription>
              {selectedNodeData ? "Selected address information" : "Click a node to view details"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {selectedNodeData ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">ADDRESS</label>
                  <div className="p-2 bg-muted rounded font-mono text-xs break-all">
                    {selectedNodeData.fullAddress}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">AMOUNT</label>
                    <div className="font-medium">{formatBtc(selectedNodeData.amount)}</div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">DATE</label>
                    <div>{selectedNodeData.timestamp}</div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">HOP</label>
                    <div className="font-medium">
                      {selectedNodeData.hop === 0 ? "Center" : (
                        selectedNodeData.direction === "source" 
                          ? `-${Math.abs(selectedNodeData.hop)}` 
                          : `+${Math.abs(selectedNodeData.hop)}`
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">DIRECTION</label>
                    <div className="flex items-center gap-1">
                      {selectedNodeData.direction === "source" && (
                        <>
                          <ArrowDown className="h-4 w-4 text-blue-500" />
                          Incoming
                        </>
                      )}
                      {selectedNodeData.direction === "destination" && (
                        <>
                          <ArrowUp className="h-4 w-4 text-purple-500" />
                          Outgoing
                        </>
                      )}
                      {selectedNodeData.direction === "center" && (
                        <>
                          <Home className="h-4 w-4 text-primary" />
                          Center
                        </>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">STATUS</label>
                    <div>
                      {selectedNodeData.isOwned && (
                        <Badge className="bg-green-500/20 text-green-700 dark:text-green-300">
                          Owned
                        </Badge>
                      )}
                      {selectedNodeData.isUnclassified && (
                        <Badge className="bg-orange-500/20 text-orange-700 dark:text-orange-300">
                          Unclassified
                        </Badge>
                      )}
                      {!selectedNodeData.isOwned && !selectedNodeData.isUnclassified && (
                        <Badge variant="outline">External</Badge>
                      )}
                    </div>
                  </div>
                </div>

                {selectedNodeData.owner && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">OWNER</label>
                    <div>{selectedNodeData.owner}</div>
                  </div>
                )}

                {selectedNodeData.label && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">LABEL</label>
                    <div>{selectedNodeData.label}</div>
                  </div>
                )}

                {selectedNodeData.txid && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">TRANSACTION</label>
                    <div className="p-2 bg-muted rounded font-mono text-xs break-all">
                      {selectedNodeData.txid}
                    </div>
                  </div>
                )}

                {selectedNodeLinksData.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      LINKED TRANSACTIONS ({selectedNodeLinksData.length})
                    </label>
                    <div className="space-y-1 max-h-24 overflow-y-auto">
                      {selectedNodeLinksData.map((link, idx) => (
                        <div key={`${link.txid}-${idx}`} className="p-2 bg-muted/50 rounded text-xs">
                          <div className="font-mono truncate">{link.txid}</div>
                          <div className="text-muted-foreground">{formatBtc(link.value)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {onExploreAddress && selectedNodeData.direction !== "center" && (
                  <div className="space-y-2">
                    <Button 
                      className="w-full"
                      disabled={isLoading}
                      onClick={() => handleExplore(selectedNodeData.fullAddress)}
                      data-testid="button-explore-selected"
                    >
                      {isLoading && exploringAddress === selectedNodeData.fullAddress ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <ExternalLink className="h-4 w-4 mr-2" />
                      )}
                      {isLoading && exploringAddress === selectedNodeData.fullAddress 
                        ? "Tracing..." 
                        : "Explore This Address"}
                    </Button>
                    <p className="text-xs text-muted-foreground text-center">
                      Click to trace this address and see its connections
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Circle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Select a node from the list to view its details</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
