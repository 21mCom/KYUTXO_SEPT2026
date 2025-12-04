import { useState, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, 
  ResponsiveContainer, Tooltip as RechartsTooltip, Legend
} from "recharts";
import { 
  Search, Info, GitBranch, Clock, TrendingUp, 
  ArrowRight, Loader2, Database, Globe, AlertCircle
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { useFlowData, type FlowNode } from "@/hooks/use-flow-data";

const generateLineChartData = (nodes: FlowNode[]) => {
  const sortedNodes = [...nodes]
    .filter(n => n.type !== "selected")
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  
  let runningBalance = 0;
  return sortedNodes.map(node => {
    if (node.type === "input") {
      runningBalance += node.amount;
    } else if (node.type === "output") {
      runningBalance -= node.amount;
    }
    return {
      date: node.timestamp,
      balance: Number(runningBalance.toFixed(8)),
      amount: node.amount,
      type: node.type,
      address: node.address
    };
  });
};

export default function BitcoinFlowVisualizer() {
  const [searchAddress, setSearchAddress] = useState("");
  const [hopDepth, setHopDepth] = useState([3]);
  const { flowData, isLoading, error, dataSource, fetchFlow } = useFlowData();

  const lineChartData = useMemo(() => {
    if (!flowData) return [];
    return generateLineChartData(flowData.nodes);
  }, [flowData]);

  const handleSearch = () => {
    if (!searchAddress.trim()) return;
    fetchFlow(searchAddress.trim(), hopDepth[0]);
  };

  const getNodeColor = (type: string) => {
    switch (type) {
      case "input": return "hsl(var(--chart-1))";
      case "selected": return "hsl(var(--primary))";
      case "output": return "hsl(var(--chart-2))";
      default: return "hsl(var(--muted))";
    }
  };

  const inputNodes = flowData?.nodes.filter(n => n.type === "input") || [];
  const outputNodes = flowData?.nodes.filter(n => n.type === "output") || [];
  const selectedNode = flowData?.nodes.find(n => n.type === "selected");

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <SiBitcoin className="h-8 w-8 text-primary" />
            Bitcoin Flow Visualizer
          </h1>
          <p className="text-muted-foreground">
            Trace UTXO provenance through the blockchain. Enter an address to visualize its transaction flow.
          </p>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="address-search" className="text-xs font-medium flex items-center gap-1">
                  <Search className="h-3 w-3" />
                  Bitcoin Address
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="address-search"
                    placeholder="Enter Bitcoin address (e.g., bc1q...)"
                    value={searchAddress}
                    onChange={(e) => setSearchAddress(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="font-mono text-sm"
                    data-testid="input-address-search"
                  />
                  <Button 
                    onClick={handleSearch} 
                    disabled={!searchAddress.trim() || isLoading}
                    data-testid="button-search"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Tracing...
                      </>
                    ) : (
                      "Trace"
                    )}
                  </Button>
                </div>
              </div>

              <div className="w-full md:w-64 space-y-2">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  Hop Depth
                </Label>
                <div className="flex items-center gap-4">
                  <Slider
                    value={hopDepth}
                    onValueChange={setHopDepth}
                    min={1}
                    max={10}
                    step={1}
                    className="flex-1"
                    data-testid="slider-hop-depth"
                  />
                  <Badge variant="secondary" className="min-w-[3rem] justify-center">
                    {hopDepth[0]} hops
                  </Badge>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Info className="h-3 w-3" />
              <span>Traces transaction history to show where funds came from and where they went.</span>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
            <span className="text-muted-foreground">
              Found {inputNodes.length} inputs, {outputNodes.length} outputs
            </span>
          </div>
        )}

        {flowData && (
          <Tabs defaultValue="sankey" className="space-y-4">
            <TabsList className="grid w-full grid-cols-3" data-testid="tabs-visualization">
              <TabsTrigger value="sankey" className="flex items-center gap-2" data-testid="tab-sankey">
                <GitBranch className="h-4 w-4" />
                Sankey Diagram
              </TabsTrigger>
              <TabsTrigger value="timeline" className="flex items-center gap-2" data-testid="tab-timeline">
                <Clock className="h-4 w-4" />
                Timeline Swimlanes
              </TabsTrigger>
              <TabsTrigger value="linechart" className="flex items-center gap-2" data-testid="tab-linechart">
                <TrendingUp className="h-4 w-4" />
                Line Chart
              </TabsTrigger>
            </TabsList>

            <TabsContent value="sankey" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-1</Badge>
                    Sankey Flow Diagram
                  </CardTitle>
                  <CardDescription>
                    Visual flow showing BTC moving between addresses. Band width represents value.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[500px] bg-muted/20 rounded-lg p-6 relative overflow-hidden">
                    <svg viewBox="0 0 800 400" className="w-full h-full">
                      <defs>
                        <linearGradient id="inputGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity="0.8" />
                          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.6" />
                        </linearGradient>
                        <linearGradient id="outputGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.6" />
                          <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity="0.8" />
                        </linearGradient>
                      </defs>

                      {inputNodes.slice(0, 6).map((node, i) => {
                        const totalNodes = Math.min(inputNodes.length, 6);
                        const spacing = 350 / (totalNodes + 1);
                        const y = spacing * (i + 1);
                        const height = Math.max(20, Math.min(40, node.amount * 80));
                        return (
                          <g key={node.id}>
                            <path
                              d={`M 120 ${y} C 250 ${y}, 280 200, 350 ${180 + (i - totalNodes/2) * 20}`}
                              fill="none"
                              stroke="url(#inputGrad)"
                              strokeWidth={height / 3}
                              opacity="0.6"
                            />
                            <rect
                              x="20"
                              y={y - height/2}
                              width="100"
                              height={height}
                              rx="4"
                              fill="hsl(var(--chart-1))"
                              opacity="0.8"
                            />
                            <text x="70" y={y + 4} textAnchor="middle" className="fill-current text-xs font-mono">
                              {node.address}
                            </text>
                            <text x="70" y={y + 18} textAnchor="middle" className="fill-muted-foreground text-xs">
                              {node.amount.toFixed(4)} BTC
                            </text>
                          </g>
                        );
                      })}

                      {selectedNode && (
                        <g>
                          <rect
                            x="350"
                            y="150"
                            width="100"
                            height="100"
                            rx="8"
                            fill="hsl(var(--primary))"
                            opacity="0.9"
                          />
                          <text x="400" y="195" textAnchor="middle" className="fill-primary-foreground text-xs font-bold">
                            SELECTED
                          </text>
                          <text x="400" y="215" textAnchor="middle" className="fill-primary-foreground text-xs font-mono">
                            {selectedNode.amount.toFixed(4)} BTC
                          </text>
                        </g>
                      )}

                      {outputNodes.slice(0, 6).map((node, i) => {
                        const totalNodes = Math.min(outputNodes.length, 6);
                        const spacing = 350 / (totalNodes + 1);
                        const y = spacing * (i + 1);
                        const height = Math.max(20, Math.min(40, node.amount * 80));
                        return (
                          <g key={node.id}>
                            <path
                              d={`M 450 ${200 + (i - totalNodes/2) * 20} C 520 ${200 + (i - totalNodes/2) * 20}, 550 ${y}, 680 ${y}`}
                              fill="none"
                              stroke="url(#outputGrad)"
                              strokeWidth={height / 3}
                              opacity="0.6"
                            />
                            <rect
                              x="680"
                              y={y - height/2}
                              width="100"
                              height={height}
                              rx="4"
                              fill="hsl(var(--chart-2))"
                              opacity="0.8"
                            />
                            <text x="730" y={y + 4} textAnchor="middle" className="fill-current text-xs font-mono">
                              {node.address}
                            </text>
                            <text x="730" y={y + 18} textAnchor="middle" className="fill-muted-foreground text-xs">
                              {node.amount.toFixed(4)} BTC
                            </text>
                          </g>
                        );
                      })}
                    </svg>

                    <div className="absolute bottom-4 left-4 flex items-center gap-4 text-xs">
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 rounded" style={{ background: "hsl(var(--chart-1))" }} />
                        <span>Inputs ({inputNodes.length})</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 rounded" style={{ background: "hsl(var(--primary))" }} />
                        <span>Selected</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 rounded" style={{ background: "hsl(var(--chart-2))" }} />
                        <span>Outputs ({outputNodes.length})</span>
                      </div>
                    </div>

                    {inputNodes.length > 6 || outputNodes.length > 6 ? (
                      <div className="absolute bottom-4 right-4 text-xs text-muted-foreground">
                        Showing top 6 of each. {inputNodes.length + outputNodes.length} total addresses.
                      </div>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="timeline" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-2</Badge>
                    Timeline Swimlanes
                  </CardTitle>
                  <CardDescription>
                    UTXOs organized by time, with swim lanes showing address relationships.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground border-b">
                      <div className="w-8">Hop</div>
                      <div className="w-24">Date</div>
                      <div className="w-32">Address</div>
                      <div className="flex-1">Flow</div>
                      <div className="w-24 text-right">Amount</div>
                      <div className="w-24 text-right">Owner</div>
                    </div>
                    
                    <ScrollArea className="h-[400px]">
                      <div className="space-y-1">
                        {inputNodes.map((node) => (
                          <div 
                            key={node.id}
                            className="flex items-center gap-2 px-2 py-2 rounded hover-elevate text-sm"
                            data-testid={`timeline-row-${node.id}`}
                          >
                            <Badge variant="outline" className="w-8 justify-center text-xs">
                              {node.hop}
                            </Badge>
                            <div className="w-24 text-xs text-muted-foreground">{node.timestamp}</div>
                            <div className="w-32 font-mono text-xs truncate" title={node.address}>{node.address}</div>
                            <div className="flex-1 flex items-center gap-1">
                              <div 
                                className="h-4 rounded"
                                style={{ 
                                  width: `${Math.max(20, Math.min(150, node.amount * 150))}px`,
                                  background: getNodeColor(node.type)
                                }}
                              />
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            </div>
                            <div className="w-24 text-right font-mono text-xs">{node.amount.toFixed(4)} BTC</div>
                            <div className="w-24 text-right">
                              {node.owner && <Badge variant="secondary" className="text-xs">{node.owner}</Badge>}
                              {node.isLabeled && !node.owner && <Badge variant="outline" className="text-xs">Labeled</Badge>}
                            </div>
                          </div>
                        ))}

                        {selectedNode && (
                          <div className="flex items-center gap-2 px-2 py-3 rounded bg-primary/10 border border-primary/20">
                            <Badge className="w-8 justify-center text-xs">0</Badge>
                            <div className="w-24 text-xs">{selectedNode.timestamp}</div>
                            <div className="w-32 font-mono text-xs font-bold truncate" title={selectedNode.address}>{selectedNode.address}</div>
                            <div className="flex-1 flex items-center gap-1">
                              <div 
                                className="h-6 rounded flex items-center justify-center text-xs text-primary-foreground font-medium"
                                style={{ 
                                  width: "120px",
                                  background: "hsl(var(--primary))"
                                }}
                              >
                                SELECTED
                              </div>
                            </div>
                            <div className="w-24 text-right font-mono text-sm font-bold">{selectedNode.amount.toFixed(4)} BTC</div>
                            <div className="w-24 text-right">
                              {selectedNode.owner && <Badge>{selectedNode.owner}</Badge>}
                            </div>
                          </div>
                        )}

                        {outputNodes.map((node) => (
                          <div 
                            key={node.id}
                            className="flex items-center gap-2 px-2 py-2 rounded hover-elevate text-sm"
                            data-testid={`timeline-row-${node.id}`}
                          >
                            <Badge variant="outline" className="w-8 justify-center text-xs">
                              +{node.hop}
                            </Badge>
                            <div className="w-24 text-xs text-muted-foreground">{node.timestamp}</div>
                            <div className="w-32 font-mono text-xs truncate" title={node.address}>{node.address}</div>
                            <div className="flex-1 flex items-center gap-1">
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                              <div 
                                className="h-4 rounded"
                                style={{ 
                                  width: `${Math.max(20, Math.min(150, node.amount * 150))}px`,
                                  background: getNodeColor(node.type)
                                }}
                              />
                            </div>
                            <div className="w-24 text-right font-mono text-xs">{node.amount.toFixed(4)} BTC</div>
                            <div className="w-24 text-right">
                              {node.owner && <Badge variant="secondary" className="text-xs">{node.owner}</Badge>}
                              {node.isLabeled && !node.owner && <Badge variant="outline" className="text-xs">Labeled</Badge>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="linechart" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">CHT-1</Badge>
                    Balance Over Time
                  </CardTitle>
                  <CardDescription>
                    Line chart showing cumulative balance changes as UTXOs flow through the address.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[400px]">
                    {lineChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={lineChartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis 
                            dataKey="date" 
                            className="text-xs"
                            tick={{ fill: 'hsl(var(--muted-foreground))' }}
                          />
                          <YAxis 
                            className="text-xs"
                            tick={{ fill: 'hsl(var(--muted-foreground))' }}
                            tickFormatter={(v) => `${v.toFixed(4)} BTC`}
                          />
                          <RechartsTooltip 
                            contentStyle={{ 
                              background: 'hsl(var(--card))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: '8px'
                            }}
                            labelStyle={{ color: 'hsl(var(--foreground))' }}
                            formatter={(value: number, name: string) => [
                              `${value.toFixed(8)} BTC`,
                              name === "balance" ? "Balance" : "Amount"
                            ]}
                          />
                          <Legend />
                          <Line 
                            type="monotone" 
                            dataKey="balance" 
                            stroke="hsl(var(--primary))" 
                            strokeWidth={2}
                            dot={{ fill: 'hsl(var(--primary))', strokeWidth: 2 }}
                            activeDot={{ r: 6, fill: 'hsl(var(--primary))' }}
                            name="Cumulative Balance"
                          />
                          <Line 
                            type="monotone" 
                            dataKey="amount" 
                            stroke="hsl(var(--chart-2))" 
                            strokeWidth={1}
                            strokeDasharray="5 5"
                            dot={{ fill: 'hsl(var(--chart-2))', strokeWidth: 1, r: 3 }}
                            name="Transaction Amount"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        No time-series data available
                      </div>
                    )}
                  </div>

                  <div className="mt-4 grid grid-cols-4 gap-4 text-center">
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-2xl font-bold text-chart-1">{flowData?.stats.inputCount || 0}</div>
                      <div className="text-xs text-muted-foreground">Input Addresses</div>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold text-chart-1">{flowData?.stats.totalInputValue.toFixed(4) || 0} BTC</div>
                      <div className="text-xs text-muted-foreground">Total Received</div>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold text-chart-2">{flowData?.stats.totalOutputValue.toFixed(4) || 0} BTC</div>
                      <div className="text-xs text-muted-foreground">Total Sent</div>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/30">
                      <div className="text-2xl font-bold text-chart-2">{flowData?.stats.outputCount || 0}</div>
                      <div className="text-xs text-muted-foreground">Output Addresses</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}

        {!flowData && !isLoading && !error && (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center">
              <SiBitcoin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">Enter an Address to Begin</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Enter a Bitcoin address above and click "Trace" to visualize its UTXO flow. 
                Data will be fetched from local records first, or from the blockchain API if not synced.
              </p>
            </CardContent>
          </Card>
        )}

        {isLoading && (
          <Card>
            <CardContent className="py-12 text-center">
              <Loader2 className="h-12 w-12 mx-auto text-primary animate-spin mb-4" />
              <h3 className="text-lg font-medium mb-2">Tracing Transaction Flow...</h3>
              <p className="text-sm text-muted-foreground">
                Fetching transaction history and building flow visualization
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  );
}
