import { useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  HelpCircle,
  Wallet,
  User,
  KeyRound,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { FundTrailViewData, SampleNode, SampleDetail } from "../view-data";
import {
  DIMENSION_LABEL,
  formatBtc,
  shortAddr,
  shortTxid,
  formatDateShort,
} from "../view-data";
import { roleColor, roleSoftColor, HopCapNotice } from "../shared";
import "../fund-trail-view.css";

function dimensionIcon(dimension: string, isUnknown: boolean) {
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
            <div className="text-[var(--ft-text-2)]">
              {formatDateShort(d.blockTime)}
            </div>
            <div className="ft-mono text-[var(--ft-text-2)]" title={d.address}>
              {shortAddr(d.address)}
            </div>
            <div className="ft-mono text-[var(--ft-text-3)]" title={d.txid}>
              {shortTxid(d.txid)}
            </div>
            <div className="ft-mono text-right text-[var(--ft-text)]">
              {formatBtc(d.amount)}
            </div>
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
}: {
  node: SampleNode;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const color = roleColor(node.direction, node.isUnknown);
  const softColor = roleSoftColor(node.direction, node.isUnknown);

  const btcAmount = node.totalSats / 100_000_000;
  const isLarge = btcAmount >= 1.0;
  const isSmall = btcAmount < 0.1;

  return (
    <div
      className="relative w-[440px] bg-[var(--ft-panel)] border rounded-lg p-4 transition-colors cursor-pointer group hover:border-[var(--ft-border-strong)]"
      style={{
        borderColor: isExpanded ? color : "var(--ft-border)",
        boxShadow: isExpanded ? `0 0 0 1px ${color}` : "none",
      }}
      onClick={onToggle}
      data-testid={`ft-node-${node.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium"
              style={{ backgroundColor: softColor, color }}
            >
              {dimensionIcon(node.dimension, node.isUnknown)}
              {DIMENSION_LABEL[node.dimension]}
            </div>
            {node.hopDepth > 1 && (
              <div className="text-[10px] text-[var(--ft-text-3)] bg-[var(--ft-panel-2)] px-1.5 py-0.5 rounded">
                Hop {node.hopDepth}
              </div>
            )}
          </div>
          <div
            className={`font-semibold text-[var(--ft-text)] truncate ${
              isLarge ? "text-xl" : "text-base"
            }`}
            title={node.groupLabel}
          >
            {node.groupLabel}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <div
            className={`ft-mono font-medium ${
              isLarge
                ? "text-lg"
                : isSmall
                  ? "text-sm text-[var(--ft-text-2)]"
                  : "text-base text-[var(--ft-text)]"
            }`}
            style={{ color: isLarge ? color : undefined }}
          >
            {node.direction === "source" ? "+" : "-"}
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

const SPINE_LEFT = 96;
const CARD_GAP = 110;
const TOP_PAD = 60;

export function VerticalTimelineScroll({ data }: { data: FundTrailViewData }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const hasTime = data.timeRange.endSec > data.timeRange.startSec;

  // Lay out every node (sources + destinations share the spine), ordered by
  // date, with collision avoidance so cards never overlap regardless of count.
  const { laid, timelineHeight, centerY } = useMemo(() => {
    const all = [...data.sources, ...data.destinations]
      .map((node) => ({ node, t: data.nodeDate(node) }))
      .sort((a, b) => a.t - b.t);

    const height = Math.max(900, all.length * CARD_GAP + TOP_PAD * 2);
    let prevY = -Infinity;
    const placed = all.map(({ node, t }) => {
      const target = hasTime
        ? TOP_PAD + data.timePosition(t) * (height - TOP_PAD * 2)
        : TOP_PAD;
      const y = Math.max(target, prevY + CARD_GAP);
      prevY = y;
      return { node, t, y };
    });
    return { laid: placed, timelineHeight: height, centerY: height / 2 };
  }, [data, hasTime]);

  // Evenly-spaced date ticks (cap the count so a wide range never explodes).
  const ticks = useMemo(() => {
    if (!hasTime) return [];
    const COUNT = 10;
    return Array.from({ length: COUNT + 1 }, (_, i) => {
      const f = i / COUNT;
      return {
        sec:
          data.timeRange.startSec +
          f * (data.timeRange.endSec - data.timeRange.startSec),
        y: TOP_PAD + f * (timelineHeight - TOP_PAD * 2),
      };
    });
  }, [data.timeRange.startSec, data.timeRange.endSec, hasTime, timelineHeight]);

  return (
    <div className="ft-root h-full w-full relative overflow-auto p-8">
      <HopCapNotice
        caps={data.caps}
        className="sticky top-0 z-40 max-w-[520px] mb-4"
      />
      <div
        className="relative mx-auto"
        style={{ width: 960, height: timelineHeight + TOP_PAD }}
      >
        {/* Date Gutter & Spine */}
        <div
          className="absolute top-0 bottom-0 w-[2px] bg-[var(--ft-border-strong)] z-0"
          style={{ left: SPINE_LEFT }}
        />
        {ticks.map((tick, i) => (
          <div
            key={i}
            className="absolute left-0 w-[88px] text-right pr-6 flex items-center z-10"
            style={{ top: tick.y - 8 }}
          >
            <div className="text-[11px] font-medium text-[var(--ft-text-3)]">
              {formatDateShort(tick.sec)}
            </div>
            <div className="absolute right-[6px] w-2 h-[2px] bg-[var(--ft-border-strong)]" />
          </div>
        ))}

        {/* Center marker on the spine */}
        <div
          className="absolute z-20 flex items-center gap-4"
          style={{ left: SPINE_LEFT - 16, top: centerY }}
        >
          <div className="w-8 h-8 rounded-full bg-[var(--ft-bg)] border-[2px] border-[var(--ft-accent)] flex items-center justify-center shrink-0">
            <div className="w-3 h-3 rounded-full bg-[var(--ft-accent)]" />
          </div>
          <div className="bg-[var(--ft-panel)] border border-[var(--ft-accent)] rounded-lg p-4 w-[360px] shadow-[0_0_0_1px_var(--ft-accent)]">
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--ft-accent-soft)] text-[var(--ft-accent)] w-fit">
                  {dimensionIcon(data.center.dimension, false)}
                  {DIMENSION_LABEL[data.center.dimension]}
                </div>
                <div
                  className="font-bold text-xl mt-1 text-[var(--ft-text)] truncate"
                  title={data.center.groupLabel}
                >
                  {data.center.groupLabel}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 text-[13px] ft-mono shrink-0">
                <div className="text-[var(--ft-source)]">
                  +{formatBtc(data.center.totalInSats, true)} in
                </div>
                <div className="text-[var(--ft-dest)]">
                  -{formatBtc(data.center.totalOutSats, true)} out
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Nodes */}
        {laid.map(({ node, y }) => {
          const isHop2Plus = node.hopDepth > 1;
          const leftOffset = SPINE_LEFT + 120 - (node.hopDepth - 1) * 28;
          const color = roleColor(node.direction, node.isUnknown);
          return (
            <div
              key={node.id}
              className="absolute flex items-start z-10"
              style={{ top: y, left: leftOffset }}
            >
              <div
                className="absolute top-7 z-0"
                style={{
                  left: `-${leftOffset - SPINE_LEFT}px`,
                  width: `${leftOffset - SPINE_LEFT}px`,
                  height: "2px",
                  borderTop: isHop2Plus
                    ? "2px dashed var(--ft-border-strong)"
                    : "none",
                  backgroundColor: isHop2Plus
                    ? "transparent"
                    : "var(--ft-border-strong)",
                }}
              />
              {!isHop2Plus && (
                <div
                  className="absolute top-6 w-3 h-3 rounded-full border-2 border-[var(--ft-bg)]"
                  style={{
                    left: `-${leftOffset - SPINE_LEFT + 6}px`,
                    backgroundColor: color,
                  }}
                />
              )}
              <NodeCard
                node={node}
                isExpanded={!!expanded[node.id]}
                onToggle={() => toggle(node.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
