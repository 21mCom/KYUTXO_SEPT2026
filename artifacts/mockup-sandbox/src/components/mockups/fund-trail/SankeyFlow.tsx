import React, { useMemo } from "react";
import {
  CENTER,
  SOURCES,
  DESTINATIONS,
  TIME_RANGE,
  DIMENSION_LABEL,
  formatBtc,
  shortAddr,
  shortTxid,
  formatDate,
  formatDateShort,
  timePosition,
  nodeDate,
  sourcesAtHop,
  destinationsAtHop,
} from "./_data";
import "./_group.css";
import { AlertTriangle, HelpCircle, Wallet, User, KeyRound, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function SankeyFlow() {
  const WIDTH = 1300;
  const HEIGHT = 600;
  const PAD_X = 100;
  const PAD_Y = 100;
  const INNER_WIDTH = WIDTH - PAD_X * 2;
  const INNER_HEIGHT = HEIGHT - PAD_Y * 2;

  const maxBtc = Math.max(CENTER.totalInSats, CENTER.totalOutSats);
  const scale = INNER_HEIGHT / maxBtc;

  const DimIcon = ({ dim, className }: { dim: string; className?: string }) => {
    if (dim === "walletName") return <Wallet className={className} />;
    if (dim === "owner") return <User className={className} />;
    if (dim === "seedName") return <KeyRound className={className} />;
    return null;
  };

  // Pre-calculate node positions
  const nodes = useMemo(() => {
    const list: any[] = [];
    
    // Y-offsets for stacking nodes at similar X (or just centering them)
    // To make it simple, we center each node vertically based on its height,
    // except if they overlap in time. But wait, we want a classic Sankey.
    // Let's just group them by column/depth and stack them vertically.
    
    // Instead of true time-based X for nodes (which might overlap), 
    // let's use fixed columns but plot a timeline below them.
    // Actually, the prompt said: "tying the columns to dates (Sep->Oct) — the shared time reference (use timePosition for tick placement)".
    // So X is timePosition! Let's see if they overlap.
    const getX = (date: number) => PAD_X + timePosition(date) * INNER_WIDTH;

    // Center
    const centerDate = (nodeDate(sourcesAtHop(1)[0]) + nodeDate(destinationsAtHop(1)[0])) / 2;
    const centerX = getX(centerDate);
    const centerH = CENTER.totalInSats * scale; // or maxBtc
    const centerY = PAD_Y + (INNER_HEIGHT - centerH) / 2;
    
    list.push({
      id: "center",
      label: CENTER.groupLabel,
      dim: CENTER.dimension,
      x: centerX,
      y: centerY,
      h: centerH,
      w: 24,
      sats: CENTER.totalInSats,
      color: "var(--ft-accent)",
      isUnknown: false,
    });

    // We need to route ribbons. Ribbons need start/end Y.
    // For a real Sankey, we maintain a `currentY` for each node's inputs and outputs.
    // Let's build a simple layout.
    
    const placeNodes = (nodesToPlace: any[], isSource: boolean) => {
      // Group by hop depth
      const depths = [1, 2];
      const result: any[] = [];
      depths.forEach(depth => {
        const depthNodes = nodesToPlace.filter(n => n.hopDepth === depth);
        // Sort by totalSats desc
        depthNodes.sort((a, b) => b.totalSats - a.totalSats);
        
        let totalH = depthNodes.reduce((sum, n) => sum + n.totalSats * scale, 0);
        let startY = PAD_Y + (INNER_HEIGHT - totalH) / 2 - (depthNodes.length - 1) * 10; // 20px gap
        if (startY < PAD_Y) startY = PAD_Y;

        depthNodes.forEach(n => {
          const h = n.totalSats * scale;
          const x = getX(nodeDate(n));
          result.push({
            ...n,
            x: x,
            y: startY,
            h: h,
            w: 24,
            color: n.isUnknown ? "var(--ft-unknown)" : (isSource ? "var(--ft-source)" : "var(--ft-dest)"),
            inY: startY,
            outY: startY
          });
          startY += h + 20;
        });
      });
      return result;
    };

    const placedSrc = placeNodes(SOURCES, true);
    const placedDst = placeNodes(DESTINATIONS, false);
    
    return [list[0], ...placedSrc, ...placedDst];
  }, []);

  const getNode = (id: string) => nodes.find(n => n.id === id) || nodes[0];

  // Build ribbons
  const ribbons = useMemo(() => {
    const list: any[] = [];
    
    const centerNode = getNode("center");
    
    // Sources to Center
    let centerInY = centerNode.y;
    SOURCES.filter(n => n.hopDepth === 1).forEach(src => {
      const sn = getNode(src.id);
      const h = src.totalSats * scale;
      list.push({
        id: `ribbon-${src.id}-center`,
        x1: sn.x + sn.w,
        y1: sn.y + sn.h / 2, // center of source
        x2: centerNode.x,
        y2: centerInY + h / 2,
        thickness: h,
        color: "var(--ft-source)",
        opacity: 0.3
      });
      centerInY += h;
    });

    // Hop 2 Sources to Hop 1
    SOURCES.filter(n => n.hopDepth === 2).forEach(src => {
      const sn = getNode(src.id);
      const target = SOURCES.find(n => n.groupLabel === src.behind);
      if (target) {
        const tn = getNode(target.id);
        const h = src.totalSats * scale;
        list.push({
          id: `ribbon-${src.id}-${target.id}`,
          x1: sn.x + sn.w,
          y1: sn.y + sn.h / 2,
          x2: tn.x,
          y2: tn.y + h / 2, // top aligned for simplicity
          thickness: h,
          color: "var(--ft-source)",
          opacity: 0.3
        });
      }
    });

    // Center to Dest Hop 1
    let centerOutY = centerNode.y;
    DESTINATIONS.filter(n => n.hopDepth === 1).forEach(dst => {
      const dn = getNode(dst.id);
      const h = dst.totalSats * scale;
      list.push({
        id: `ribbon-center-${dst.id}`,
        x1: centerNode.x + centerNode.w,
        y1: centerOutY + h / 2,
        x2: dn.x,
        y2: dn.y + dn.h / 2,
        thickness: h,
        color: "var(--ft-dest)",
        opacity: 0.3
      });
      centerOutY += h;
    });

    // Hop 1 Dest to Hop 2
    DESTINATIONS.filter(n => n.hopDepth === 2).forEach(dst => {
      const dn = getNode(dst.id);
      const source = DESTINATIONS.find(n => n.groupLabel === dst.behind);
      if (source) {
        const sn = getNode(source.id);
        const h = dst.totalSats * scale;
        list.push({
          id: `ribbon-${source.id}-${dst.id}`,
          x1: sn.x + sn.w,
          y1: sn.y + sn.h / 2, // center
          x2: dn.x,
          y2: dn.y + dn.h / 2,
          thickness: h,
          color: "var(--ft-dest)",
          opacity: 0.3
        });
      }
    });

    return list;
  }, [nodes]);

  const drawCurve = (x1: number, y1: number, x2: number, y2: number) => {
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
  };

  const ticks = [
    TIME_RANGE.startSec,
    nodeDate(SOURCES.find(n => n.id === "src-coinbase")!),
    nodeDate(DESTINATIONS.find(n => n.id === "dst-hardware")!),
    TIME_RANGE.endSec
  ];

  const coinbaseRibbon = ribbons.find(r => r.id === "ribbon-src-coinbase-center");

  return (
    <div className="ft-root w-full min-h-screen relative overflow-hidden flex flex-col pt-8">
      <div className="px-12 mb-4">
        <h1 className="text-2xl font-semibold mb-2">Fund Trail: Sankey Flow</h1>
        <p className="text-[var(--ft-text-2)] text-sm">Best for: where the bulk of funds came from / went, at a glance.</p>
      </div>

      <div className="flex-1 relative">
        <svg width="100%" height="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet">
          {/* Timeline Axis */}
          <line x1={PAD_X} y1={HEIGHT - 40} x2={WIDTH - PAD_X} y2={HEIGHT - 40} stroke="var(--ft-border-strong)" strokeWidth={2} />
          {ticks.map((t, i) => {
            const tx = PAD_X + timePosition(t) * INNER_WIDTH;
            return (
              <g key={i} transform={`translate(${tx}, ${HEIGHT - 40})`}>
                <line y1={-5} y2={5} stroke="var(--ft-border-strong)" strokeWidth={2} />
                <text y={20} fill="var(--ft-text-2)" fontSize={12} textAnchor="middle" className="ft-mono">
                  {formatDateShort(t)}
                </text>
              </g>
            );
          })}

          {/* Ribbons */}
          {ribbons.map(r => (
            <path
              key={r.id}
              d={drawCurve(r.x1, r.y1, r.x2, r.y2)}
              fill="none"
              stroke={r.color}
              strokeWidth={Math.max(2, r.thickness)}
              strokeOpacity={r.opacity}
              className="transition-opacity hover:stroke-opacity-60 cursor-pointer"
            />
          ))}

          {/* Nodes */}
          {nodes.map(n => (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
              <rect
                width={n.w}
                height={Math.max(4, n.h)}
                fill={n.color}
                rx={4}
                className="transition-all hover:brightness-125"
              />
              {/* Labels */}
              <text
                x={n.id.startsWith('src') ? -10 : n.w + 10}
                y={n.h / 2}
                fill="var(--ft-text)"
                fontSize={13}
                fontWeight={500}
                textAnchor={n.id.startsWith('src') ? "end" : "start"}
                alignmentBaseline="middle"
                className="drop-shadow-md"
              >
                {n.groupLabel}
              </text>
              <text
                x={n.id.startsWith('src') ? -10 : n.w + 10}
                y={n.h / 2 + 16}
                fill={n.color}
                fontSize={11}
                textAnchor={n.id.startsWith('src') ? "end" : "start"}
                className="ft-mono drop-shadow-md"
              >
                {formatBtc(n.sats || n.totalSats, true)} BTC
              </text>

              {/* Cap Notice Warning */}
              {n.cap && (
                <g transform={`translate(${n.id.startsWith('src') ? -24 : n.w + 10}, ${n.h / 2 - 24})`}>
                  <circle cx={0} cy={0} r={10} fill="var(--ft-bg)" />
                  <AlertTriangle size={14} color="var(--ft-warn)" x={-7} y={-7} />
                </g>
              )}
            </g>
          ))}

          {/* Tooltip anchor for Coinbase ribbon */}
          {coinbaseRibbon && (
            <circle 
              cx={(coinbaseRibbon.x1 + coinbaseRibbon.x2) / 2} 
              cy={(coinbaseRibbon.y1 + coinbaseRibbon.y2) / 2} 
              r={4} 
              fill="var(--ft-source)" 
            />
          )}
        </svg>

        {/* Detail Popover (Absolute Positioned over Coinbase ribbon) */}
        {coinbaseRibbon && (
          <Card 
            className="absolute z-10 bg-[var(--ft-panel)] border-[var(--ft-border-strong)] p-4 shadow-xl w-80 ft-fade-in"
            style={{
              left: `calc(50% - 100px)`,
              top: `calc(50% - 150px)`,
              // Using relative percentage based on the SVG viewBox is tricky, 
              // but we can just hardcode the approx center since it's a fixed viewport static mockup.
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Badge variant="outline" className="bg-[var(--ft-source-soft)] text-[var(--ft-source)] border-transparent flex items-center gap-1 px-1.5 py-0.5 rounded-sm">
                <Wallet size={12} />
                <span className="text-[10px] uppercase tracking-wider">{DIMENSION_LABEL["walletName"]}</span>
              </Badge>
              <h3 className="font-medium text-sm">Coinbase Withdrawal</h3>
            </div>
            
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-[var(--ft-text-2)]">Total Flow</span>
                <span className="ft-mono text-sm text-[var(--ft-source)] font-medium">1.5 BTC</span>
              </div>
              <div className="h-px w-full bg-[var(--ft-border-strong)]" />
              
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="ft-mono text-[var(--ft-text-2)]">{shortAddr("bc1qcb9w0zr4k8xv2m7n3p5t6q8s9d0f1g2h3j4x7")}</span>
                  <span className="ft-mono text-[var(--ft-text)]">1.2 BTC</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--ft-text-3)]">{formatDateShort(1695859200)}</span>
                  <span className="ft-mono text-[var(--ft-text-3)]">{shortTxid("a91f7c2e8b4d6a0f3e5c9b1d7a8f2c4e6b0d9a1f3c5e7b2d4a6f8c0e2b4d63d2")}</span>
                </div>
              </div>
              
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="ft-mono text-[var(--ft-text-2)]">{shortAddr("bc1qcb9w0zr4k8xv2m7n3p5t6q8s9d0f1g2h3j4x7")}</span>
                  <span className="ft-mono text-[var(--ft-text)]">0.3 BTC</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--ft-text-3)]">{formatDateShort(1695859200)}</span>
                  <span className="ft-mono text-[var(--ft-text-3)]">{shortTxid("a91f55a1c3e7b9d2f4068a1c3e5079b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a23d2")}</span>
                </div>
              </div>
            </div>
            
            <div className="mt-4 flex items-center justify-between text-xs text-[var(--ft-text-3)]">
              <span>View full node</span>
              <ChevronRight size={14} />
            </div>
          </Card>
        )}

        {/* Cap notice tooltip absolute positioned near Unknown Source */}
        <div className="absolute left-[38%] top-[70%] bg-[var(--ft-panel-2)] border border-[var(--ft-warn)] text-[var(--ft-warn)] px-3 py-2 rounded-md shadow-lg text-xs max-w-[200px] flex gap-2 items-start ft-fade-in">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <p>Showing only the most recent 2,000 of 5,120 transactions.</p>
        </div>
      </div>
    </div>
  );
}
