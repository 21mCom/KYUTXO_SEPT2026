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
} from "./_data";
import type { SampleNode, SampleDetail } from "./_data";
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
  ChevronUp,
} from "lucide-react";

function getDimensionIcon(dimension: string, isUnknown: boolean) {
  if (isUnknown) return <HelpCircle className="w-3.5 h-3.5" />;
  switch (dimension) {
    case "walletName":
      return <Wallet className="w-3.5 h-3.5" />;
    case "owner":
      return <User className="w-3.5 h-3.5" />;
    case "seedName":
      return <KeyRound className="w-3.5 h-3.5" />;
    default:
      return <Wallet className="w-3.5 h-3.5" />;
  }
}

function getNodeColor(direction: "source" | "dest" | "center", isUnknown: boolean) {
  if (direction === "center") return "var(--ft-accent)";
  if (isUnknown) return "var(--ft-unknown)";
  return direction === "source" ? "var(--ft-source)" : "var(--ft-dest)";
}

function getNodeSoftColor(direction: "source" | "dest" | "center", isUnknown: boolean) {
  if (direction === "center") return "var(--ft-accent-soft)";
  if (isUnknown) return "var(--ft-unknown-soft)";
  return direction === "source" ? "var(--ft-source-soft)" : "var(--ft-dest-soft)";
}

function TxDetails({ details }: { details: SampleDetail[] }) {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="grid grid-cols-[100px_100px_1fr_100px] text-[11px] font-medium text-[var(--ft-text-3)] uppercase tracking-wider px-2">
        <div>Date</div>
        <div>Address</div>
        <div>TxID</div>
        <div className="text-right">Amount</div>
      </div>
      <div className="flex flex-col gap-1">
        {details.map((d, i) => (
          <div
            key={i}
            className="grid grid-cols-[100px_100px_1fr_100px] items-center text-[12px] bg-[var(--ft-panel-2)] rounded px-2 py-1.5"
          >
            <div className="text-[var(--ft-text-2)]">{formatDateShort(d.blockTime)}</div>
            <div className="ft-mono text-[var(--ft-text-2)]">{shortAddr(d.address)}</div>
            <div className="ft-mono text-[var(--ft-text-3)]">{shortTxid(d.txid)}</div>
            <div className="ft-mono text-right text-[var(--ft-text)]">{formatBtc(d.amount)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeCard({
  node,
  isExpanded,
  onToggle,
  direction,
}: {
  node: SampleNode;
  isExpanded: boolean;
  onToggle: () => void;
  direction: "source" | "dest";
}) {
  const color = getNodeColor(direction, node.isUnknown);
  const softColor = getNodeSoftColor(direction, node.isUnknown);

  // visual weight based on size
  const btcAmount = node.totalSats / 100_000_000;
  const isLarge = btcAmount >= 1.0;
  const isSmall = btcAmount < 0.1;

  return (
    <div
      className={`relative w-[480px] bg-[var(--ft-panel)] border rounded-lg p-4 transition-colors cursor-pointer group hover:border-[var(--ft-border-strong)]`}
      style={{
        borderColor: isExpanded ? color : "var(--ft-border)",
        boxShadow: isExpanded ? `0 0 0 1px ${color}` : "none",
      }}
      onClick={onToggle}
    >
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium"
              style={{ backgroundColor: softColor, color: color }}
            >
              {getDimensionIcon(node.dimension, node.isUnknown)}
              {DIMENSION_LABEL[node.dimension]}
            </div>
            {node.hopDepth > 1 && (
              <div className="text-[10px] text-[var(--ft-text-3)] bg-[var(--ft-panel-2)] px-1.5 py-0.5 rounded">
                Hop {node.hopDepth}
              </div>
            )}
          </div>
          <div
            className={`font-semibold text-[var(--ft-text)] ${isLarge ? "text-xl" : "text-base"}`}
          >
            {node.groupLabel}
          </div>
          {node.isUnknown && node.cap && (
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--ft-warn)] mt-1 bg-[var(--ft-warn-soft)] px-2 py-1 rounded w-fit">
              <AlertTriangle className="w-3.5 h-3.5" />
              Showing only the most recent {node.cap.shown.toLocaleString()} of{" "}
              {node.cap.total.toLocaleString()} transactions
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1">
          <div
            className={`ft-mono font-medium ${isLarge ? "text-lg" : isSmall ? "text-sm text-[var(--ft-text-2)]" : "text-base text-[var(--ft-text)]"}`}
            style={{ color: isLarge ? color : undefined }}
          >
            {direction === "source" ? "+" : "-"}
            {formatBtc(node.totalSats, true)} BTC
          </div>
          <div className="text-[12px] text-[var(--ft-text-3)] flex items-center gap-1">
            {node.details.length} {node.details.length === 1 ? "txn" : "txns"}
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5 ml-1" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 ml-1" />
            )}
          </div>
        </div>
      </div>

      {isExpanded && <TxDetails details={node.details} />}
    </div>
  );
}

export function VerticalTimelineScroll() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "dst-hardware": true,
  });

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const dayTicks = [];
  const startDay = Math.floor(TIME_RANGE.startSec / 86400);
  const endDay = Math.floor(TIME_RANGE.endSec / 86400);
  for (let d = startDay; d <= endDay; d++) {
    dayTicks.push(d * 86400);
  }

  // Calculate pixel positions. Let's make the timeline 1200px tall.
  const TIMELINE_HEIGHT = 1600;
  const getY = (blockTime: number) => {
    return timePosition(blockTime) * TIMELINE_HEIGHT;
  };

  return (
    <div className="ft-root min-h-screen w-full relative overflow-y-auto overflow-x-hidden p-8 flex justify-center">
      <div className="relative w-[1000px] h-[1800px]">
        {/* Date Gutter & Spine */}
        <div className="absolute left-[100px] top-0 bottom-0 w-[2px] bg-[var(--ft-border-strong)] z-0" />
        
        {dayTicks.map((time, i) => (
          <div
            key={i}
            className="absolute left-0 w-[100px] text-right pr-6 flex items-center z-10"
            style={{ top: getY(time) - 10 }}
          >
            <div className="text-[11px] font-medium text-[var(--ft-text-3)]">
              {formatDateShort(time)}
            </div>
            <div className="absolute right-[8px] w-2 h-[2px] bg-[var(--ft-border-strong)]" />
          </div>
        ))}

        {/* Center Node */}
        <div
          className="absolute left-[80px] w-fit flex items-center gap-6 z-20"
          style={{ top: TIMELINE_HEIGHT / 2 - 40 }}
        >
          <div className="w-10 h-10 rounded-full bg-[var(--ft-bg)] border-[2px] border-[var(--ft-accent)] flex items-center justify-center relative">
            <div className="w-3 h-3 rounded-full bg-[var(--ft-accent)]" />
            <div className="absolute top-12 whitespace-nowrap text-[12px] font-bold text-[var(--ft-accent)] tracking-widest uppercase">
              Tracing
            </div>
          </div>
          <div className="bg-[var(--ft-panel)] border border-[var(--ft-accent)] rounded-lg p-4 w-[360px] shadow-[0_0_0_1px_var(--ft-accent)]">
            <div className="flex items-start justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--ft-accent-soft)] text-[var(--ft-accent)] w-fit">
                  {getDimensionIcon(CENTER.dimension, false)}
                  {DIMENSION_LABEL[CENTER.dimension]}
                </div>
                <div className="font-bold text-xl mt-1 text-[var(--ft-text)]">
                  {CENTER.groupLabel}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 text-[13px] ft-mono">
                <div className="text-[var(--ft-source)]">
                  +{formatBtc(CENTER.totalInSats, true)} BTC in
                </div>
                <div className="text-[var(--ft-dest)]">
                  -{formatBtc(CENTER.totalOutSats, true)} BTC out
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sources */}
        {SOURCES.map((node) => {
          const t = nodeDate(node);
          const y = getY(t);
          const isHop2 = node.hopDepth === 2;
          const leftOffset = isHop2 ? 160 : 200;
          return (
            <div
              key={node.id}
              className="absolute flex items-start z-10"
              style={{
                top: y,
                left: leftOffset,
              }}
            >
              <div
                className="absolute top-8 left-[-90px] h-[2px] bg-[var(--ft-border-strong)] z-0"
                style={{
                  width: isHop2 ? "80px" : "90px",
                  left: isHop2 ? "-80px" : "-100px",
                  borderTop: isHop2 ? "2px dashed var(--ft-border-strong)" : "none",
                  backgroundColor: isHop2 ? "transparent" : "var(--ft-border-strong)",
                }}
              />
              {!isHop2 && (
                <div className="absolute top-7 left-[-105px] w-3 h-3 rounded-full bg-[var(--ft-source)] border-2 border-[var(--ft-bg)]" />
              )}
              <NodeCard
                node={node}
                isExpanded={!!expanded[node.id]}
                onToggle={() => toggle(node.id)}
                direction="source"
              />
            </div>
          );
        })}

        {/* Destinations */}
        {DESTINATIONS.map((node) => {
          const t = nodeDate(node);
          const y = getY(t);
          const isHop2 = node.hopDepth === 2;
          const leftOffset = isHop2 ? 160 : 200;
          return (
            <div
              key={node.id}
              className="absolute flex items-start z-10"
              style={{
                top: y,
                left: leftOffset,
              }}
            >
              <div
                className="absolute top-8 left-[-90px] h-[2px] bg-[var(--ft-border-strong)] z-0"
                style={{
                  width: isHop2 ? "80px" : "90px",
                  left: isHop2 ? "-80px" : "-100px",
                  borderTop: isHop2 ? "2px dashed var(--ft-border-strong)" : "none",
                  backgroundColor: isHop2 ? "transparent" : "var(--ft-border-strong)",
                }}
              />
              {!isHop2 && (
                <div className="absolute top-7 left-[-105px] w-3 h-3 rounded-full bg-[var(--ft-dest)] border-2 border-[var(--ft-bg)]" />
              )}
              <NodeCard
                node={node}
                isExpanded={!!expanded[node.id]}
                onToggle={() => toggle(node.id)}
                direction="dest"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
