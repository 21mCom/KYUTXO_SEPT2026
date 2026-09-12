import React from "react";
import { 
  CENTER, SOURCES, DESTINATIONS, TIME_RANGE, DIMENSION_LABEL, 
  formatBtc, shortAddr, shortTxid, formatDate, formatDateShort, 
  timePosition, nodeDate, sourcesAtHop, destinationsAtHop 
} from "./_data";
import "./_group.css";
import { 
  ArrowDownLeft, ArrowUpRight, HelpCircle, AlertTriangle, 
  Wallet, User, KeyRound, Maximize2, ZoomIn, ZoomOut, Target,
  X, ChevronRight, Layers, LayoutPanelLeft, BoxSelect, Maximize, Clock
} from "lucide-react";

export function FullScreenBreakout() {
  const hop1Sources = sourcesAtHop(1);
  const hop2Sources = sourcesAtHop(2);
  const hop1Dests = destinationsAtHop(1);
  const hop2Dests = destinationsAtHop(2);

  const selectedNode = SOURCES.find(s => s.id === "src-unknown");

  // Shared time axis: evenly-spaced ticks across the real range, labelled with actual dates.
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    f,
    sec: TIME_RANGE.startSec + f * (TIME_RANGE.endSec - TIME_RANGE.startSec),
  }));

  const getDimensionIcon = (dim: string) => {
    if (dim === "walletName") return <Wallet className="w-3 h-3" />;
    if (dim === "owner") return <User className="w-3 h-3" />;
    if (dim === "seedName") return <KeyRound className="w-3 h-3" />;
    return <BoxSelect className="w-3 h-3" />;
  };

  const getNodeColor = (type: "source" | "dest" | "center" | "unknown") => {
    switch (type) {
      case "source": return "text-[var(--ft-source)]";
      case "dest": return "text-[var(--ft-dest)]";
      case "center": return "text-[var(--ft-accent)]";
      case "unknown": return "text-[var(--ft-unknown)]";
    }
  };

  const getBgColor = (type: "source" | "dest" | "center" | "unknown") => {
    switch (type) {
      case "source": return "bg-[var(--ft-source-soft)]";
      case "dest": return "bg-[var(--ft-dest-soft)]";
      case "center": return "bg-[var(--ft-accent-soft)]";
      case "unknown": return "bg-[var(--ft-unknown-soft)]";
    }
  };

  const NodeCard = ({ node, type, isSelected = false }: { node: any, type: "source"|"dest"|"unknown", isSelected?: boolean }) => {
    const isUnknown = node.isUnknown;
    const resolvedType = isUnknown ? "unknown" : type;
    const colorClass = getNodeColor(resolvedType);
    const bgClass = getBgColor(resolvedType);
    const hasCap = !!node.cap;

    // determine visual weight based on sats
    const amountStr = formatBtc(node.totalSats);
    const isBig = node.totalSats > 50_000_000;

    return (
      <div className={`relative flex flex-col p-3 rounded-lg border ${isSelected ? 'border-[var(--ft-accent)] shadow-[0_0_0_1px_var(--ft-accent)]' : 'border-[var(--ft-border)]'} bg-[var(--ft-panel-2)] hover:border-[var(--ft-border-strong)] transition-colors cursor-pointer w-64 group`}>
        {hasCap && (
          <div className="absolute -top-2 -right-2 bg-[var(--ft-warn)] text-[var(--ft-bg)] rounded-full p-1 shadow-lg">
            <AlertTriangle className="w-3 h-3" />
          </div>
        )}
        
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-[var(--ft-text-2)] text-xs font-medium uppercase tracking-wider">
            {getDimensionIcon(node.dimension)}
            <span>{DIMENSION_LABEL[node.dimension as keyof typeof DIMENSION_LABEL]}</span>
          </div>
          {type === 'source' ? <ArrowDownLeft className={`w-4 h-4 ${colorClass}`} /> : <ArrowUpRight className={`w-4 h-4 ${colorClass}`} />}
        </div>
        
        <div className={`font-medium mb-1 ${isUnknown ? 'text-[var(--ft-text-2)] italic' : 'text-[var(--ft-text)]'} truncate`}>
          {node.groupLabel}
        </div>
        
        <div className={`flex items-baseline gap-1 ${colorClass}`}>
          <span className={`ft-mono ${isBig ? 'text-xl font-bold' : 'text-base font-medium'}`}>
            {amountStr.split('.')[0]}
            <span className="opacity-60 text-sm">.{amountStr.split('.')[1]}</span>
          </span>
          <span className="text-xs font-bold tracking-widest opacity-80">BTC</span>
        </div>

        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--ft-text-3)]">
          <Clock className="w-3 h-3 shrink-0" />
          <span className="ft-mono">{formatDateShort(nodeDate(node))}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="ft-root w-full h-screen flex bg-[#05080c] relative overflow-hidden text-sm">
      
      {/* 
        ENTRY POINT INSET (Illustrative compact panel corner) 
      */}
      <div className="absolute top-4 left-4 w-72 rounded-xl border border-[var(--ft-border)] bg-[var(--ft-panel)] shadow-2xl z-50 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--ft-border)] flex items-center justify-between bg-[var(--ft-bg)]">
          <span className="font-medium text-[var(--ft-text)]">Fund Trail</span>
          <Maximize2 className="w-4 h-4 text-[var(--ft-text-3)]" />
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between text-xs text-[var(--ft-text-2)]">
            <span>Sources (3)</span>
            <span>2.005 BTC</span>
          </div>
          <div className="flex items-center gap-2 p-2 rounded bg-[var(--ft-panel-2)] border border-[var(--ft-border)] text-xs">
            <div className="w-2 h-2 rounded-full bg-[var(--ft-source)]"></div>
            <span className="flex-1 truncate">Coinbase Withdrawal</span>
            <span className="ft-mono">1.50</span>
          </div>
          <button className="mt-2 w-full py-2 bg-[var(--ft-accent)] hover:bg-[var(--ft-accent)]/90 text-[var(--ft-bg)] font-medium rounded text-xs flex items-center justify-center gap-1.5 transition-colors">
            <Maximize className="w-3.5 h-3.5" />
            Open full trail
          </button>
        </div>
      </div>

      {/* 
        BREAKOUT MODAL BACKDROP 
      */}
      <div className="absolute inset-0 bg-[var(--ft-bg)]/80 backdrop-blur-sm z-40 p-4 sm:p-6 lg:p-8 flex">
        
        {/* MODAL WINDOW */}
        <div className="flex-1 flex flex-col bg-[var(--ft-bg-2)] border border-[var(--ft-border)] rounded-2xl shadow-2xl overflow-hidden relative">
          
          {/* HEADER */}
          <header className="h-14 border-b border-[var(--ft-border)] bg-[var(--ft-panel)] flex items-center justify-between px-4 shrink-0">
            <div className="flex items-center gap-2 text-[var(--ft-text-2)]">
              <span>Reports</span>
              <ChevronRight className="w-4 h-4" />
              <span className="text-[var(--ft-text)] font-medium">Fund Trail — Full View</span>
            </div>
            <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-[var(--ft-panel-2)] text-[var(--ft-text-2)] transition-colors">
              <X className="w-5 h-5" />
            </button>
          </header>

          <div className="flex-1 flex overflow-hidden">
            
            {/* CANVAS AREA */}
            <main className="flex-1 relative flex flex-col min-w-0">
              
              {/* TIME AXIS — accurate linear axis (oldest left → newest right); each node shows its date */}
              <div className="h-10 border-b border-[var(--ft-border)] bg-[var(--ft-bg)]/50 relative text-xs text-[var(--ft-text-3)] shrink-0">
                <div className="absolute left-12 right-12 top-1/2 h-px bg-[var(--ft-border)] -translate-y-1/2"></div>
                <div className="absolute left-12 right-12 inset-y-0">
                  {axisTicks.map((t, i) => (
                    <div
                      key={i}
                      className="absolute top-1/2 flex items-center"
                      style={{
                        left: `${t.f * 100}%`,
                        transform:
                          i === 0
                            ? "translateY(-50%)"
                            : i === axisTicks.length - 1
                            ? "translate(-100%, -50%)"
                            : "translate(-50%, -50%)",
                      }}
                    >
                      <span className="bg-[var(--ft-panel)] px-2 ft-mono whitespace-nowrap rounded">
                        {formatDateShort(t.sec)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* GRAPH WORKSPACE */}
              <div className="flex-1 relative overflow-auto p-12 bg-grid-pattern bg-[length:24px_24px]">
                {/* Connectors (Illustrative SVGs) */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ minWidth: '1200px' }}>
                  <path d="M 330 300 C 450 300, 450 450, 580 450" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" />
                  <path d="M 330 450 C 450 450, 450 450, 580 450" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" />
                  <path d="M 330 600 C 450 600, 450 450, 580 450" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" />
                  
                  <path d="M 850 450 C 980 450, 980 300, 1100 300" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" />
                  <path d="M 850 450 C 980 450, 980 450, 1100 450" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" />
                  <path d="M 850 450 C 980 450, 980 600, 1100 600" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" />

                  {/* Hop 2 connectors */}
                  <path d="M 60 250 C 120 250, 120 300, 200 300" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" strokeDasharray="4 4" />
                  <path d="M 60 550 C 120 550, 120 600, 200 600" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" strokeDasharray="4 4" />

                  <path d="M 1360 400 C 1280 400, 1280 450, 1200 450" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" strokeDasharray="4 4" />
                  <path d="M 1360 650 C 1280 650, 1280 600, 1200 600" fill="none" stroke="var(--ft-border-strong)" strokeWidth="2" strokeDasharray="4 4" />
                </svg>

                <div className="min-w-[1200px] h-[800px] relative flex justify-between items-center px-12">
                  
                  {/* Hop 2 Sources */}
                  <div className="flex flex-col gap-24 relative z-10 w-48">
                    {hop2Sources.map((node, i) => (
                      <div key={node.id} className="scale-90 opacity-70 hover:opacity-100 transition-opacity translate-x-12" style={{ marginTop: i === 0 ? '-100px' : '200px' }}>
                        <NodeCard node={node} type="source" />
                      </div>
                    ))}
                  </div>

                  {/* Hop 1 Sources */}
                  <div className="flex flex-col gap-6 relative z-10 w-64">
                    {hop1Sources.map(node => (
                      <NodeCard key={node.id} node={node} type="source" isSelected={node.id === "src-unknown"} />
                    ))}
                  </div>

                  {/* CENTER */}
                  <div className="relative z-10 w-72 flex justify-center">
                    <div className="flex flex-col items-center p-6 rounded-xl border-2 border-[var(--ft-accent)] bg-[var(--ft-panel)] shadow-[0_0_40px_rgba(247,147,26,0.1)]">
                      <div className="w-12 h-12 rounded-full bg-[var(--ft-accent-soft)] flex items-center justify-center mb-3 text-[var(--ft-accent)]">
                        <Target className="w-6 h-6" />
                      </div>
                      <div className="flex items-center gap-1.5 text-[var(--ft-accent)] text-xs font-bold uppercase tracking-wider mb-1">
                        <User className="w-3 h-3" />
                        <span>Owner</span>
                      </div>
                      <h2 className="text-xl font-medium text-[var(--ft-text)] mb-4">{CENTER.groupLabel}</h2>
                      
                      <div className="w-full flex justify-between items-center gap-8 text-sm">
                        <div className="flex flex-col items-start">
                          <span className="text-[var(--ft-text-3)] text-xs mb-0.5">Total In</span>
                          <span className="ft-mono font-medium text-[var(--ft-source)]">{formatBtc(CENTER.totalInSats, true)}</span>
                        </div>
                        <div className="flex flex-col items-end">
                          <span className="text-[var(--ft-text-3)] text-xs mb-0.5">Total Out</span>
                          <span className="ft-mono font-medium text-[var(--ft-dest)]">{formatBtc(CENTER.totalOutSats, true)}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Hop 1 Destinations */}
                  <div className="flex flex-col gap-6 relative z-10 w-64">
                    {hop1Dests.map(node => (
                      <NodeCard key={node.id} node={node} type="dest" />
                    ))}
                  </div>

                  {/* Hop 2 Destinations */}
                  <div className="flex flex-col gap-24 relative z-10 w-48">
                    {hop2Dests.map((node, i) => (
                      <div key={node.id} className="scale-90 opacity-70 hover:opacity-100 transition-opacity -translate-x-12" style={{ marginTop: i === 0 ? '-50px' : '200px' }}>
                        <NodeCard node={node} type="dest" />
                      </div>
                    ))}
                  </div>

                </div>
              </div>

              {/* OVERLAYS (Chrome) */}
              {/* Legend */}
              <div className="absolute bottom-6 left-6 bg-[var(--ft-panel)] border border-[var(--ft-border)] rounded-lg p-3 flex flex-col gap-2 shadow-lg">
                <div className="text-xs font-medium text-[var(--ft-text-2)] uppercase tracking-wider mb-1">Legend</div>
                <div className="flex items-center gap-2 text-xs">
                  <div className="w-2.5 h-2.5 rounded-sm bg-[var(--ft-source)]"></div>
                  <span>Source (Funds In)</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <div className="w-2.5 h-2.5 rounded-sm bg-[var(--ft-dest)]"></div>
                  <span>Destination (Funds Out)</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <div className="w-2.5 h-2.5 rounded-sm bg-[var(--ft-unknown)]"></div>
                  <span>Unknown Entity</span>
                </div>
                <div className="flex items-center gap-2 text-xs mt-1 pt-2 border-t border-[var(--ft-border)]">
                  <div className="w-2.5 h-2.5 rounded-sm bg-[var(--ft-warn)] flex items-center justify-center">
                    <AlertTriangle className="w-2 h-2 text-[var(--ft-bg)]" strokeWidth={3} />
                  </div>
                  <span>Capped Results</span>
                </div>
              </div>

              {/* Controls */}
              <div className="absolute bottom-6 right-6 flex items-center gap-2 bg-[var(--ft-panel)] border border-[var(--ft-border)] rounded-lg p-1 shadow-lg">
                <button className="p-2 hover:bg-[var(--ft-panel-2)] rounded text-[var(--ft-text-2)] hover:text-[var(--ft-text)] transition-colors" title="Zoom Out">
                  <ZoomOut className="w-4 h-4" />
                </button>
                <div className="text-xs font-medium px-2 ft-mono text-[var(--ft-text-2)]">100%</div>
                <button className="p-2 hover:bg-[var(--ft-panel-2)] rounded text-[var(--ft-text-2)] hover:text-[var(--ft-text)] transition-colors" title="Zoom In">
                  <ZoomIn className="w-4 h-4" />
                </button>
                <div className="w-px h-4 bg-[var(--ft-border)] mx-1"></div>
                <button className="p-2 hover:bg-[var(--ft-panel-2)] rounded text-[var(--ft-text-2)] hover:text-[var(--ft-text)] transition-colors text-xs font-medium uppercase tracking-wider">
                  Fit
                </button>
              </div>

              {/* Minimap */}
              <div className="absolute top-16 left-6 w-40 h-28 bg-[var(--ft-panel)] border border-[var(--ft-border)] rounded-lg shadow-lg overflow-hidden hidden md:block">
                <div className="absolute inset-0 opacity-20 bg-grid-pattern bg-[length:8px_8px]"></div>
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2">
                  <div className="w-8 h-12 flex flex-col gap-1 justify-center"><div className="w-full h-1 bg-[var(--ft-source)]"></div><div className="w-full h-2 bg-[var(--ft-source)]"></div></div>
                  <div className="w-6 h-6 rounded-sm bg-[var(--ft-accent)]"></div>
                  <div className="w-8 h-12 flex flex-col gap-1 justify-center"><div className="w-full h-2 bg-[var(--ft-dest)]"></div><div className="w-full h-1 bg-[var(--ft-dest)]"></div></div>
                </div>
                <div className="absolute inset-2 border border-[var(--ft-text-3)] rounded bg-white/5"></div>
              </div>

            </main>

            {/* DETAIL SIDE-PANEL */}
            <aside className="w-96 border-l border-[var(--ft-border)] bg-[var(--ft-panel)] flex flex-col shrink-0">
              <div className="p-4 border-b border-[var(--ft-border)] flex items-center gap-3">
                <LayoutPanelLeft className="w-5 h-5 text-[var(--ft-text-2)]" />
                <h3 className="font-medium text-[var(--ft-text)]">Selection Details</h3>
              </div>
              
              {selectedNode && (
                <div className="p-5 flex-1 overflow-auto flex flex-col gap-6 ft-fade-in">
                  
                  {/* Selected Node Header */}
                  <div>
                    <div className="flex items-center gap-2 text-[var(--ft-text-2)] text-xs font-medium uppercase tracking-wider mb-2">
                      <BoxSelect className="w-3 h-3" />
                      <span>{selectedNode.direction === 'source' ? 'Source' : 'Destination'} Hop {selectedNode.hopDepth}</span>
                    </div>
                    <h2 className="text-xl font-medium text-[var(--ft-text)] mb-1 flex items-center gap-2">
                      {selectedNode.groupLabel}
                      {selectedNode.isUnknown && <HelpCircle className="w-4 h-4 text-[var(--ft-unknown)]" />}
                    </h2>
                    <div className="text-sm text-[var(--ft-text-3)] flex items-center gap-2">
                      <span>Total Flow:</span>
                      <span className="ft-mono text-[var(--ft-source)] font-medium">{formatBtc(selectedNode.totalSats)} BTC</span>
                    </div>
                  </div>

                  {/* Cap Notice */}
                  {selectedNode.cap && (
                    <div className="bg-[var(--ft-warn-soft)] border border-[var(--ft-warn)]/30 rounded-lg p-3 flex gap-3 text-[var(--ft-warn)]">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="font-medium mb-1">Partial results shown</p>
                        <p className="opacity-80 leading-relaxed">
                          This group is highly active. Showing only the most recent <strong className="font-medium">{selectedNode.cap.shown.toLocaleString()}</strong> of <strong className="font-medium">{selectedNode.cap.total.toLocaleString()}</strong> transactions to preserve performance.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Transactions List */}
                  <div>
                    <div className="text-xs font-medium text-[var(--ft-text-2)] uppercase tracking-wider mb-3">
                      Underlying Transactions ({selectedNode.details.length})
                    </div>
                    <div className="flex flex-col gap-3">
                      {selectedNode.details.map((detail, idx) => (
                        <div key={idx} className="bg-[var(--ft-bg)] border border-[var(--ft-border)] rounded-lg p-3 hover:border-[var(--ft-border-strong)] transition-colors">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-[var(--ft-text-2)]">{formatDate(detail.blockTime)}</span>
                            <span className="ft-mono text-sm text-[var(--ft-source)] font-medium">
                              +{formatBtc(detail.amount)}
                            </span>
                          </div>
                          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                            <span className="text-[var(--ft-text-3)]">Addr</span>
                            <span className="ft-mono text-[var(--ft-text)] truncate" title={detail.address}>{shortAddr(detail.address)}</span>
                            
                            <span className="text-[var(--ft-text-3)]">TxID</span>
                            <span className="ft-mono text-[var(--ft-accent)] hover:underline cursor-pointer truncate" title={detail.txid}>{shortTxid(detail.txid)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                </div>
              )}

            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
