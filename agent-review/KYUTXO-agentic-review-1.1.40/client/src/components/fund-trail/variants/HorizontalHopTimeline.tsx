import { useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  HelpCircle,
  ChevronDown,
  ChevronRight,
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
import { dimIcon, roleColor, roleSoftColor, ColumnCapBanner } from "../shared";
import "../fund-trail-view.css";

function NodeCard({
  node,
  data,
  isExpanded,
  onToggle,
}: {
  node: SampleNode;
  data: FundTrailViewData;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isSource = node.direction === "source";
  const colorRole = roleColor(node.direction, node.isUnknown);
  const softRole = roleSoftColor(node.direction, node.isUnknown);

  const btcAmount = node.totalSats / 100_000_000;
  const isHeavy = btcAmount >= 1.0;
  const isLight = btcAmount < 0.1;
  const repDate = data.nodeDate(node);
  const hasTime = data.timeRange.endSec > data.timeRange.startSec;

  return (
    <div className="flex flex-col mb-4 last:mb-0 relative ft-fade-in group">
      <div
        className={`rounded-lg border bg-[var(--ft-panel)] hover:bg-[var(--ft-panel-2)] transition-colors cursor-pointer overflow-hidden ${
          isExpanded
            ? "border-[var(--ft-border-strong)] shadow-md"
            : "border-[var(--ft-border)]"
        }`}
        onClick={onToggle}
        data-testid={`ft-node-${node.id}`}
      >
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--ft-text-3)] font-medium uppercase tracking-wider">
              {dimIcon(node.dimension)}
              <span>{DIMENSION_LABEL[node.dimension]}</span>
            </div>
            <div className="text-[var(--ft-text-3)] text-xs flex items-center transition-colors group-hover:text-[var(--ft-text-2)]">
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 mb-1">
            {node.isUnknown && (
              <HelpCircle className="w-4 h-4 text-[var(--ft-unknown)] shrink-0" />
            )}
            <div
              className={`font-medium truncate ${
                node.isUnknown
                  ? "text-[var(--ft-text-2)]"
                  : "text-[var(--ft-text)]"
              } ${isHeavy ? "text-base" : "text-sm"}`}
              title={node.groupLabel}
            >
              {node.groupLabel}
            </div>
          </div>

          <div className="flex items-center justify-between mt-3 gap-2">
            <div className="flex items-center gap-1.5 shrink-0">
              <div
                className="flex items-center justify-center rounded-full w-5 h-5 shrink-0"
                style={{ backgroundColor: softRole, color: colorRole }}
              >
                {isSource ? (
                  <ArrowDownLeft className="w-3 h-3" />
                ) : (
                  <ArrowUpRight className="w-3 h-3" />
                )}
              </div>
              <div
                className={`ft-mono font-medium truncate ${
                  isHeavy
                    ? "text-base"
                    : isLight
                      ? "text-xs text-[var(--ft-text-2)]"
                      : "text-sm"
                }`}
                style={{ color: colorRole }}
              >
                {formatBtc(node.totalSats)}{" "}
                <span className="text-[var(--ft-text-3)] text-[10px] ml-0.5">
                  BTC
                </span>
              </div>
            </div>
            <div className="text-xs text-[var(--ft-text-3)] whitespace-nowrap ml-2">
              {formatDateShort(repDate)}
            </div>
          </div>

          {/* Shared timeline track — every card plots its date on the SAME range. */}
          {hasTime && (
            <div
              className="mt-3 relative h-2 flex items-center"
              title={formatDate(repDate)}
            >
              <div className="absolute left-0 right-0 h-px bg-[var(--ft-border)]"></div>
              <div
                className="absolute w-2 h-2 rounded-full -translate-x-1/2 ring-2 ring-[var(--ft-panel)]"
                style={{
                  left: `${data.timePosition(repDate) * 100}%`,
                  backgroundColor: colorRole,
                }}
              ></div>
            </div>
          )}
        </div>

        {isExpanded && (
          <div className="border-t border-[var(--ft-border)] bg-[var(--ft-bg)] p-3 text-xs flex flex-col gap-2">
            <div className="grid grid-cols-[3fr_3fr_3fr_2fr] gap-2 text-[var(--ft-text-3)] pb-2 border-b border-[var(--ft-border)]/50 text-[10px] uppercase tracking-wider">
              <div>Txid</div>
              <div>Address</div>
              <div className="text-right">Amount</div>
              <div className="text-right">Date</div>
            </div>
            {node.details.map((d, i) => (
              <div
                key={i}
                className="grid grid-cols-[3fr_3fr_3fr_2fr] gap-2 items-center ft-mono text-[var(--ft-text-2)] py-1"
              >
                <div className="text-[var(--ft-text)] truncate" title={d.txid}>
                  {shortTxid(d.txid)}
                </div>
                <div
                  className="text-[var(--ft-text-3)] truncate"
                  title={d.address}
                >
                  {shortAddr(d.address)}
                </div>
                <div
                  className="text-right truncate"
                  style={{ color: colorRole }}
                >
                  {formatBtc(d.amount, true)}
                </div>
                <div className="text-right text-[var(--ft-text-3)] truncate">
                  {formatDateShort(d.blockTime)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HopColumn({
  title,
  accent,
  nodes,
  data,
  expandedId,
  setExpandedId,
  capDepth,
  capDirection,
}: {
  title: string;
  accent?: boolean;
  nodes: SampleNode[];
  data: FundTrailViewData;
  expandedId: string;
  setExpandedId: (id: string) => void;
  capDepth: number;
  capDirection: "source" | "dest";
}) {
  const cap = data.capForHop(capDepth, capDirection);
  return (
    <div className="flex flex-col h-full min-w-[240px] flex-1">
      <div
        className={`text-[10px] uppercase tracking-widest mb-4 font-semibold shrink-0 ${
          accent ? "text-[var(--ft-accent)]" : "text-[var(--ft-text-3)]"
        }`}
      >
        {title}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 pr-2 pb-12">
        <ColumnCapBanner cap={cap} />
        {nodes.length === 0 ? (
          <div className="text-xs text-[var(--ft-text-3)] border border-dashed border-[var(--ft-border)] rounded-lg px-3 py-4 text-center">
            No groups
          </div>
        ) : (
          nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              data={data}
              isExpanded={expandedId === n.id}
              onToggle={() => setExpandedId(expandedId === n.id ? "" : n.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function HorizontalHopTimeline({ data }: { data: FundTrailViewData }) {
  const firstId = data.sourcesAtHop(1)[0]?.id ?? data.destinationsAtHop(1)[0]?.id ?? "";
  const [expandedId, setExpandedId] = useState<string>(firstId);

  const hasTime = data.timeRange.endSec > data.timeRange.startSec;
  const rulerTicks = useMemo(() => {
    if (!hasTime) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      f,
      sec:
        data.timeRange.startSec +
        f * (data.timeRange.endSec - data.timeRange.startSec),
    }));
  }, [data.timeRange.startSec, data.timeRange.endSec, hasTime]);

  const sourceDepths: number[] = [];
  for (let d = data.maxSourceDepth; d >= 1; d--) sourceDepths.push(d);
  const destDepths: number[] = [];
  for (let d = 1; d <= data.maxDestDepth; d++) destDepths.push(d);

  return (
    <div className="ft-root h-full w-full flex flex-col overflow-hidden">
      {/* Time Ruler — accurate linear axis; every node plots on this same range */}
      {hasTime ? (
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
      ) : (
        <div className="h-10 border-b border-[var(--ft-border-strong)] flex items-center px-8 text-xs text-[var(--ft-text-3)] shrink-0">
          Transaction dates unavailable for this trail
        </div>
      )}

      <div className="flex-1 flex overflow-auto p-6 gap-6 min-h-0">
        {sourceDepths.map((d) => (
          <HopColumn
            key={`src-${d}`}
            title={`Hop ${d} · Sources`}
            nodes={data.sourcesAtHop(d)}
            data={data}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            capDepth={d}
            capDirection="source"
          />
        ))}

        {/* CENTER */}
        <div className="flex flex-col h-full min-w-[260px] flex-[1.2] relative z-10 px-2 shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-[var(--ft-accent)] mb-4 font-semibold text-center shrink-0">
            Traced Entity
          </div>
          <div className="mt-8 flex flex-col border border-[var(--ft-accent)]/30 rounded-xl bg-[var(--ft-panel)] shadow-xl overflow-hidden shrink-0">
            <div className="p-6 text-center flex flex-col items-center justify-center relative bg-[var(--ft-accent-soft)]">
              <div className="absolute inset-0 bg-gradient-to-b from-[var(--ft-accent)]/10 to-transparent"></div>
              <div className="flex items-center gap-2 text-[10px] text-[var(--ft-accent)]/80 font-medium uppercase tracking-wider mb-4 relative">
                {dimIcon(data.center.dimension)}
                <span>{DIMENSION_LABEL[data.center.dimension]}</span>
              </div>
              <div
                className="text-2xl font-semibold text-[var(--ft-text)] relative mb-8 max-w-full truncate"
                title={data.center.groupLabel}
              >
                {data.center.groupLabel}
              </div>
              <div className="w-full flex justify-between items-center relative text-sm gap-2">
                <div className="flex flex-col items-start">
                  <span className="text-[10px] text-[var(--ft-text-3)] uppercase tracking-wider mb-1.5">
                    Total In
                  </span>
                  <span className="ft-mono text-[var(--ft-source)] font-medium flex items-center gap-1.5 text-base">
                    <ArrowDownLeft className="w-4 h-4" />
                    {formatBtc(data.center.totalInSats)}
                  </span>
                </div>
                <div className="w-px h-10 bg-[var(--ft-border-strong)]"></div>
                <div className="flex flex-col items-end">
                  <span className="text-[10px] text-[var(--ft-text-3)] uppercase tracking-wider mb-1.5">
                    Total Out
                  </span>
                  <span className="ft-mono text-[var(--ft-dest)] font-medium flex items-center gap-1.5 text-base">
                    {formatBtc(data.center.totalOutSats)}
                    <ArrowUpRight className="w-4 h-4" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {destDepths.map((d) => (
          <HopColumn
            key={`dst-${d}`}
            title={`Hop ${d} · Destinations`}
            nodes={data.destinationsAtHop(d)}
            data={data}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            capDepth={d}
            capDirection="dest"
          />
        ))}
      </div>
    </div>
  );
}
