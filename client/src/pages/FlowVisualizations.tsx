import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  Sankey, Layer, Rectangle, 
  ResponsiveContainer, Treemap
} from "recharts";
import { 
  GitBranch, Circle, ArrowRight, ArrowDown, ChevronRight, 
  Maximize2, ZoomIn, Move, Info
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";

const sampleAddress = "bc1q...x7k3";

const sankeyData = {
  nodes: [
    { name: "Input A\n0.5 BTC" },
    { name: "Input B\n0.3 BTC" },
    { name: "Selected\n0.8 BTC" },
    { name: "Output A\n0.4 BTC" },
    { name: "Output B\n0.35 BTC" },
    { name: "Fee\n0.05 BTC" },
  ],
  links: [
    { source: 0, target: 2, value: 0.5 },
    { source: 1, target: 2, value: 0.3 },
    { source: 2, target: 3, value: 0.4 },
    { source: 2, target: 4, value: 0.35 },
    { source: 2, target: 5, value: 0.05 },
  ],
};

const timelineData = [
  { hop: 0, address: "bc1q...a1b2", type: "input", amount: 0.5, time: "2024-01-15", owner: "Coinbase" },
  { hop: 0, address: "bc1q...c3d4", type: "input", amount: 0.3, time: "2024-01-14", owner: "Unknown" },
  { hop: 1, address: sampleAddress, type: "selected", amount: 0.8, time: "2024-01-16", owner: "My Wallet" },
  { hop: 2, address: "bc1q...e5f6", type: "output", amount: 0.4, time: "2024-01-16", owner: "Exchange" },
  { hop: 2, address: "bc1q...g7h8", type: "output", amount: 0.35, time: "2024-01-16", owner: "My Wallet" },
];

const forceNodes = [
  { id: "a1", label: "Input A", x: 50, y: 100, type: "input" },
  { id: "a2", label: "Input B", x: 50, y: 200, type: "input" },
  { id: "sel", label: "Selected", x: 200, y: 150, type: "selected" },
  { id: "o1", label: "Output A", x: 350, y: 80, type: "output" },
  { id: "o2", label: "Output B", x: 350, y: 150, type: "output" },
  { id: "o3", label: "Output C", x: 350, y: 220, type: "output" },
];

const forceLinks = [
  { source: "a1", target: "sel" },
  { source: "a2", target: "sel" },
  { source: "sel", target: "o1" },
  { source: "sel", target: "o2" },
  { source: "sel", target: "o3" },
];

const arcAddresses = [
  { id: "addr1", label: "bc1q...a1b2", x: 50 },
  { id: "addr2", label: "bc1q...c3d4", x: 150 },
  { id: "addr3", label: sampleAddress, x: 250 },
  { id: "addr4", label: "bc1q...e5f6", x: 350 },
  { id: "addr5", label: "bc1q...g7h8", x: 450 },
];

const matrixData = [
  ["", "A", "B", "C", "D", "E"],
  ["A", "-", "0.5", "", "", ""],
  ["B", "", "-", "0.3", "", ""],
  ["C", "", "", "-", "0.4", "0.35"],
  ["D", "", "", "", "-", ""],
  ["E", "", "", "", "", "-"],
];

export default function FlowVisualizations() {
  const [selectedViz, setSelectedViz] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-8 max-w-6xl mx-auto">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold" data-testid="text-page-title">UTXO Flow Visualizations</h1>
          <p className="text-muted-foreground">
            Six visualization concepts for transaction flows. Select one to explore.
          </p>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="h-4 w-4" />
            <span>Each shows the same data: inputs feeding into a selected UTXO, which then fans out to outputs.</span>
          </div>
        </div>

        <Separator />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          <Card className={selectedViz === "sankey" ? "ring-2 ring-primary" : ""} data-testid="viz-sankey">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-1</Badge>
                    Sankey Diagram
                  </CardTitle>
                  <CardDescription>Flow bands where width represents BTC value</CardDescription>
                </div>
                <Button 
                  size="sm" 
                  variant={selectedViz === "sankey" ? "default" : "outline"}
                  onClick={() => setSelectedViz(selectedViz === "sankey" ? null : "sankey")}
                  data-testid="btn-select-sankey"
                >
                  {selectedViz === "sankey" ? "Selected" : "Select"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64 bg-muted/30 rounded-lg p-4 relative">
                <svg viewBox="0 0 400 200" className="w-full h-full">
                  <defs>
                    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" style={{ stopColor: "hsl(var(--muted-foreground))", stopOpacity: 0.5 }} />
                      <stop offset="100%" style={{ stopColor: "hsl(var(--primary))", stopOpacity: 0.7 }} />
                    </linearGradient>
                    <linearGradient id="grad2" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" style={{ stopColor: "hsl(var(--primary))", stopOpacity: 0.7 }} />
                      <stop offset="100%" style={{ stopColor: "hsl(var(--muted-foreground))", stopOpacity: 0.5 }} />
                    </linearGradient>
                  </defs>
                  
                  <path d="M 30 40 C 100 40, 100 70, 170 70 L 170 110 C 100 110, 100 80, 30 80 Z" fill="url(#grad1)" />
                  <path d="M 30 120 C 100 120, 100 100, 170 100 L 170 130 C 100 130, 100 150, 30 150 Z" fill="url(#grad1)" />
                  
                  <path d="M 230 70 C 300 70, 300 30, 370 30 L 370 70 C 300 70, 300 90, 230 90 Z" fill="url(#grad2)" />
                  <path d="M 230 90 C 300 90, 300 110, 370 110 L 370 140 C 300 140, 300 110, 230 110 Z" fill="url(#grad2)" />
                  <path d="M 230 115 C 280 115, 280 160, 370 160 L 370 180 C 280 180, 280 125, 230 125 Z" fill="url(#grad2)" opacity="0.4" />
                  
                  <rect x="170" y="60" width="60" height="70" rx="4" fill="hsl(var(--primary))" />
                  <text x="200" y="95" textAnchor="middle" className="fill-primary-foreground text-xs font-medium">0.8 BTC</text>
                  <text x="200" y="110" textAnchor="middle" className="fill-primary-foreground text-[10px] opacity-80">Selected</text>
                  
                  <text x="30" y="55" className="fill-muted-foreground text-[10px]">0.5 BTC</text>
                  <text x="30" y="135" className="fill-muted-foreground text-[10px]">0.3 BTC</text>
                  <text x="360" y="50" textAnchor="end" className="fill-muted-foreground text-[10px]">0.4 BTC</text>
                  <text x="360" y="125" textAnchor="end" className="fill-muted-foreground text-[10px]">0.35 BTC</text>
                  <text x="360" y="170" textAnchor="end" className="fill-muted-foreground text-[10px] opacity-60">Fee</text>
                </svg>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                <strong>Best for:</strong> Showing value proportions, easy to trace money flow
              </div>
            </CardContent>
          </Card>

          <Card className={selectedViz === "tree" ? "ring-2 ring-primary" : ""} data-testid="viz-tree">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-2</Badge>
                    Tree / Dendrogram
                  </CardTitle>
                  <CardDescription>Trunk (selected), roots (inputs), branches (outputs)</CardDescription>
                </div>
                <Button 
                  size="sm" 
                  variant={selectedViz === "tree" ? "default" : "outline"}
                  onClick={() => setSelectedViz(selectedViz === "tree" ? null : "tree")}
                  data-testid="btn-select-tree"
                >
                  {selectedViz === "tree" ? "Selected" : "Select"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64 bg-muted/30 rounded-lg p-4 relative">
                <svg viewBox="0 0 400 200" className="w-full h-full">
                  <line x1="120" y1="170" x2="200" y2="100" stroke="hsl(var(--muted-foreground))" strokeWidth="2" opacity="0.5" />
                  <line x1="280" y1="170" x2="200" y2="100" stroke="hsl(var(--muted-foreground))" strokeWidth="2" opacity="0.5" />
                  
                  <line x1="200" y1="100" x2="100" y2="30" stroke="hsl(var(--primary))" strokeWidth="2" />
                  <line x1="200" y1="100" x2="200" y2="30" stroke="hsl(var(--primary))" strokeWidth="2" />
                  <line x1="200" y1="100" x2="300" y2="30" stroke="hsl(var(--primary))" strokeWidth="2" />
                  
                  <circle cx="200" cy="100" r="24" fill="hsl(var(--primary))" />
                  <SiBitcoin className="h-4 w-4" style={{ transform: "translate(192px, 92px)" }} />
                  <text x="200" y="105" textAnchor="middle" className="fill-primary-foreground text-xs font-bold">0.8</text>
                  
                  <circle cx="120" cy="170" r="16" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1" />
                  <text x="120" y="174" textAnchor="middle" className="fill-foreground text-[10px]">0.5</text>
                  
                  <circle cx="280" cy="170" r="16" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1" />
                  <text x="280" y="174" textAnchor="middle" className="fill-foreground text-[10px]">0.3</text>
                  
                  <circle cx="100" cy="30" r="14" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1" />
                  <text x="100" y="34" textAnchor="middle" className="fill-foreground text-[10px]">0.4</text>
                  
                  <circle cx="200" cy="30" r="14" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1" />
                  <text x="200" y="34" textAnchor="middle" className="fill-foreground text-[10px]">0.35</text>
                  
                  <circle cx="300" cy="30" r="12" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1" opacity="0.5" />
                  <text x="300" y="34" textAnchor="middle" className="fill-muted-foreground text-[9px]">fee</text>
                  
                  <text x="80" y="185" className="fill-muted-foreground text-[9px]">Inputs (roots)</text>
                  <text x="85" y="15" className="fill-muted-foreground text-[9px]">Outputs (branches)</text>
                </svg>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                <strong>Best for:</strong> Hierarchical view, natural metaphor for sources/destinations
              </div>
            </CardContent>
          </Card>

          <Card className={selectedViz === "timeline" ? "ring-2 ring-primary" : ""} data-testid="viz-timeline">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-3</Badge>
                    Timeline Swimlanes
                  </CardTitle>
                  <CardDescription>Horizontal time axis with address lanes</CardDescription>
                </div>
                <Button 
                  size="sm" 
                  variant={selectedViz === "timeline" ? "default" : "outline"}
                  onClick={() => setSelectedViz(selectedViz === "timeline" ? null : "timeline")}
                  data-testid="btn-select-timeline"
                >
                  {selectedViz === "timeline" ? "Selected" : "Select"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64 bg-muted/30 rounded-lg p-4 overflow-hidden">
                <div className="flex flex-col h-full">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2 border-b pb-2">
                    <span className="w-20">Address</span>
                    <div className="flex-1 flex justify-between px-2">
                      <span>Hop -1</span>
                      <span>Hop 0</span>
                      <span>Hop +1</span>
                    </div>
                  </div>
                  
                  {timelineData.map((item, idx) => (
                    <div 
                      key={idx}
                      className={`flex items-center gap-2 py-1 ${item.type === "selected" ? "bg-primary/10 rounded" : ""}`}
                    >
                      <span className="w-20 text-xs font-mono truncate">{item.address}</span>
                      <div className="flex-1 relative h-6">
                        <div 
                          className={`absolute h-5 rounded-full px-2 flex items-center gap-1 text-[10px] ${
                            item.type === "selected" 
                              ? "bg-primary text-primary-foreground" 
                              : item.type === "input" 
                                ? "bg-muted border" 
                                : "bg-secondary"
                          }`}
                          style={{ left: `${item.hop === 0 ? 10 : item.hop === 1 ? 40 : 70}%` }}
                        >
                          <SiBitcoin className="h-3 w-3" />
                          {item.amount}
                        </div>
                      </div>
                    </div>
                  ))}
                  
                  <div className="flex-1" />
                  <div className="flex items-center gap-4 text-xs mt-2 pt-2 border-t">
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-muted border rounded-full" />
                      <span className="text-muted-foreground">Input</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-primary rounded-full" />
                      <span className="text-muted-foreground">Selected</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-secondary rounded-full" />
                      <span className="text-muted-foreground">Output</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                <strong>Best for:</strong> Temporal ordering, seeing the chain of hops over time
              </div>
            </CardContent>
          </Card>

          <Card className={selectedViz === "force" ? "ring-2 ring-primary" : ""} data-testid="viz-force">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-4</Badge>
                    Force-Directed Graph
                  </CardTitle>
                  <CardDescription>Interactive nodes with physics - drag, zoom, cluster</CardDescription>
                </div>
                <Button 
                  size="sm" 
                  variant={selectedViz === "force" ? "default" : "outline"}
                  onClick={() => setSelectedViz(selectedViz === "force" ? null : "force")}
                  data-testid="btn-select-force"
                >
                  {selectedViz === "force" ? "Selected" : "Select"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64 bg-muted/30 rounded-lg p-4 relative">
                <div className="absolute top-2 right-2 flex gap-1">
                  <Button size="icon" variant="ghost" className="h-6 w-6">
                    <ZoomIn className="h-3 w-3" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6">
                    <Move className="h-3 w-3" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6">
                    <Maximize2 className="h-3 w-3" />
                  </Button>
                </div>
                
                <svg viewBox="0 0 400 200" className="w-full h-full">
                  {forceLinks.map((link, idx) => {
                    const source = forceNodes.find(n => n.id === link.source)!;
                    const target = forceNodes.find(n => n.id === link.target)!;
                    return (
                      <line 
                        key={idx}
                        x1={source.x} y1={source.y}
                        x2={target.x} y2={target.y}
                        stroke="hsl(var(--muted-foreground))"
                        strokeWidth="2"
                        opacity="0.4"
                        markerEnd="url(#arrowhead)"
                      />
                    );
                  })}
                  
                  <defs>
                    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                      <polygon points="0 0, 10 3.5, 0 7" fill="hsl(var(--muted-foreground))" opacity="0.4" />
                    </marker>
                  </defs>
                  
                  {forceNodes.map((node) => (
                    <g 
                      key={node.id} 
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredNode(node.id)}
                      onMouseLeave={() => setHoveredNode(null)}
                    >
                      <circle 
                        cx={node.x} cy={node.y} 
                        r={node.type === "selected" ? 24 : 18}
                        fill={node.type === "selected" ? "hsl(var(--primary))" : 
                              node.type === "input" ? "hsl(var(--muted))" : "hsl(var(--secondary))"}
                        stroke={hoveredNode === node.id ? "hsl(var(--ring))" : "transparent"}
                        strokeWidth="3"
                      />
                      <text 
                        x={node.x} y={node.y + 4} 
                        textAnchor="middle" 
                        className={`text-[10px] ${node.type === "selected" ? "fill-primary-foreground font-bold" : "fill-foreground"}`}
                      >
                        {node.label}
                      </text>
                    </g>
                  ))}
                </svg>
                
                {hoveredNode && (
                  <div className="absolute bottom-2 left-2 bg-background/90 border rounded px-2 py-1 text-xs">
                    <strong>{hoveredNode}</strong>: Click to expand, drag to reposition
                  </div>
                )}
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                <strong>Best for:</strong> Exploring complex relationships, interactive discovery
              </div>
            </CardContent>
          </Card>

          <Card className={selectedViz === "arc" ? "ring-2 ring-primary" : ""} data-testid="viz-arc">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-5</Badge>
                    Arc Diagram
                  </CardTitle>
                  <CardDescription>Linear address list with curved arcs connecting transactions</CardDescription>
                </div>
                <Button 
                  size="sm" 
                  variant={selectedViz === "arc" ? "default" : "outline"}
                  onClick={() => setSelectedViz(selectedViz === "arc" ? null : "arc")}
                  data-testid="btn-select-arc"
                >
                  {selectedViz === "arc" ? "Selected" : "Select"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64 bg-muted/30 rounded-lg p-4 relative">
                <svg viewBox="0 0 500 200" className="w-full h-full">
                  <line x1="30" y1="120" x2="470" y2="120" stroke="hsl(var(--border))" strokeWidth="1" />
                  
                  <path 
                    d="M 60 120 Q 145 40, 230 120" 
                    fill="none" 
                    stroke="hsl(var(--muted-foreground))" 
                    strokeWidth="2"
                    opacity="0.5"
                  />
                  <path 
                    d="M 145 120 Q 187.5 70, 230 120" 
                    fill="none" 
                    stroke="hsl(var(--muted-foreground))" 
                    strokeWidth="2"
                    opacity="0.5"
                  />
                  
                  <path 
                    d="M 230 120 Q 295 50, 360 120" 
                    fill="none" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth="2"
                  />
                  <path 
                    d="M 230 120 Q 330 30, 440 120" 
                    fill="none" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth="2"
                  />
                  
                  {[
                    { x: 60, label: "...a1b2", type: "input" },
                    { x: 145, label: "...c3d4", type: "input" },
                    { x: 230, label: sampleAddress.slice(-8), type: "selected" },
                    { x: 360, label: "...e5f6", type: "output" },
                    { x: 440, label: "...g7h8", type: "output" },
                  ].map((addr, idx) => (
                    <g key={idx}>
                      <circle 
                        cx={addr.x} cy={120} 
                        r={addr.type === "selected" ? 12 : 8}
                        fill={addr.type === "selected" ? "hsl(var(--primary))" : 
                              addr.type === "input" ? "hsl(var(--muted))" : "hsl(var(--secondary))"}
                        stroke="hsl(var(--border))"
                        strokeWidth="1"
                      />
                      <text 
                        x={addr.x} y={145} 
                        textAnchor="middle" 
                        className="fill-muted-foreground text-[9px] font-mono"
                      >
                        {addr.label}
                      </text>
                    </g>
                  ))}
                  
                  <text x="60" y="165" textAnchor="middle" className="fill-muted-foreground text-[8px]">Input</text>
                  <text x="230" y="165" textAnchor="middle" className="fill-muted-foreground text-[8px]">Selected</text>
                  <text x="400" y="165" textAnchor="middle" className="fill-muted-foreground text-[8px]">Output</text>
                </svg>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                <strong>Best for:</strong> Compact linear view, good for address lists with relationships
              </div>
            </CardContent>
          </Card>

          <Card className={selectedViz === "matrix" ? "ring-2 ring-primary" : ""} data-testid="viz-matrix">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="outline">VIZ-6</Badge>
                    Matrix Heatmap
                  </CardTitle>
                  <CardDescription>Grid showing address-to-address flow intensity</CardDescription>
                </div>
                <Button 
                  size="sm" 
                  variant={selectedViz === "matrix" ? "default" : "outline"}
                  onClick={() => setSelectedViz(selectedViz === "matrix" ? null : "matrix")}
                  data-testid="btn-select-matrix"
                >
                  {selectedViz === "matrix" ? "Selected" : "Select"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64 bg-muted/30 rounded-lg p-4 overflow-auto">
                <div className="min-w-fit">
                  <table className="border-collapse text-xs">
                    <thead>
                      <tr>
                        <th className="p-2 text-left font-normal text-muted-foreground">From \ To</th>
                        <th className="p-2 font-mono text-center">A</th>
                        <th className="p-2 font-mono text-center">B</th>
                        <th className="p-2 font-mono text-center bg-primary/20">C*</th>
                        <th className="p-2 font-mono text-center">D</th>
                        <th className="p-2 font-mono text-center">E</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="p-2 font-mono">A (input)</td>
                        <td className="p-2 text-center bg-muted/50">-</td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center bg-primary/30 font-bold">0.5</td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                      </tr>
                      <tr>
                        <td className="p-2 font-mono">B (input)</td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center bg-muted/50">-</td>
                        <td className="p-2 text-center bg-primary/20">0.3</td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                      </tr>
                      <tr className="bg-primary/10">
                        <td className="p-2 font-mono font-bold">C* (sel)</td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center bg-primary/50">-</td>
                        <td className="p-2 text-center bg-secondary/50">0.4</td>
                        <td className="p-2 text-center bg-secondary/30">0.35</td>
                      </tr>
                      <tr>
                        <td className="p-2 font-mono">D (output)</td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center bg-muted/50">-</td>
                        <td className="p-2 text-center"></td>
                      </tr>
                      <tr>
                        <td className="p-2 font-mono">E (output)</td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center"></td>
                        <td className="p-2 text-center bg-muted/50">-</td>
                      </tr>
                    </tbody>
                  </table>
                  
                  <div className="mt-3 flex items-center gap-4 text-[10px]">
                    <span className="text-muted-foreground">Intensity:</span>
                    <div className="flex items-center gap-1">
                      <div className="w-4 h-3 bg-primary/20" />
                      <span>Low</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-4 h-3 bg-primary/50" />
                      <span>High</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                <strong>Best for:</strong> Seeing all relationships at once, finding patterns in many addresses
              </div>
            </CardContent>
          </Card>
        </div>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle>Comparison Summary</CardTitle>
            <CardDescription>Quick reference for choosing a visualization</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">ID</th>
                    <th className="text-left p-2">Style</th>
                    <th className="text-left p-2">Strengths</th>
                    <th className="text-left p-2">Best Use Case</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="p-2"><Badge variant="outline">VIZ-1</Badge></td>
                    <td className="p-2">Sankey</td>
                    <td className="p-2 text-muted-foreground">Value proportions visible, intuitive flow</td>
                    <td className="p-2">Tracing money movement</td>
                  </tr>
                  <tr className="border-b">
                    <td className="p-2"><Badge variant="outline">VIZ-2</Badge></td>
                    <td className="p-2">Tree</td>
                    <td className="p-2 text-muted-foreground">Clear hierarchy, natural metaphor</td>
                    <td className="p-2">Source/destination analysis</td>
                  </tr>
                  <tr className="border-b">
                    <td className="p-2"><Badge variant="outline">VIZ-3</Badge></td>
                    <td className="p-2">Timeline</td>
                    <td className="p-2 text-muted-foreground">Temporal ordering, hop visibility</td>
                    <td className="p-2">Time-based analysis</td>
                  </tr>
                  <tr className="border-b">
                    <td className="p-2"><Badge variant="outline">VIZ-4</Badge></td>
                    <td className="p-2">Force Graph</td>
                    <td className="p-2 text-muted-foreground">Interactive exploration, clustering</td>
                    <td className="p-2">Complex relationship discovery</td>
                  </tr>
                  <tr className="border-b">
                    <td className="p-2"><Badge variant="outline">VIZ-5</Badge></td>
                    <td className="p-2">Arc Diagram</td>
                    <td className="p-2 text-muted-foreground">Compact, works with lists</td>
                    <td className="p-2">Address list relationships</td>
                  </tr>
                  <tr>
                    <td className="p-2"><Badge variant="outline">VIZ-6</Badge></td>
                    <td className="p-2">Matrix</td>
                    <td className="p-2 text-muted-foreground">All relationships visible, patterns</td>
                    <td className="p-2">Multi-address analysis</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <div className="h-8" />
      </div>
    </ScrollArea>
  );
}
