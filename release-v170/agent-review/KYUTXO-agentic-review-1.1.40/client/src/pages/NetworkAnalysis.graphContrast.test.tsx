// @vitest-environment jsdom
//
// Contrast coverage for the Network Analysis force-directed graph. The graph
// draws one coloured circle per address (filled from the 16-entry categorical
// cluster palette in network-analysis.ts), faint connecting edges, and a text
// label under each visible node. The risk is the same one that bit the heatmap,
// the CoinJoin Sankey and the peel-chain graph: a fixed colour constant can fall
// below readable contrast when the theme flips. The cluster palette used to be
// hard-coded hsl() literals tuned only for one theme; it is now theme-aware CSS
// tokens (--graph-community-0..15) that flip lightness per theme.
//
// These tests render the REAL graph (real getCommunityColor, real d3-force
// layout), read the fill/stroke each element actually uses, resolve those
// `hsl(var(--token))` expressions against the REAL values in index.css for both
// themes, and assert:
//   - every coloured node mark clears 3:1 against the graph surface, and
//   - every overlaid text label clears WCAG AA (4.5:1) against that surface,
// in BOTH light and dark mode. Reading the palette from index.css means a future
// retune of --graph-community-*, --muted or --background re-evaluates here
// instead of silently making a cluster illegible in one theme.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { NetworkGraph } from "@/lib/network-analysis";

import { contrastRatio } from "./PrivacyAudit";

// ---------------------------------------------------------------------------
// Palette resolution — read the real token values straight from index.css.
// ---------------------------------------------------------------------------

function hslTriplet(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}

const cssSource = readFileSync(resolve(process.cwd(), "client/src/index.css"), "utf8");

function cssBlock(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(cssSource);
  if (!m) throw new Error(`index.css: no "${selector} { ... }" block found`);
  return m[1];
}

function token(block: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(block);
  if (!m) throw new Error(`index.css: no "--${name}" declaration found`);
  return hslTriplet(Number(m[1]), Number(m[2]), Number(m[3]));
}

const BLOCKS = { light: cssBlock(":root"), dark: cssBlock(".dark") } as const;
type ThemeName = keyof typeof BLOCKS;

// Alpha-blend a foreground colour over a background colour.
function blend(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

// The graph SVG sits on a `bg-muted/20` surface: muted at 20% over the page
// background. That is what every node/edge/label is actually drawn on top of.
function graphSurface(theme: ThemeName): [number, number, number] {
  return blend(token(BLOCKS[theme], "muted"), 0.2, token(BLOCKS[theme], "background"));
}

// Resolve a rendered colour expression to an [r, g, b] for a given theme.
// Only `hsl(var(--token))` is accepted — a hard-coded hex/hsl literal throws,
// which is exactly the regression we want to catch: the graph must stay
// theme-aware.
function resolveColor(expr: string, theme: ThemeName): [number, number, number] {
  const m = /hsl\(\s*var\(\s*--([\w-]+)\s*\)\s*\)/.exec(expr);
  if (!m) {
    throw new Error(
      `network graph emitted a non-theme-aware colour "${expr}" — expected hsl(var(--token))`,
    );
  }
  return token(BLOCKS[theme], m[1]);
}

const WCAG_AA = 4.5; // normal-size text
const GRAPHICAL_MIN = 3; // non-text graphical marks (WCAG 1.4.11)

// ---------------------------------------------------------------------------
// Build a deterministic 16-cluster graph so every palette colour renders.
// ---------------------------------------------------------------------------

// The node testid is `node-address-${id.slice(0, 8)}`, so the first 8 chars of
// every address must be unique — keep the cluster index right after the prefix.
const ADDRS = Array.from(
  { length: 16 },
  (_, i) => `N${String(i).padStart(2, "0")}clusteraddrxxxxxxxxxxxxxxxxxxxx`,
);

const nodes: NetworkGraph["nodes"] = ADDRS.map((id, i) => ({
  id,
  label: `Cluster ${i}`,
  tags: [],
  degree: 8, // radius = 4 + min(8*0.5,8) + 0.5*6 = 11 → labels render
  community: i,
  centrality: 0.5,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
}));

// Chain the nodes so every node has at least one edge.
const edges: NetworkGraph["edges"] = ADDRS.slice(1).map((id, i) => ({
  source: ADDRS[i],
  target: id,
  weight: 1,
  txids: [`tx${i}`],
}));

const communities = new Map<number, string[]>(ADDRS.map((id, i) => [i, [id]]));

const graph: NetworkGraph = {
  nodes,
  edges,
  layoutEdges: edges,
  communities,
  stats: {
    nodeCount: 16,
    edgeCount: edges.length,
    communityCount: 16,
    largestCommunitySize: 1,
    isolatedNodes: 0,
    avgDegree: 2,
    bridgeNodes: [],
    skippedCliqueTransactions: 0,
    hiddenEdgeCount: 0,
  },
};

const records = ADDRS.map((id, i) => ({
  id: i + 1,
  type: "address",
  inputString: id,
  syncDepth: 0,
}));

vi.mock("@/lib/dataFacade", () => ({
  getRecordsByType: vi.fn(() => Promise.resolve(records)),
  countTransactionParticipants: vi.fn(() => Promise.resolve(0)),
  getAllTransactionParticipants: vi.fn(() => Promise.resolve([])),
  getParticipantsByRecordIds: vi.fn(() => Promise.resolve([])),
  getParticipantsByTxids: vi.fn(() => Promise.resolve([])),
}));

// Keep the REAL getCommunityColor + palette; only stub the heavy graph builder.
vi.mock("@/lib/network-analysis", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/network-analysis")>();
  return {
    ...actual,
    buildNetworkGraph: vi.fn(() => Promise.resolve(graph)),
    MAX_NODES: 3000,
  };
});

vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreviewByAddress: vi.fn(() => Promise.resolve()) }),
}));

import NetworkAnalysis from "./NetworkAnalysis";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderGraph(): Promise<SVGSVGElement> {
  render(<NetworkAnalysis />);
  fireEvent.click(screen.getByTestId("button-run-analysis"));
  await waitFor(
    () => expect(screen.getByTestId(`node-address-${ADDRS[0].slice(0, 8)}`)).toBeTruthy(),
    { timeout: 5000 },
  );
  const svg = screen.getByTestId("svg-network-graph") as unknown as SVGSVGElement;
  return svg;
}

describe("Network graph colours — legible in both themes", () => {
  it("every cluster node mark clears 3:1 against the graph surface (both themes)", async () => {
    const svg = await renderGraph();

    // The coloured cluster marks: circles whose fill is a community token.
    const marks = Array.from(svg.querySelectorAll("circle")).filter((c) => {
      const fill = c.getAttribute("fill");
      return !!fill && /--graph-community-/.test(fill);
    });
    expect(marks.length).toBe(16);

    for (const mark of marks) {
      const fill = mark.getAttribute("fill") as string;
      for (const theme of ["light", "dark"] as ThemeName[]) {
        const ratio = contrastRatio(resolveColor(fill, theme), graphSurface(theme));
        expect(
          ratio,
          `${theme}: node fill ${fill} only reached ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(GRAPHICAL_MIN);
      }
    }
  });

  it("every node text label clears WCAG AA against the graph surface (both themes)", async () => {
    const svg = await renderGraph();

    const texts = Array.from(svg.querySelectorAll("text"));
    expect(texts.length).toBeGreaterThan(0);

    for (const text of texts) {
      const content = (text.textContent ?? "").trim();
      if (!content) continue;
      const fill = text.getAttribute("fill");
      expect(fill, `text "${content}" has no explicit fill`).toBeTruthy();
      for (const theme of ["light", "dark"] as ThemeName[]) {
        const ratio = contrastRatio(resolveColor(fill as string, theme), graphSurface(theme));
        expect(
          ratio,
          `${theme}: label "${content}" (${fill}) only reached ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA);
      }
    }
  });

  it("every edge stroke colour clears 3:1 against the surface at full strength (both themes)", async () => {
    const svg = await renderGraph();

    // Edges are intentionally drawn faint (low stroke-opacity) so they recede
    // behind the nodes; what we guard here is the underlying colour *choice* —
    // a future token retune must not make even a full-strength edge illegible.
    const strokes = Array.from(svg.querySelectorAll("line"))
      .map((l) => l.getAttribute("stroke"))
      .filter((s): s is string => !!s && s !== "none");
    expect(strokes.length).toBeGreaterThan(0);

    for (const stroke of strokes) {
      for (const theme of ["light", "dark"] as ThemeName[]) {
        const ratio = contrastRatio(resolveColor(stroke, theme), graphSurface(theme));
        expect(
          ratio,
          `${theme}: edge stroke ${stroke} only reached ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(GRAPHICAL_MIN);
      }
    }
  });
});
