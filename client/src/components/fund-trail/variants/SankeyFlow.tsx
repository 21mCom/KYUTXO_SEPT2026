import { useMemo } from "react";
import { Wallet, User, KeyRound } from "lucide-react";
import type { FundTrailViewData, SampleNode } from "../view-data";
import { formatBtc, formatDateShort } from "../view-data";
import { HopCapNotice } from "../shared";
import "../fund-trail-view.css";

const WIDTH = 1300;
const HEIGHT = 600;
const PAD_X = 110;
const PAD_Y = 90;
const INNER_WIDTH = WIDTH - PAD_X * 2;
const INNER_HEIGHT = HEIGHT - PAD_Y * 2;
const NODE_W = 22;
const NODE_GAP = 18;

interface PlacedNode {
  id: string;
  node?: SampleNode;
  label: string;
  isSource: boolean;
  isCenter: boolean;
  isUnknown: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  sats: number;
  color: string;
}

interface Band {
  minX: number;
  maxX: number;
  midY: number;
}

export function SankeyFlow({ data }: { data: FundTrailViewData }) {
  const hasTime = data.timeRange.endSec > data.timeRange.startSec;

  const { nodes, byId, bands, ribbons, centerNode } = useMemo(() => {
    // Scale from the densest *stacked* column, not a single flow. Within a
    // depth column the bars are stacked (summed), so a column with many nodes
    // is the binding constraint — scaling off one big flow would let crowded
    // columns overflow and clip. We fit the tallest summed column into
    // INNER_HEIGHT and reserve space for the inter-node gaps in the column with
    // the most nodes so nothing spills past the viewBox.
    let maxStackSats = Math.max(
      data.center.totalInSats,
      data.center.totalOutSats,
      1,
    );
    let maxNodeCount = 1;
    const measureSide = (list: SampleNode[], maxDepth: number) => {
      for (let depth = 1; depth <= maxDepth; depth++) {
        const depthNodes = list.filter((n) => n.hopDepth === depth);
        if (depthNodes.length === 0) continue;
        const sum = depthNodes.reduce((s, n) => s + n.totalSats, 0);
        maxStackSats = Math.max(maxStackSats, sum);
        maxNodeCount = Math.max(maxNodeCount, depthNodes.length);
      }
    };
    measureSide(data.sources, data.maxSourceDepth);
    measureSide(data.destinations, data.maxDestDepth);
    const gapReserve = Math.min(
      INNER_HEIGHT * 0.6,
      Math.max(0, maxNodeCount - 1) * NODE_GAP,
    );
    const scale = (INNER_HEIGHT - gapReserve) / maxStackSats;

    const centerCol = PAD_X + INNER_WIDTH / 2;

    // X by date when known; otherwise spread by signed hop depth into columns.
    const colXForDepth = (direction: "source" | "dest", depth: number) => {
      const steps = direction === "source" ? data.maxSourceDepth : data.maxDestDepth;
      const span = INNER_WIDTH / 2;
      const unit = span / (steps + 1);
      return direction === "source"
        ? centerCol - depth * unit
        : centerCol + depth * unit;
    };
    const getX = (node: SampleNode) =>
      hasTime
        ? PAD_X + data.timePosition(data.nodeDate(node)) * INNER_WIDTH
        : colXForDepth(node.direction, node.hopDepth);

    const placed: PlacedNode[] = [];

    // Center bar.
    const centerH = Math.max(
      data.center.totalInSats,
      data.center.totalOutSats,
    ) * scale;
    const center: PlacedNode = {
      id: "center",
      label: data.center.groupLabel,
      isSource: false,
      isCenter: true,
      isUnknown: false,
      x: centerCol,
      y: PAD_Y + (INNER_HEIGHT - centerH) / 2,
      w: NODE_W,
      h: Math.max(6, centerH),
      sats: Math.max(data.center.totalInSats, data.center.totalOutSats),
      color: "var(--ft-accent)",
    };
    placed.push(center);

    const placeSide = (list: SampleNode[], isSource: boolean) => {
      const maxDepth = isSource ? data.maxSourceDepth : data.maxDestDepth;
      for (let depth = 1; depth <= maxDepth; depth++) {
        const depthNodes = list
          .filter((n) => n.hopDepth === depth)
          .sort((a, b) => b.totalSats - a.totalSats);
        const totalH =
          depthNodes.reduce((s, n) => s + n.totalSats * scale, 0) +
          Math.max(0, depthNodes.length - 1) * NODE_GAP;
        let startY = Math.max(PAD_Y, PAD_Y + (INNER_HEIGHT - totalH) / 2);
        for (const n of depthNodes) {
          const h = Math.max(6, n.totalSats * scale);
          placed.push({
            id: n.id,
            node: n,
            label: n.groupLabel,
            isSource,
            isCenter: false,
            isUnknown: n.isUnknown,
            x: getX(n),
            y: startY,
            w: NODE_W,
            h,
            sats: n.totalSats,
            color: n.isUnknown
              ? "var(--ft-unknown)"
              : isSource
                ? "var(--ft-source)"
                : "var(--ft-dest)",
          });
          startY += h + NODE_GAP;
        }
      }
    };
    placeSide(data.sources, true);
    placeSide(data.destinations, false);

    const map = new Map<string, PlacedNode>();
    for (const p of placed) map.set(p.id, p);

    // Aggregate band per (direction, depth) for honest deep-hop ribbons.
    const bandMap = new Map<string, Band>();
    const buildBands = (direction: "source" | "dest") => {
      const maxDepth = direction === "source" ? data.maxSourceDepth : data.maxDestDepth;
      for (let depth = 1; depth <= maxDepth; depth++) {
        const group = placed.filter(
          (p) => p.node && p.isSource === (direction === "source") && p.node.hopDepth === depth,
        );
        if (group.length === 0) continue;
        const minX = Math.min(...group.map((p) => p.x));
        const maxX = Math.max(...group.map((p) => p.x));
        const top = Math.min(...group.map((p) => p.y));
        const bottom = Math.max(...group.map((p) => p.y + p.h));
        bandMap.set(`${direction}-${depth}`, {
          minX,
          maxX,
          midY: (top + bottom) / 2,
        });
      }
    };
    buildBands("source");
    buildBands("dest");

    // Ribbons.
    const ribbonList: {
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      thickness: number;
      color: string;
      dashed: boolean;
    }[] = [];

    // hop-1 sources -> center (precise; stacked on the center's inflow edge).
    let centerInY = center.y;
    for (const n of data.sources.filter((s) => s.hopDepth === 1)) {
      const sn = map.get(n.id);
      if (!sn) continue;
      const h = Math.max(2, n.totalSats * scale);
      ribbonList.push({
        id: `r-${n.id}-center`,
        x1: sn.x + sn.w,
        y1: sn.y + sn.h / 2,
        x2: center.x,
        y2: centerInY + h / 2,
        thickness: h,
        color: "var(--ft-source)",
        dashed: false,
      });
      centerInY += h;
    }

    // deeper sources -> aggregate previous-depth band.
    for (const n of data.sources.filter((s) => s.hopDepth > 1)) {
      const sn = map.get(n.id);
      const band = bandMap.get(`source-${n.hopDepth - 1}`);
      if (!sn || !band) continue;
      ribbonList.push({
        id: `r-${n.id}-band`,
        x1: sn.x + sn.w,
        y1: sn.y + sn.h / 2,
        x2: band.minX,
        y2: band.midY,
        thickness: Math.max(2, n.totalSats * scale),
        color: "var(--ft-source)",
        dashed: true,
      });
    }

    // center -> hop-1 destinations (precise).
    let centerOutY = center.y;
    for (const n of data.destinations.filter((d) => d.hopDepth === 1)) {
      const dn = map.get(n.id);
      if (!dn) continue;
      const h = Math.max(2, n.totalSats * scale);
      ribbonList.push({
        id: `r-center-${n.id}`,
        x1: center.x + center.w,
        y1: centerOutY + h / 2,
        x2: dn.x,
        y2: dn.y + dn.h / 2,
        thickness: h,
        color: "var(--ft-dest)",
        dashed: false,
      });
      centerOutY += h;
    }

    // deeper destinations -> aggregate previous-depth band.
    for (const n of data.destinations.filter((d) => d.hopDepth > 1)) {
      const dn = map.get(n.id);
      const band = bandMap.get(`dest-${n.hopDepth - 1}`);
      if (!dn || !band) continue;
      ribbonList.push({
        id: `r-band-${n.id}`,
        x1: band.maxX + NODE_W,
        y1: band.midY,
        x2: dn.x,
        y2: dn.y + dn.h / 2,
        thickness: Math.max(2, n.totalSats * scale),
        color: "var(--ft-dest)",
        dashed: true,
      });
    }

    return {
      nodes: placed,
      byId: map,
      bands: bandMap,
      ribbons: ribbonList,
      centerNode: center,
    };
  }, [data, hasTime]);

  const ticks = useMemo(() => {
    if (!hasTime) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      f,
      sec:
        data.timeRange.startSec +
        f * (data.timeRange.endSec - data.timeRange.startSec),
    }));
  }, [data.timeRange.startSec, data.timeRange.endSec, hasTime]);

  const drawCurve = (x1: number, y1: number, x2: number, y2: number) => {
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="ft-root w-full h-full relative overflow-auto flex flex-col">
      <div className="px-10 pt-6 pb-2 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-[var(--ft-text)]">
            Sankey flow
          </h2>
          <p className="text-[var(--ft-text-2)] text-xs mt-0.5">
            Ribbon thickness is proportional to BTC. Dashed ribbons link deeper
            hops to the aggregate prior hop.
          </p>
        </div>
        <HopCapNotice caps={data.caps} className="max-w-[360px]" />
      </div>

      <div className="flex-1 relative min-h-0 px-4 pb-6">
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {hasTime && (
            <>
              <line
                x1={PAD_X}
                y1={HEIGHT - 36}
                x2={WIDTH - PAD_X}
                y2={HEIGHT - 36}
                stroke="var(--ft-border-strong)"
                strokeWidth={2}
              />
              {ticks.map((t, i) => {
                const tx = PAD_X + t.f * INNER_WIDTH;
                return (
                  <g key={i} transform={`translate(${tx}, ${HEIGHT - 36})`}>
                    <line
                      y1={-5}
                      y2={5}
                      stroke="var(--ft-border-strong)"
                      strokeWidth={2}
                    />
                    <text
                      y={20}
                      fill="var(--ft-text-2)"
                      fontSize={12}
                      textAnchor={
                        i === 0
                          ? "start"
                          : i === ticks.length - 1
                            ? "end"
                            : "middle"
                      }
                      className="ft-mono"
                    >
                      {formatDateShort(t.sec)}
                    </text>
                  </g>
                );
              })}
            </>
          )}

          {ribbons.map((r) => (
            <path
              key={r.id}
              d={drawCurve(r.x1, r.y1, r.x2, r.y2)}
              fill="none"
              stroke={r.color}
              strokeWidth={Math.max(2, r.thickness)}
              strokeOpacity={r.dashed ? 0.18 : 0.32}
              strokeDasharray={r.dashed ? "10 8" : undefined}
            />
          ))}

          {nodes.map((n) => (
            <g
              key={n.id}
              transform={`translate(${n.x}, ${n.y})`}
              data-testid={n.isCenter ? "ft-node-center" : `ft-node-${n.id}`}
            >
              <rect
                width={n.w}
                height={Math.max(4, n.h)}
                fill={n.color}
                rx={4}
              />
              <text
                x={n.isSource ? -10 : n.w + 10}
                y={n.h / 2}
                fill="var(--ft-text)"
                fontSize={13}
                fontWeight={500}
                textAnchor={n.isSource ? "end" : "start"}
                dominantBaseline="middle"
              >
                {n.label}
              </text>
              <text
                x={n.isSource ? -10 : n.w + 10}
                y={n.h / 2 + 16}
                fill={n.color}
                fontSize={11}
                textAnchor={n.isSource ? "end" : "start"}
                className="ft-mono"
              >
                {formatBtc(n.sats, true)} BTC
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
