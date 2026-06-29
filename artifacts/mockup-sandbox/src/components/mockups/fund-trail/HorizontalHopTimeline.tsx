import React, { useState } from "react";
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
  SampleNode,
  SampleDetail
} from "./_data";
import "./_group.css";
import {
  ArrowDownLeft,
  ArrowUpRight,
  HelpCircle,
  AlertTriangle,
  Wallet,
  User,
  KeyRound,
  ChevronDown,
  ChevronRight,
  MoreHorizontal
} from "lucide-react";

const getDimIcon = (dim: string) => {
  if (dim === "walletName") return <Wallet className="w-3 h-3" />;
  if (dim === "owner") return <User className="w-3 h-3" />;
  if (dim === "seedName") return <KeyRound className="w-3 h-3" />;
  return <HelpCircle className="w-3 h-3" />;
};

const NodeCard = ({ node, isExpanded, onToggle }: { node: SampleNode, isExpanded: boolean, onToggle: () => void }) => {
  const isSource = node.direction === "source";
  const colorRole = node.isUnknown ? "var(--ft-unknown)" : (isSource ? "var(--ft-source)" : "var(--ft-dest)");
  const softRole = node.isUnknown ? "var(--ft-unknown-soft)" : (isSource ? "var(--ft-source-soft)" : "var(--ft-dest-soft)");
  
  // Calculate relative weight
  const btcAmount = node.totalSats / 100_000_000;
  const isHeavy = btcAmount >= 1.0;
  const isLight = btcAmount < 0.1;

  return (
    <div className="flex flex-col mb-4 last:mb-0 relative ft-fade-in group">
      <div 
        className={`rounded-lg border bg-[var(--ft-panel)] hover:bg-[var(--ft-panel-2)] transition-colors cursor-pointer overflow-hidden
          ${isExpanded ? 'border-[var(--ft-border-strong)] shadow-md' : 'border-[var(--ft-border)]'}
        `}
        onClick={onToggle}
      >
        {node.cap && (
          <div className="bg-[var(--ft-warn-soft)] text-[var(--ft-warn)] text-[10px] px-3 py-1.5 flex items-center gap-1.5 border-b border-[var(--ft-warn)]/20">
            <AlertTriangle className="w-3 h-3" />
            <span>Showing {node.cap.shown.toLocaleString()} of {node.cap.total.toLocaleString()} txns</span>
          </div>
        )}
        
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--ft-text-3)] font-medium uppercase tracking-wider">
              {getDimIcon(node.dimension)}
              <span>{DIMENSION_LABEL[node.dimension as keyof typeof DIMENSION_LABEL]}</span>
            </div>
            <div className="text-[var(--ft-text-3)] text-xs flex items-center transition-colors group-hover:text-[var(--ft-text-2)]">
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </div>
          </div>
          
          <div className="flex items-center gap-2 mb-1">
            {node.isUnknown && <HelpCircle className="w-4 h-4 text-[var(--ft-unknown)] shrink-0" />}
            <div className={`font-medium truncate ${node.isUnknown ? 'text-[var(--ft-text-2)]' : 'text-[var(--ft-text)]'} ${isHeavy ? 'text-base' : 'text-sm'}`}>
              {node.groupLabel}
            </div>
          </div>

          <div className="flex items-center justify-between mt-3 gap-2">
            <div className="flex items-center gap-1.5 shrink-0">
              <div 
                className="flex items-center justify-center rounded-full w-5 h-5 shrink-0" 
                style={{ backgroundColor: softRole, color: colorRole }}
              >
                {isSource ? <ArrowDownLeft className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
              </div>
              <div className={`ft-mono font-medium truncate ${isHeavy ? 'text-base' : isLight ? 'text-xs text-[var(--ft-text-2)]' : 'text-sm'}`} style={{ color: colorRole }}>
                {formatBtc(node.totalSats)} <span className="text-[var(--ft-text-3)] text-[10px] ml-0.5">BTC</span>
              </div>
            </div>
            <div className="text-xs text-[var(--ft-text-3)] whitespace-nowrap ml-2">
              {formatDateShort(nodeDate(node))}
            </div>
          </div>

          {/* Shared timeline track — every card plots its date on the SAME Sep 18 → Oct 6 range
              (via timePosition), so a node's dot lines up logically with the top ruler. */}
          <div className="mt-3 relative h-2 flex items-center" title={formatDate(nodeDate(node))}>
            <div className="absolute left-0 right-0 h-px bg-[var(--ft-border)]"></div>
            <div
              className="absolute w-2 h-2 rounded-full -translate-x-1/2 ring-2 ring-[var(--ft-panel)]"
              style={{ left: `${timePosition(nodeDate(node)) * 100}%`, backgroundColor: colorRole }}
            ></div>
          </div>
        </div>

        {/* Details expansion */}
        {isExpanded && (
          <div className="border-t border-[var(--ft-border)] bg-[#0a0e14] p-3 text-xs flex flex-col gap-2">
            <div className="grid grid-cols-[3fr_3fr_3fr_2fr] gap-2 text-[var(--ft-text-3)] pb-2 border-b border-[var(--ft-border)]/50 text-[10px] uppercase tracking-wider">
              <div>Txid</div>
              <div>Address</div>
              <div className="text-right">Amount</div>
              <div className="text-right">Date</div>
            </div>
            {node.details.map((d, i) => (
              <div key={i} className="grid grid-cols-[3fr_3fr_3fr_2fr] gap-2 items-center ft-mono text-[var(--ft-text-2)] py-1">
                <div className="text-[var(--ft-text)] truncate" title={d.txid}>{shortTxid(d.txid)}</div>
                <div className="text-[var(--ft-text-3)] truncate" title={d.address}>{shortAddr(d.address)}</div>
                <div className="text-right truncate" style={{ color: colorRole }}>{formatBtc(d.amount, true)}</div>
                <div className="text-right text-[var(--ft-text-3)] font-sans truncate">{formatDateShort(d.blockTime)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export function HorizontalHopTimeline() {
  const [expandedId, setExpandedId] = useState<string>("src-coinbase");

  const hop2Src = sourcesAtHop(2);
  const hop1Src = sourcesAtHop(1);
  const hop1Dest = destinationsAtHop(1);
  const hop2Dest = destinationsAtHop(2);

  // Evenly-spaced ticks across the real range, each labelled with its actual date,
  // so the axis is linear and accurate (not hardcoded quarter positions).
  const rulerTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    f,
    sec: TIME_RANGE.startSec + f * (TIME_RANGE.endSec - TIME_RANGE.startSec),
  }));

  return (
    <div className="ft-root min-h-screen w-full flex flex-col overflow-hidden">
      {/* Time Ruler — accurate linear axis (Sep 18 → Oct 6); every node plots on this same range */}
      <div className="h-14 border-b border-[var(--ft-border-strong)] relative shrink-0">
        <div className="absolute left-8 right-8 top-0 bottom-2">
          <div className="absolute left-0 right-0 bottom-0 h-px bg-[var(--ft-border-strong)]"></div>
          {rulerTicks.map((t, i) => (
            <div
              key={i}
              className="absolute bottom-0 flex flex-col items-center text-[var(--ft-text-3)] text-xs font-medium"
              style={{
                left: `${t.f * 100}%`,
                transform:
                  i === 0
                    ? "translateX(0)"
                    : i === rulerTicks.length - 1
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
              }}
            >
              {formatDateShort(t.sec)}
              <div className="h-1.5 w-px bg-[var(--ft-border-strong)] mt-1"></div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden p-6 gap-6 min-h-0">
        
        {/* Hop 2 Sources */}
        <div className="flex-1 flex flex-col h-full min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-[var(--ft-text-3)] mb-4 font-semibold shrink-0">Hop 2 · Sources</div>
          <div className="flex-1 overflow-y-auto pr-2 pb-12">
            {hop2Src.map(n => (
              <NodeCard key={n.id} node={n} isExpanded={expandedId === n.id} onToggle={() => setExpandedId(expandedId === n.id ? "" : n.id)} />
            ))}
          </div>
        </div>

        {/* Hop 1 Sources */}
        <div className="flex-1 flex flex-col h-full min-w-0 relative">
          <div className="text-[10px] uppercase tracking-widest text-[var(--ft-text-3)] mb-4 font-semibold shrink-0">Hop 1 · Sources</div>
          <div className="flex-1 overflow-y-auto pr-2 pb-12">
            {hop1Src.map(n => (
              <NodeCard key={n.id} node={n} isExpanded={expandedId === n.id} onToggle={() => setExpandedId(expandedId === n.id ? "" : n.id)} />
            ))}
            
            {/* Scroll/overflow hint since it has 3 nodes */}
            <div className="flex items-center justify-center py-2 text-xs text-[var(--ft-text-3)] border border-dashed border-[var(--ft-border-strong)] rounded-lg hover:text-[var(--ft-text-2)] hover:border-[var(--ft-text-3)] cursor-pointer transition-colors mt-2">
              <MoreHorizontal className="w-4 h-4 mr-2" />
              12 more sources
            </div>
          </div>
        </div>

        {/* CENTER */}
        <div className="flex-[1.2] flex flex-col h-full min-w-0 relative z-10 px-2 shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-[var(--ft-accent)] mb-4 font-semibold text-center shrink-0">Traced Entity</div>
          
          <div className="mt-8 flex flex-col border border-[var(--ft-accent)]/30 rounded-xl bg-[var(--ft-panel)] shadow-xl overflow-hidden shrink-0">
            <div className="p-6 text-center flex flex-col items-center justify-center relative bg-[var(--ft-accent-soft)]">
              <div className="absolute inset-0 bg-gradient-to-b from-[var(--ft-accent)]/10 to-transparent"></div>
              
              <div className="flex items-center gap-2 text-[10px] text-[var(--ft-accent)]/80 font-medium uppercase tracking-wider mb-4 relative">
                {getDimIcon(CENTER.dimension)}
                <span>{DIMENSION_LABEL[CENTER.dimension as keyof typeof DIMENSION_LABEL]}</span>
              </div>
              
              <div className="text-2xl font-semibold text-[var(--ft-text)] relative mb-8">
                {CENTER.groupLabel}
              </div>

              <div className="w-full flex justify-between items-center relative text-sm">
                <div className="flex flex-col items-start">
                  <span className="text-[10px] text-[var(--ft-text-3)] uppercase tracking-wider mb-1.5">Total In</span>
                  <span className="ft-mono text-[var(--ft-source)] font-medium flex items-center gap-1.5 text-base">
                    <ArrowDownLeft className="w-4 h-4" />
                    {formatBtc(CENTER.totalInSats)}
                  </span>
                </div>
                
                <div className="w-px h-10 bg-[var(--ft-border-strong)]"></div>
                
                <div className="flex flex-col items-end">
                  <span className="text-[10px] text-[var(--ft-text-3)] uppercase tracking-wider mb-1.5">Total Out</span>
                  <span className="ft-mono text-[var(--ft-dest)] font-medium flex items-center gap-1.5 text-base">
                    {formatBtc(CENTER.totalOutSats)}
                    <ArrowUpRight className="w-4 h-4" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Hop 1 Destinations */}
        <div className="flex-1 flex flex-col h-full min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-[var(--ft-text-3)] mb-4 font-semibold shrink-0">Hop 1 · Destinations</div>
          <div className="flex-1 overflow-y-auto pr-2 pb-12">
            {hop1Dest.map(n => (
              <NodeCard key={n.id} node={n} isExpanded={expandedId === n.id} onToggle={() => setExpandedId(expandedId === n.id ? "" : n.id)} />
            ))}
          </div>
        </div>

        {/* Hop 2 Destinations */}
        <div className="flex-1 flex flex-col h-full min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-[var(--ft-text-3)] mb-4 font-semibold shrink-0">Hop 2 · Destinations</div>
          <div className="flex-1 overflow-y-auto pr-2 pb-12">
            {hop2Dest.map(n => (
              <NodeCard key={n.id} node={n} isExpanded={expandedId === n.id} onToggle={() => setExpandedId(expandedId === n.id ? "" : n.id)} />
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
