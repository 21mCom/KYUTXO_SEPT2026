// @vitest-environment jsdom
//
// Contrast coverage for the Bitcoin Flow Visualizer's Sankey diagram. It draws
// coloured node rectangles for each address in the flow: owned addresses get a
// green mark, unowned inputs/outputs use --chart-1/--chart-2, the centre
// address uses --primary. The overlaid text labels (amounts, address labels)
// sit beside the marks on the SVG surface, not on the coloured fills, so the
// contrast risk here is graphical: a fixed colour constant that falls below 3:1
// when the theme flips. The "owned" green used to be hard-coded hsl(142 …%)
// literals tuned for dark mode (and illegible in light mode); they are now
// theme-aware tokens (--graph-owned / --graph-owned-border).
//
// This test renders the REAL Sankey, reads the fill/stroke each node mark uses,
// resolves those `hsl(var(--token))` expressions against the REAL index.css
// values for both themes, and asserts every coloured mark clears 3:1 against
// the graph surface in BOTH light and dark mode. Reading the palette from
// index.css means a future retune of --graph-owned*, --chart-* , --muted or
// --background re-evaluates here instead of silently making a mark illegible.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { FlowData } from "@/hooks/use-flow-data";

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

// The Sankey SVG sits on a `bg-muted/20` surface, same as the network graph.
function graphSurface(theme: ThemeName): [number, number, number] {
  return blend(token(BLOCKS[theme], "muted"), 0.2, token(BLOCKS[theme], "background"));
}

function resolveColor(expr: string, theme: ThemeName): [number, number, number] {
  const m = /hsl\(\s*var\(\s*--([\w-]+)\s*\)\s*\)/.exec(expr);
  if (!m) {
    throw new Error(
      `flow visualizer emitted a non-theme-aware colour "${expr}" — expected hsl(var(--token))`,
    );
  }
  return token(BLOCKS[theme], m[1]);
}

const GRAPHICAL_MIN = 3; // non-text graphical marks (WCAG 1.4.11)

// ---------------------------------------------------------------------------
// A flow with an owned input + owned output (green marks), an unowned pair
// (chart-1/chart-2) and the selected centre node (primary).
// ---------------------------------------------------------------------------

const flowData: FlowData = {
  nodes: [
    { id: "in-owned", address: "bc1qownedinputxxxxxxxxxxxxxxxxxxxxxxxx0", amount: 0.5, timestamp: "2024-01-01", hop: -1, type: "input", isLabeled: true },
    { id: "in-ext", address: "bc1qextinputxxxxxxxxxxxxxxxxxxxxxxxxxx1", amount: 0.3, timestamp: "2024-01-01", hop: -1, type: "input", isLabeled: false },
    { id: "sel-1", address: "bc1qselectedxxxxxxxxxxxxxxxxxxxxxxxxxxx2", amount: 1, timestamp: "2024-01-02", hop: 0, type: "selected", isLabeled: true },
    { id: "out-owned", address: "bc1qownedoutputxxxxxxxxxxxxxxxxxxxxxxx3", amount: 0.4, timestamp: "2024-01-03", hop: 1, type: "output", isLabeled: true },
    { id: "out-ext", address: "bc1qextoutputxxxxxxxxxxxxxxxxxxxxxxxxx4", amount: 0.35, timestamp: "2024-01-03", hop: 1, type: "output", isLabeled: false },
  ],
  links: [],
  stats: { inputCount: 2, outputCount: 2, totalInputValue: 0.8, totalOutputValue: 0.75 },
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

vi.mock("@/lib/database", () => ({ db: {} }));
vi.mock("@/lib/dataFacade", () => ({ getParticipantsByAddresses: vi.fn() }));
vi.mock("@/hooks/use-flow-data", () => ({
  useFlowData: () => ({ flowData, isLoading: false, error: null, dataSource: "local", fetchFlow: vi.fn() }),
}));
vi.mock("@/hooks/use-page-shortcuts", () => ({ usePageShortcuts: vi.fn() }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [], isLoading: false }) }));
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: [], isLoading: false }) }));
vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [], isLoading: false }) }));
vi.mock("@/components/HopPathExplorer", () => ({ HopPathExplorer: () => null }));
vi.mock("@/components/RecordDetailPanel", () => ({ RecordDetailPanel: () => null }));
vi.mock("@/components/ScrollPositionIndicator", () => ({ ScrollPositionIndicator: () => null }));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreviewByAddress: vi.fn(() => Promise.resolve()) }),
}));

import BitcoinFlowVisualizer from "./BitcoinFlowVisualizer";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function getSankeySvg(): SVGSVGElement {
  // The Sankey tab is the default; its node testids identify the diagram.
  const node = screen.getByTestId("sankey-input-in-owned");
  const svg = node.closest("svg");
  if (!svg) throw new Error("Sankey SVG did not render");
  return svg as unknown as SVGSVGElement;
}

describe("Flow visualizer Sankey colours — legible in both themes", () => {
  it("every coloured node mark clears 3:1 against the graph surface (both themes)", () => {
    render(<BitcoinFlowVisualizer />);
    const svg = getSankeySvg();

    // Collect fills and strokes that resolve to a theme token (skip gradient
    // url(#…) fills and the "transparent"/"none" strokes).
    const exprs: string[] = [];
    for (const el of Array.from(svg.querySelectorAll("rect, circle, line"))) {
      for (const attr of ["fill", "stroke"] as const) {
        const v = el.getAttribute(attr);
        if (v && /hsl\(\s*var\(/.test(v)) exprs.push(v);
      }
    }
    expect(exprs.length).toBeGreaterThan(0);
    // The owned green tokens must be present (proves the regression path renders).
    expect(exprs.some((e) => e.includes("--graph-owned"))).toBe(true);

    for (const expr of Array.from(new Set(exprs))) {
      for (const theme of ["light", "dark"] as ThemeName[]) {
        const ratio = contrastRatio(resolveColor(expr, theme), graphSurface(theme));
        expect(
          ratio,
          `${theme}: mark ${expr} only reached ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(GRAPHICAL_MIN);
      }
    }
  });

  it("the owned marks stay theme-aware (driven by graph tokens, never hard-coded hsl/hex)", () => {
    render(<BitcoinFlowVisualizer />);
    const svg = getSankeySvg();

    const all = Array.from(svg.querySelectorAll("rect, circle, line, stop"));
    for (const el of all) {
      for (const attr of ["fill", "stroke", "stop-color"] as const) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        // No fixed green literal and no raw hex should survive on a mark.
        expect(v, `mark ${attr}="${v}" is a hard-coded hsl literal`).not.toMatch(/hsl\(\s*\d/);
        expect(v, `mark ${attr}="${v}" is a hard-coded hex`).not.toMatch(/#[0-9a-f]{3,6}/i);
      }
    }
  });
});
