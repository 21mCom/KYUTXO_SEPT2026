import { useState, useMemo, useCallback, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  ChevronRight, ChevronDown, Circle, ArrowRight, 
  ExternalLink, Home, Loader2, AlertCircle
} from "lucide-react";
import { ClickableAddress } from "@/components/ClickableAddress";
import { type FlowNode, type FlowLink } from "@/hooks/use-flow-data";

interface HopPathNode {
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
  children: HopPathNode[];
  isExpanded: boolean;
}

interface HopPathExplorerProps {
  nodes: FlowNode[];
  links: FlowLink[];
  centerAddress: string;
  onExploreAddress?: (address: string) => void;
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

export function HopPathExplorer({ 
  nodes, 
  links, 
  centerAddress,
  onExploreAddress,
  isLoading = false
}: HopPathExplorerProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(["center"]));
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [exploringAddress, setExploringAddress] = useState<string | null>(null);

  const handleExplore = useCallback((address: string) => {
    if (onExploreAddress && !isLoading) {
      setExploringAddress(address);
      onExploreAddress(address);
    }
  }, [onExploreAddress, isLoading]);

  // Clear exploringAddress when loading completes
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

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const pathTree = useMemo((): HopPathNode | null => {
    const centerNode = nodes.find(n => n.type === "selected");
    if (!centerNode) return null;

    // Create a map of node ID to FlowNode for quick lookup
    const nodeMap = new Map<string, FlowNode>();
    nodes.forEach(n => nodeMap.set(n.id, n));

    // Build adjacency list from links
    // For incoming: link.target is parent, link.source is child
    // For outgoing: link.source is parent, link.target is child
    const childrenMap = new Map<string, { nodeId: string; direction: "source" | "destination" }[]>();
    
    links.forEach(link => {
      const sourceNode = nodeMap.get(link.source);
      const targetNode = nodeMap.get(link.target);
      
      if (sourceNode && targetNode) {
        // Determine direction based on node types
        if (sourceNode.type === "input" && (targetNode.type === "selected" || targetNode.type === "input")) {
          // Incoming flow: target is parent of source
          if (!childrenMap.has(link.target)) childrenMap.set(link.target, []);
          childrenMap.get(link.target)!.push({ nodeId: link.source, direction: "source" });
        } else if (targetNode.type === "output" && (sourceNode.type === "selected" || sourceNode.type === "output")) {
          // Outgoing flow: source is parent of target
          if (!childrenMap.has(link.source)) childrenMap.set(link.source, []);
          childrenMap.get(link.source)!.push({ nodeId: link.target, direction: "destination" });
        }
      }
    });

    // Build tree recursively
    const buildHopNode = (flowNode: FlowNode, direction: "source" | "center" | "destination", visited: Set<string>): HopPathNode => {
      const { isOwned, isUnclassified } = getNodeStatus(flowNode);
      
      // Get children for this node, avoiding cycles
      const childRefs = childrenMap.get(flowNode.id) || [];
      const children: HopPathNode[] = [];
      
      for (const childRef of childRefs) {
        if (!visited.has(childRef.nodeId)) {
          const childNode = nodeMap.get(childRef.nodeId);
          if (childNode) {
            visited.add(childRef.nodeId);
            children.push(buildHopNode(childNode, childRef.direction, visited));
          }
        }
      }
      
      return {
        id: flowNode.id === "selected" ? "center" : flowNode.id,
        address: flowNode.address.length > 16 
          ? `${flowNode.address.slice(0, 8)}...${flowNode.address.slice(-6)}`
          : flowNode.address,
        fullAddress: flowNode.address,
        amount: flowNode.amount,
        timestamp: flowNode.timestamp,
        hop: flowNode.hop,
        direction,
        isOwned,
        isUnclassified,
        owner: flowNode.owner,
        label: flowNode.label,
        txid: flowNode.txid,
        children,
        isExpanded: flowNode.id === "selected",
      };
    };

    const visited = new Set<string>(["selected"]);
    return buildHopNode(centerNode, "center", visited);
  }, [nodes, links]);

  const getNodeColorClasses = (node: HopPathNode): string => {
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

  const getNodeDotColor = (node: HopPathNode): string => {
    if (node.direction === "center") return "text-primary";
    if (node.isOwned) return "text-green-500";
    if (node.isUnclassified) return "text-orange-500";
    return "text-muted-foreground";
  };

  const renderTreeNode = (node: HopPathNode, depth: number = 0): JSX.Element => {
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const isSelected = selectedNode === node.id;
    const indent = depth * 24;

    const sourceChildren = node.children.filter(c => c.direction === "source");
    const destChildren = node.children.filter(c => c.direction === "destination");

    return (
      <div key={node.id} className="select-none">
        <div
          className={`flex items-center gap-2 py-2 px-3 rounded-lg cursor-pointer transition-colors ${
            isSelected ? "bg-primary/10 ring-1 ring-primary" : "hover-elevate"
          }`}
          style={{ marginLeft: `${indent}px` }}
          onClick={() => setSelectedNode(node.id === selectedNode ? null : node.id)}
          data-testid={`hop-node-${node.id}`}
        >
          {hasChildren ? (
            <button 
              onClick={(e) => { e.stopPropagation(); toggleNode(node.id); }}
              className="p-0.5 rounded hover:bg-muted"
              data-testid={`toggle-${node.id}`}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          ) : (
            <div className="w-5" />
          )}

          <Circle className={`h-3 w-3 fill-current ${getNodeDotColor(node)}`} />

          <div className={`flex items-center gap-2 px-2 py-1 rounded border ${getNodeColorClasses(node)}`}>
            {node.direction === "center" && <Home className="h-3 w-3" />}
            {node.direction === "source" && (
              <ArrowRight className="h-3 w-3 rotate-180 text-blue-500" />
            )}
            {node.direction === "destination" && (
              <ArrowRight className="h-3 w-3 text-purple-500" />
            )}
            
            <span className="font-mono text-xs">{node.address}</span>
          </div>

          <span className="text-xs text-muted-foreground">
            {formatBtc(node.amount)}
          </span>

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

        {isExpanded && hasChildren && (
          <div className="relative">
            <div 
              className="absolute left-0 top-0 bottom-0 w-px bg-border"
              style={{ marginLeft: `${indent + 14}px` }}
            />
            
            {sourceChildren.length > 0 && (
              <div className="mb-2">
                <div 
                  className="text-xs text-muted-foreground py-1 px-2 flex items-center gap-1"
                  style={{ marginLeft: `${indent + 24}px` }}
                >
                  <ArrowRight className="h-3 w-3 rotate-180 text-blue-500" />
                  Received from ({sourceChildren.length})
                </div>
                {sourceChildren.map(child => renderTreeNode(child, depth + 1))}
              </div>
            )}
            
            {destChildren.length > 0 && (
              <div>
                <div 
                  className="text-xs text-muted-foreground py-1 px-2 flex items-center gap-1"
                  style={{ marginLeft: `${indent + 24}px` }}
                >
                  <ArrowRight className="h-3 w-3 text-purple-500" />
                  Sent to ({destChildren.length})
                </div>
                {destChildren.map(child => renderTreeNode(child, depth + 1))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const selectedNodeData = useMemo(() => {
    if (!selectedNode || !pathTree) return null;
    
    if (selectedNode === "center") return pathTree;
    
    const findNodeRecursive = (node: HopPathNode): HopPathNode | null => {
      if (node.id === selectedNode) return node;
      for (const child of node.children) {
        const found = findNodeRecursive(child);
        if (found) return found;
      }
      return null;
    };
    
    return findNodeRecursive(pathTree);
  }, [selectedNode, pathTree]);

  const selectedNodeLinksData = useMemo(() => {
    if (!selectedNode) return [];
    return nodeLinks.get(selectedNode) || [];
  }, [selectedNode, nodeLinks]);

  if (!pathTree) {
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
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Badge variant="outline">HOP</Badge>
                  Hop Path Explorer
                </CardTitle>
                <CardDescription>
                  Interactive tree showing fund flow. Click nodes to select. Click explore to drill into deeper hops.
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
              {renderTreeNode(pathTree)}
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
                        selectedNodeData.hop > 0 ? `+${selectedNodeData.hop}` : selectedNodeData.hop
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
                          <ArrowRight className="h-4 w-4 rotate-180 text-blue-500" />
                          Incoming
                        </>
                      )}
                      {selectedNodeData.direction === "destination" && (
                        <>
                          <ArrowRight className="h-4 w-4 text-purple-500" />
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

                {selectedNodeData.children.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">CONNECTIONS</label>
                    <div className="flex gap-2">
                      <Badge variant="secondary">
                        {selectedNodeData.children.filter(c => c.direction === "source").length} incoming
                      </Badge>
                      <Badge variant="secondary">
                        {selectedNodeData.children.filter(c => c.direction === "destination").length} outgoing
                      </Badge>
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
                <p className="text-sm">Select a node from the tree to view its details</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
