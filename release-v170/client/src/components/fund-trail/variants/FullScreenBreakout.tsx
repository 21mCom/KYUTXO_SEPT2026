import { useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  HelpCircle,
  Wallet,
  User,
  KeyRound,
  Target,
  ChevronRight,
  BoxSelect,
  LayoutPanelLeft,
  Clock,
} from "lucide-react";
import type { FundTrailViewData, SampleNode } from "../view-data";
import {
  DIMENSION_LABEL,
  formatBtc,
  shortAddr,
  shortTxid,
  formatDate,
  formatDateShort,
} from "../view-data";
import { HopCapNotice } from "../shared";
import "../fund-trail-view.css";

const CARD_W = 240;
const NODE_H = 116;
const V_GAP = 28;
const COL_STEP = 300;
const COL_PAD_X = 64;
const CENTER_W = 240;
const CENTER_H = 200;
const TOP = 48;

function dimensionIcon(dim: string) {
  if (dim === "walletName") return <Wallet className="w-3 h-3" />;
  if (dim === "owner") return <User className="w-3 h-3" />;
  if (dim === "seedName") return <KeyRound className="w-3 h-3" />;
  return <BoxSelect className="w-3 h-3" />;
}

interface Placed {
  node: SampleNode;
  x: number;
  y: number;
}

interface ColumnMeta {
  x: number;
  midY: number;
}

export function FullScreenBreakout({ data }: { data: FundTrailViewData }) {
  const sourceDepths: number[] = [];
  for (let d = data.maxSourceDepth; d >= 1; d--) sourceDepths.push(d);
  const destDepths: number[] = [];
  for (let d = 1; d <= data.maxDestDepth; d++) destDepths.push(d);

  const layout = useMemo(() => {
    // Column order: deepest sources … hop-1 sources, CENTER, hop-1 dests … deepest dests.
    const columns: {
      key: string;
      direction: "source" | "dest";
      depth: number;
      nodes: SampleNode[];
    }[] = [
      ...sourceDepths.map((d) => ({
        key: `source-${d}`,
        direction: "source" as const,
        depth: d,
        nodes: data.sourcesAtHop(d),
      })),
    ];
    const centerIndex = columns.length;
    columns.push(
      ...destDepths.map((d) => ({
        key: `dest-${d}`,
        direction: "dest" as const,
        depth: d,
        nodes: data.destinationsAtHop(d),
      })),
    );

    const maxNodes = columns.reduce((m, c) => Math.max(m, c.nodes.length), 1);
    const contentH = maxNodes * NODE_H + (maxNodes - 1) * V_GAP;
    const canvasH = Math.max(560, contentH + TOP * 2);

    const colX = (colIdx: number) => COL_PAD_X + colIdx * COL_STEP;
    // Account for the center column slot when laying out columns to its right.
    const slotX = (arrIdx: number) =>
      colX(arrIdx < centerIndex ? arrIdx : arrIdx + 1);

    const placed = new Map<string, Placed>();
    const colMeta = new Map<string, ColumnMeta>();

    columns.forEach((col, arrIdx) => {
      const x = slotX(arrIdx);
      const n = col.nodes.length;
      const totalH = n * NODE_H + (n - 1) * V_GAP;
      const startY = Math.max(TOP, (canvasH - totalH) / 2);
      col.nodes.forEach((node, i) => {
        placed.set(node.id, { node, x, y: startY + i * (NODE_H + V_GAP) });
      });
      colMeta.set(col.key, {
        x,
        midY: n > 0 ? startY + totalH / 2 : canvasH / 2,
      });
    });

    const centerX = colX(centerIndex);
    const centerY = canvasH / 2 - CENTER_H / 2;
    const centerMidY = canvasH / 2;
    colMeta.set("center", { x: centerX, midY: centerMidY });

    const canvasW = colX(columns.length) + CARD_W;

    return { columns, placed, colMeta, centerX, centerY, centerMidY, canvasH, canvasW };
  }, [data, sourceDepths.join(","), destDepths.join(",")]);

  const defaultId =
    data.sourcesAtHop(1)[0]?.id ?? data.destinationsAtHop(1)[0]?.id ?? "";
  const [selectedId, setSelectedId] = useState<string>(defaultId);
  const selectedNode =
    [...data.sources, ...data.destinations].find((n) => n.id === selectedId) ??
    null;

  const hasTime = data.timeRange.endSec > data.timeRange.startSec;
  const axisTicks = useMemo(() => {
    if (!hasTime) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      f,
      sec:
        data.timeRange.startSec +
        f * (data.timeRange.endSec - data.timeRange.startSec),
    }));
  }, [data.timeRange.startSec, data.timeRange.endSec, hasTime]);

  // Connector paths derived purely from computed coordinates.
  const connectors = useMemo(() => {
    const paths: {
      key: string;
      d: string;
      color: string;
      dashed: boolean;
      width: number;
    }[] = [];
    const curve = (x1: number, y1: number, x2: number, y2: number) => {
      const midX = (x1 + x2) / 2;
      return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
    };

    for (const node of data.sources) {
      const p = layout.placed.get(node.id);
      if (!p) continue;
      const fromX = p.x + CARD_W;
      const fromY = p.y + NODE_H / 2;
      const prevKey = node.hopDepth === 1 ? "center" : `source-${node.hopDepth - 1}`;
      const target = layout.colMeta.get(prevKey);
      if (!target) continue;
      paths.push({
        key: `c-${node.id}`,
        d: curve(fromX, fromY, target.x, target.midY),
        color: node.isUnknown ? "var(--ft-unknown)" : "var(--ft-source)",
        dashed: node.hopDepth > 1,
        width: node.hopDepth === 1 ? 2.5 : 1.5,
      });
    }

    for (const node of data.destinations) {
      const p = layout.placed.get(node.id);
      if (!p) continue;
      const toX = p.x;
      const toY = p.y + NODE_H / 2;
      const prevKey = node.hopDepth === 1 ? "center" : `dest-${node.hopDepth - 1}`;
      const source = layout.colMeta.get(prevKey);
      if (!source) continue;
      const fromX =
        prevKey === "center" ? source.x + CENTER_W : source.x + CARD_W;
      paths.push({
        key: `c-${node.id}`,
        d: curve(fromX, source.midY, toX, toY),
        color: node.isUnknown ? "var(--ft-unknown)" : "var(--ft-dest)",
        dashed: node.hopDepth > 1,
        width: node.hopDepth === 1 ? 2.5 : 1.5,
      });
    }
    return paths;
  }, [data, layout]);

  return (
    <div className="ft-root w-full h-full flex flex-col bg-[var(--ft-bg-2)] relative overflow-hidden text-sm">
      <header className="h-12 border-b border-[var(--ft-border)] bg-[var(--ft-panel)] flex items-center gap-2 px-4 shrink-0 text-[var(--ft-text-2)]">
        <span>Fund Trail</span>
        <ChevronRight className="w-4 h-4" />
        <span className="text-[var(--ft-text)] font-medium">Full view</span>
      </header>

      <div className="flex-1 flex overflow-hidden min-h-0">
        <main className="flex-1 relative flex flex-col min-w-0">
          <div className="absolute top-12 right-4 z-10 pointer-events-none">
            <HopCapNotice caps={data.caps} className="max-w-[320px] items-end" />
          </div>
          {hasTime ? (
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
          ) : (
            <div className="h-9 border-b border-[var(--ft-border)] flex items-center px-12 text-xs text-[var(--ft-text-3)] shrink-0">
              Transaction dates unavailable for this trail
            </div>
          )}

          <div className="flex-1 relative overflow-auto p-8 min-h-0">
            <div
              className="relative"
              style={{ width: layout.canvasW, height: layout.canvasH }}
            >
              <svg
                className="absolute inset-0 pointer-events-none"
                width={layout.canvasW}
                height={layout.canvasH}
              >
                {connectors.map((c) => (
                  <path
                    key={c.key}
                    d={c.d}
                    fill="none"
                    stroke={c.color}
                    strokeWidth={c.width}
                    strokeOpacity={c.dashed ? 0.5 : 0.7}
                    strokeDasharray={c.dashed ? "4 4" : undefined}
                  />
                ))}
              </svg>

              {/* Nodes */}
              {[...data.sources, ...data.destinations].map((node) => {
                const p = layout.placed.get(node.id);
                if (!p) return null;
                const isSel = node.id === selectedId;
                const color = node.isUnknown
                  ? "var(--ft-unknown)"
                  : node.direction === "source"
                    ? "var(--ft-source)"
                    : "var(--ft-dest)";
                const amountStr = formatBtc(node.totalSats);
                const isBig = node.totalSats > 50_000_000;
                return (
                  <div
                    key={node.id}
                    className={`absolute flex flex-col p-3 rounded-lg border bg-[var(--ft-panel-2)] hover:border-[var(--ft-border-strong)] transition-colors cursor-pointer ft-fade-in ${
                      isSel
                        ? "border-[var(--ft-accent)] shadow-[0_0_0_1px_var(--ft-accent)]"
                        : "border-[var(--ft-border)]"
                    }`}
                    style={{ left: p.x, top: p.y, width: CARD_W, height: NODE_H }}
                    onClick={() => setSelectedId(node.id)}
                    data-testid={`ft-node-${node.id}`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5 text-[var(--ft-text-2)] text-[11px] font-medium uppercase tracking-wider">
                        {dimensionIcon(node.dimension)}
                        <span>{DIMENSION_LABEL[node.dimension]}</span>
                      </div>
                      {node.direction === "source" ? (
                        <ArrowDownLeft className="w-4 h-4" style={{ color }} />
                      ) : (
                        <ArrowUpRight className="w-4 h-4" style={{ color }} />
                      )}
                    </div>
                    <div
                      className={`font-medium mb-1 truncate ${
                        node.isUnknown
                          ? "text-[var(--ft-text-2)] italic"
                          : "text-[var(--ft-text)]"
                      }`}
                      title={node.groupLabel}
                    >
                      {node.groupLabel}
                    </div>
                    <div
                      className="flex items-baseline gap-1"
                      style={{ color }}
                    >
                      <span
                        className={`ft-mono ${isBig ? "text-xl font-bold" : "text-base font-medium"}`}
                      >
                        {amountStr.split(".")[0]}
                        <span className="opacity-60 text-sm">
                          .{amountStr.split(".")[1]}
                        </span>
                      </span>
                      <span className="text-xs font-bold tracking-widest opacity-80">
                        BTC
                      </span>
                    </div>
                    <div className="mt-auto flex items-center gap-1.5 text-[10px] text-[var(--ft-text-3)]">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span className="ft-mono">
                        {formatDateShort(data.nodeDate(node))}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Center */}
              <div
                className="absolute flex flex-col items-center p-6 rounded-xl border-2 border-[var(--ft-accent)] bg-[var(--ft-panel)] shadow-[0_0_40px_rgba(247,147,26,0.1)]"
                style={{
                  left: layout.centerX,
                  top: layout.centerY,
                  width: CENTER_W,
                  height: CENTER_H,
                }}
              >
                <div className="w-12 h-12 rounded-full bg-[var(--ft-accent-soft)] flex items-center justify-center mb-3 text-[var(--ft-accent)]">
                  <Target className="w-6 h-6" />
                </div>
                <div className="flex items-center gap-1.5 text-[var(--ft-accent)] text-xs font-bold uppercase tracking-wider mb-1">
                  {dimensionIcon(data.center.dimension)}
                  <span>{DIMENSION_LABEL[data.center.dimension]}</span>
                </div>
                <h2
                  className="text-xl font-medium text-[var(--ft-text)] mb-4 truncate max-w-full"
                  title={data.center.groupLabel}
                >
                  {data.center.groupLabel}
                </h2>
                <div className="w-full flex justify-between items-center gap-4 text-sm">
                  <div className="flex flex-col items-start">
                    <span className="text-[var(--ft-text-3)] text-xs mb-0.5">
                      Total In
                    </span>
                    <span className="ft-mono font-medium text-[var(--ft-source)]">
                      {formatBtc(data.center.totalInSats, true)}
                    </span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-[var(--ft-text-3)] text-xs mb-0.5">
                      Total Out
                    </span>
                    <span className="ft-mono font-medium text-[var(--ft-dest)]">
                      {formatBtc(data.center.totalOutSats, true)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="absolute bottom-6 left-6 bg-[var(--ft-panel)] border border-[var(--ft-border)] rounded-lg p-3 flex flex-col gap-2 shadow-lg">
            <div className="text-xs font-medium text-[var(--ft-text-2)] uppercase tracking-wider mb-1">
              Legend
            </div>
            <div className="flex items-center gap-2 text-xs">
              <div className="w-2.5 h-2.5 rounded-sm bg-[var(--ft-source)]"></div>
              <span>Source (funds in)</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <div className="w-2.5 h-2.5 rounded-sm bg-[var(--ft-dest)]"></div>
              <span>Destination (funds out)</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <div className="w-2.5 h-2.5 rounded-sm bg-[var(--ft-unknown)]"></div>
              <span>Unknown entity</span>
            </div>
            <div className="flex items-center gap-2 text-xs mt-1 pt-2 border-t border-[var(--ft-border)] text-[var(--ft-text-3)]">
              <span className="inline-block w-5 border-t-2 border-dashed border-[var(--ft-text-3)]"></span>
              <span>Aggregate hop link</span>
            </div>
          </div>
        </main>

        {/* Detail side-panel */}
        <aside className="w-80 border-l border-[var(--ft-border)] bg-[var(--ft-panel)] flex flex-col shrink-0">
          <div className="p-4 border-b border-[var(--ft-border)] flex items-center gap-3">
            <LayoutPanelLeft className="w-5 h-5 text-[var(--ft-text-2)]" />
            <h3 className="font-medium text-[var(--ft-text)]">
              Selection details
            </h3>
          </div>

          {selectedNode ? (
            <div className="p-5 flex-1 overflow-auto flex flex-col gap-6 ft-fade-in">
              <div>
                <div className="flex items-center gap-2 text-[var(--ft-text-2)] text-xs font-medium uppercase tracking-wider mb-2">
                  <BoxSelect className="w-3 h-3" />
                  <span>
                    {selectedNode.direction === "source"
                      ? "Source"
                      : "Destination"}{" "}
                    · Hop {selectedNode.hopDepth}
                  </span>
                </div>
                <h2 className="text-xl font-medium text-[var(--ft-text)] mb-1 flex items-center gap-2">
                  <span className="truncate" title={selectedNode.groupLabel}>
                    {selectedNode.groupLabel}
                  </span>
                  {selectedNode.isUnknown && (
                    <HelpCircle className="w-4 h-4 text-[var(--ft-unknown)] shrink-0" />
                  )}
                </h2>
                <div className="text-sm text-[var(--ft-text-3)] flex items-center gap-2">
                  <span>Total flow:</span>
                  <span
                    className="ft-mono font-medium"
                    style={{
                      color:
                        selectedNode.direction === "source"
                          ? "var(--ft-source)"
                          : "var(--ft-dest)",
                    }}
                  >
                    {formatBtc(selectedNode.totalSats)} BTC
                  </span>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-[var(--ft-text-2)] uppercase tracking-wider mb-3">
                  Underlying transactions ({selectedNode.details.length})
                </div>
                <div className="flex flex-col gap-3">
                  {selectedNode.details.map((detail, idx) => (
                    <div
                      key={idx}
                      className="bg-[var(--ft-bg)] border border-[var(--ft-border)] rounded-lg p-3"
                    >
                      <div className="flex items-center justify-between mb-2 gap-2">
                        <span className="text-xs text-[var(--ft-text-2)]">
                          {formatDate(detail.blockTime)}
                        </span>
                        <span
                          className="ft-mono text-sm font-medium"
                          style={{
                            color:
                              selectedNode.direction === "source"
                                ? "var(--ft-source)"
                                : "var(--ft-dest)",
                          }}
                        >
                          {selectedNode.direction === "source" ? "+" : "-"}
                          {formatBtc(detail.amount)}
                        </span>
                      </div>
                      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                        <span className="text-[var(--ft-text-3)]">Addr</span>
                        <span
                          className="ft-mono text-[var(--ft-text)] truncate"
                          title={detail.address}
                        >
                          {shortAddr(detail.address)}
                        </span>
                        <span className="text-[var(--ft-text-3)]">TxID</span>
                        <span
                          className="ft-mono text-[var(--ft-accent)] truncate"
                          title={detail.txid}
                        >
                          {shortTxid(detail.txid)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-5 text-sm text-[var(--ft-text-3)]">
              Select a node to see its underlying transactions.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
