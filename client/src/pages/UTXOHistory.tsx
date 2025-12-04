import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  Search, Loader2, Database, Globe, AlertCircle, 
  Copy, ExternalLink, Eye, EyeOff
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { useFlowData, type FlowNode } from "@/hooks/use-flow-data";
import { useToast } from "@/hooks/use-toast";

type NodeClassification = 
  | "selected"      
  | "unspent"       
  | "earliest"      
  | "known"         
  | "unknown-between"
  | "unknown-external";

interface HistoryNode {
  id: string;
  address: string;
  fullAddress: string;
  amount: number;
  date: string;
  classification: NodeClassification;
  side: "left" | "right" | "center";
  depth: number;
  txid?: string;
  isLabeled: boolean;
}

const classifyNode = (node: FlowNode, index: number, allNodes: FlowNode[]): NodeClassification => {
  if (node.type === "selected") return "selected";
  
  if (node.isLabeled) {
    if (node.type === "input" && index === 0) return "earliest";
    return "known";
  }
  
  const hasLabeledNeighbors = allNodes.some(n => n.isLabeled && n.id !== node.id);
  if (hasLabeledNeighbors) return "unknown-between";
  
  return "unknown-external";
};

const getNodeColor = (classification: NodeClassification): string => {
  switch (classification) {
    case "selected": return "#f97316";
    case "unspent": return "url(#gradient-unspent)";
    case "earliest": return "#22c55e";
    case "known": return "#f97316";
    case "unknown-between": return "#ef4444";
    case "unknown-external": return "#ef4444";
    default: return "#6b7280";
  }
};

const getNodeStroke = (classification: NodeClassification): string => {
  switch (classification) {
    case "unknown-between":
    case "unknown-external":
      return "#ef4444";
    default:
      return "none";
  }
};

const formatBtc = (amount: number): string => {
  return amount.toFixed(amount < 0.001 ? 8 : 3);
};

const formatDate = (dateStr: string): string => {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: '2-digit', 
      year: '2-digit' 
    }).toUpperCase();
  } catch {
    return dateStr;
  }
};

const UTXONode = ({ 
  node, 
  x, 
  y, 
  onHover, 
  onClick 
}: { 
  node: HistoryNode;
  x: number;
  y: number;
  onHover: (node: HistoryNode | null) => void;
  onClick: (node: HistoryNode) => void;
}) => {
  const isUnknown = node.classification === "unknown-between" || node.classification === "unknown-external";
  const isTriangle = node.classification === "unknown-external";
  const radius = node.classification === "selected" ? 12 : 8;
  
  return (
    <g
      transform={`translate(${x}, ${y})`}
      onMouseEnter={() => onHover(node)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onClick(node)}
      style={{ cursor: "pointer" }}
      data-testid={`node-${node.id}`}
    >
      {isTriangle ? (
        <polygon
          points="0,-10 8,6 -8,6"
          fill="none"
          stroke="#ef4444"
          strokeWidth={2}
        />
      ) : isUnknown ? (
        <>
          <circle r={radius} fill="none" stroke="#ef4444" strokeWidth={2} />
          <line x1={-5} y1={-5} x2={5} y2={5} stroke="#ef4444" strokeWidth={2} />
        </>
      ) : node.classification === "unspent" ? (
        <>
          <defs>
            <linearGradient id={`grad-${node.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="50%" stopColor="#f97316" />
              <stop offset="50%" stopColor="#22c55e" />
            </linearGradient>
          </defs>
          <circle r={radius} fill={`url(#grad-${node.id})`} />
        </>
      ) : (
        <circle 
          r={radius} 
          fill={getNodeColor(node.classification)} 
          stroke={getNodeStroke(node.classification)}
          strokeWidth={2}
        />
      )}
    </g>
  );
};

const NodeLabel = ({
  node,
  x,
  y,
  side
}: {
  node: HistoryNode;
  x: number;
  y: number;
  side: "left" | "right";
}) => {
  const textAnchor = side === "left" ? "end" : "start";
  const offsetX = side === "left" ? -20 : 20;
  
  return (
    <g transform={`translate(${x + offsetX}, ${y})`}>
      <text
        textAnchor={textAnchor}
        dominantBaseline="middle"
        className="text-xs fill-muted-foreground"
        style={{ fontSize: "11px" }}
      >
        {formatDate(node.date)}
      </text>
      <text
        y={16}
        textAnchor={textAnchor}
        dominantBaseline="middle"
        className="text-xs fill-foreground font-mono"
        style={{ fontSize: "11px" }}
      >
        BTC: {formatBtc(node.amount)}
      </text>
    </g>
  );
};

export default function UTXOHistory() {
  const [searchAddress, setSearchAddress] = useState("");
  const [allowBlockchainApi, setAllowBlockchainApi] = useState(false);
  const [hideFees, setHideFees] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<HistoryNode | null>(null);
  const [clickedNodeId, setClickedNodeId] = useState<string | null>(null);
  const { flowData, isLoading, error, dataSource, fetchFlow } = useFlowData();
  const { toast } = useToast();

  const handleSearch = () => {
    if (!searchAddress.trim()) return;
    setClickedNodeId(null);
    fetchFlow(searchAddress.trim(), 10, allowBlockchainApi);
  };

  const handleCopyAddress = () => {
    if (selectedUtxo?.fullAddress) {
      navigator.clipboard.writeText(selectedUtxo.fullAddress);
      toast({ title: "Address copied to clipboard" });
    }
  };

  const historyNodes = useMemo((): HistoryNode[] => {
    if (!flowData) return [];
    
    const nodes: HistoryNode[] = [];
    const inputNodes = flowData.nodes.filter(n => n.type === "input");
    const outputNodes = flowData.nodes.filter(n => n.type === "output");
    const centerNode = flowData.nodes.find(n => n.type === "selected");
    
    if (centerNode) {
      nodes.push({
        id: centerNode.id,
        address: centerNode.address,
        fullAddress: searchAddress,
        amount: centerNode.amount,
        date: centerNode.timestamp,
        classification: "selected",
        side: "center",
        depth: 0,
        txid: centerNode.txid,
        isLabeled: centerNode.isLabeled,
      });
    }
    
    inputNodes.forEach((node, idx) => {
      const isEarliest = idx === inputNodes.length - 1;
      const isUnspent = node.isLabeled && node.type === "input";
      
      let classification: NodeClassification;
      if (isUnspent && isEarliest) {
        classification = "unspent";
      } else if (isEarliest && node.isLabeled) {
        classification = "earliest";
      } else {
        classification = classifyNode(node, idx, flowData.nodes);
      }
      
      nodes.push({
        id: node.id,
        address: node.address,
        fullAddress: node.address,
        amount: node.amount,
        date: node.timestamp,
        classification,
        side: "left",
        depth: idx + 1,
        txid: node.txid,
        isLabeled: node.isLabeled,
      });
    });
    
    outputNodes.forEach((node, idx) => {
      nodes.push({
        id: node.id,
        address: node.address,
        fullAddress: node.address,
        amount: node.amount,
        date: node.timestamp,
        classification: classifyNode(node, idx, flowData.nodes),
        side: "right",
        depth: idx + 1,
        txid: node.txid,
        isLabeled: node.isLabeled,
      });
    });
    
    return nodes;
  }, [flowData, searchAddress]);

  const derivedSelectedUtxo = useMemo((): HistoryNode | null => {
    if (!flowData) return null;
    const centerNode = flowData.nodes.find(n => n.type === "selected");
    if (!centerNode) return null;
    
    return {
      id: centerNode.id,
      address: centerNode.address,
      fullAddress: searchAddress,
      amount: centerNode.amount,
      date: centerNode.timestamp,
      classification: "selected" as NodeClassification,
      side: "center" as const,
      depth: 0,
      txid: centerNode.txid,
      isLabeled: centerNode.isLabeled,
    };
  }, [flowData, searchAddress]);

  const selectedUtxo = useMemo((): HistoryNode | null => {
    if (clickedNodeId) {
      return historyNodes.find(n => n.id === clickedNodeId) || derivedSelectedUtxo;
    }
    return derivedSelectedUtxo;
  }, [clickedNodeId, historyNodes, derivedSelectedUtxo]);

  const svgHeight = Math.max(400, historyNodes.length * 60 + 100);
  const centerX = 300;

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <SiBitcoin className="h-8 w-8 text-primary" />
            UTXO History
          </h1>
          <p className="text-muted-foreground">
            Trace the complete history of a UTXO through the blockchain.
          </p>
        </div>

        <Card className="bg-card/50 border-primary/20">
          <CardContent className="pt-6 space-y-4">
            <div className="flex flex-col md:flex-row gap-4 items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="utxo-search" className="text-xs font-medium flex items-center gap-1">
                  <Search className="h-3 w-3" />
                  TXID or Address
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="utxo-search"
                    placeholder="Enter txid or address..."
                    value={searchAddress}
                    onChange={(e) => setSearchAddress(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="font-mono text-sm bg-background"
                    data-testid="input-utxo-search"
                  />
                  <Button 
                    onClick={handleSearch} 
                    disabled={!searchAddress.trim() || isLoading}
                    data-testid="button-search"
                  >
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={allowBlockchainApi}
                    onCheckedChange={setAllowBlockchainApi}
                    data-testid="switch-blockchain-api"
                  />
                  <Label className="text-xs">
                    <Globe className="h-3 w-3 inline mr-1" />
                    API
                  </Label>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {flowData && historyNodes.length > 0 && (
          <Card className="bg-zinc-900 border-zinc-800">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="text-center flex-1">
                  <h3 className="text-lg font-semibold text-zinc-100">
                    Here's what you know about your UTXO's history
                  </h3>
                  <p className="text-xs text-zinc-400">
                    mouse over transaction to preview your data
                  </p>
                  <p className="text-xs text-zinc-500">
                    click to load transaction detail page
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setHideFees(!hideFees)}
                  className="text-xs text-zinc-400"
                  data-testid="button-toggle-fees"
                >
                  {hideFees ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
                  {hideFees ? "Show" : "Hide"} Fees
                </Button>
              </div>

              <svg 
                width="100%" 
                height={svgHeight} 
                viewBox={`0 0 600 ${svgHeight}`}
                className="overflow-visible"
              >
                <defs>
                  <linearGradient id="gradient-unspent" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="50%" stopColor="#f97316" />
                    <stop offset="50%" stopColor="#22c55e" />
                  </linearGradient>
                </defs>

                {historyNodes.map((node, idx) => {
                  if (node.side === "center") return null;
                  
                  const y = 50 + node.depth * 60;
                  const nodeX = node.side === "left" ? centerX - 80 : centerX + 80;
                  
                  return (
                    <g key={`line-${node.id}`}>
                      <line
                        x1={centerX}
                        y1={50 + (node.depth - 1) * 60 + 20}
                        x2={centerX}
                        y2={y}
                        stroke="#f97316"
                        strokeWidth={2}
                        strokeDasharray={node.classification.startsWith("unknown") ? "4,4" : "none"}
                      />
                      <line
                        x1={centerX}
                        y1={y}
                        x2={nodeX}
                        y2={y}
                        stroke="#f97316"
                        strokeWidth={2}
                        strokeDasharray={node.classification.startsWith("unknown") ? "4,4" : "none"}
                      />
                    </g>
                  );
                })}

                {historyNodes.map((node, idx) => {
                  let x: number, y: number;
                  
                  if (node.side === "center") {
                    x = centerX;
                    y = 50;
                  } else {
                    y = 50 + node.depth * 60;
                    x = node.side === "left" ? centerX - 80 : centerX + 80;
                  }
                  
                  return (
                    <g key={node.id}>
                      <UTXONode
                        node={node}
                        x={x}
                        y={y}
                        onHover={setHoveredNode}
                        onClick={(n) => setClickedNodeId(n.id)}
                      />
                      {node.side !== "center" && (
                        <NodeLabel
                          node={node}
                          x={x}
                          y={y}
                          side={node.side}
                        />
                      )}
                    </g>
                  );
                })}

                {hoveredNode && (
                  <g>
                    <rect
                      x={centerX - 100}
                      y={svgHeight - 80}
                      width={200}
                      height={60}
                      rx={4}
                      fill="rgba(0,0,0,0.9)"
                      stroke="#f97316"
                    />
                    <text
                      x={centerX}
                      y={svgHeight - 55}
                      textAnchor="middle"
                      className="text-xs fill-zinc-100 font-mono"
                      style={{ fontSize: "10px" }}
                    >
                      {hoveredNode.address}
                    </text>
                    <text
                      x={centerX}
                      y={svgHeight - 38}
                      textAnchor="middle"
                      className="text-xs fill-zinc-400"
                      style={{ fontSize: "10px" }}
                    >
                      {formatDate(hoveredNode.date)} • {formatBtc(hoveredNode.amount)} BTC
                    </text>
                  </g>
                )}
              </svg>

              <div className="mt-6 pt-4 border-t border-zinc-700">
                <h4 className="text-sm font-semibold text-zinc-300 mb-3">Taxonomy:</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <circle cx="8" cy="8" r="6" fill="#f97316" />
                    </svg>
                    <span className="text-zinc-400">= Selected UTXO</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <defs>
                        <linearGradient id="legend-unspent" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="50%" stopColor="#f97316" />
                          <stop offset="50%" stopColor="#22c55e" />
                        </linearGradient>
                      </defs>
                      <circle cx="8" cy="8" r="5" fill="url(#legend-unspent)" />
                    </svg>
                    <span className="text-zinc-400">= Known History & Currently Unspent</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <circle cx="8" cy="8" r="5" fill="#22c55e" />
                    </svg>
                    <span className="text-zinc-400">= Earliest Known History (assumed Original Acquisition)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <circle cx="8" cy="8" r="5" fill="#f97316" />
                    </svg>
                    <span className="text-zinc-400">= Known History</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <circle cx="8" cy="8" r="5" fill="none" stroke="#ef4444" strokeWidth="2" />
                      <line x1="5" y1="5" x2="11" y2="11" stroke="#ef4444" strokeWidth="2" />
                    </svg>
                    <span className="text-zinc-400">= Unknown History (zero meta data) but between known trans.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <polygon points="8,2 14,12 2,12" fill="none" stroke="#ef4444" strokeWidth="2" />
                    </svg>
                    <span className="text-zinc-400">= Unknown History but not between known transactions</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {selectedUtxo && (
          <Card className="bg-zinc-900 border-zinc-800">
            <CardContent className="p-6">
              <h4 className="text-sm font-semibold text-zinc-300 mb-4">Selected UTXO</h4>
              
              <div className="bg-zinc-800 rounded-lg p-4 mb-4">
                <div className="flex items-center justify-between gap-2">
                  <code className="text-sm font-mono text-zinc-100 break-all flex-1">
                    {selectedUtxo.fullAddress}
                  </code>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleCopyAddress}
                      className="h-8 w-8 text-zinc-400 hover:text-zinc-100"
                      data-testid="button-copy-address"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-zinc-400 hover:text-zinc-100"
                      data-testid="button-external-link"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end mb-4">
                <Badge className="bg-primary/20 text-primary border-primary/30 text-sm px-3 py-1">
                  UTXO-{historyNodes.findIndex(n => n.id === selectedUtxo.id) + 1} &nbsp; {formatBtc(selectedUtxo.amount)} BTC
                </Badge>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <h5 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    Change Since Last Movement
                  </h5>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">UTXO Age:</span>
                      <span className="text-zinc-100">-- days</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Entry Value:</span>
                      <span className="text-zinc-100">$--,---.--</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Today's Value:</span>
                      <span className="text-zinc-100">$--,---.--</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Gain/Loss:</span>
                      <span className="text-emerald-400">+$--,---.--</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h5 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    Change Since Original Acquisition
                  </h5>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">HODL Age:</span>
                      <span className="text-zinc-100">-- y -- d</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Gross Investment:</span>
                      <span className="text-zinc-100">$--,---.--</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Acquisition BTC Value:</span>
                      <span className="text-zinc-100">$--,---.--</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">HODL Gain/Loss:</span>
                      <span className="text-red-400">-$--,---</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {dataSource && (
          <div className="flex items-center gap-2 text-sm">
            {dataSource === 'local' ? (
              <Badge variant="outline" className="gap-1">
                <Database className="h-3 w-3" />
                Data from local database
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <Globe className="h-3 w-3" />
                Data from blockchain API
              </Badge>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
