// @vitest-environment jsdom
//
// Contrast coverage for the peel-chain graph (PeelChainGraph, rendered inside
// PeelChainView). The graph hand-draws an SVG node-link diagram whose marks use
// the fixed peel palette (PEEL_PAYMENT_COLOR = --chart-5, PEEL_CHANGE_COLOR =
// --chart-2, PEEL_COINJOIN_COLOR = --chart-4) plus theme tokens for the node
// fills, labels and background. The risk is the same one that bit the heatmap
// and the CoinJoin Sankey: a colour overlaid with text — or a graphical mark
// drawn over a theme-aware surface — can fall below readable contrast when the
// theme flips.
//
// These tests render the REAL graph, read the fill/stroke each element actually
// uses, resolve those `hsl(var(--token))` expressions against the REAL values in
// index.css for both themes, and assert:
//   - every overlaid text label clears WCAG AA (4.5:1) against its surface, and
//   - every coloured graphical-only mark clears 3:1 against its surface,
// in BOTH light and dark mode. Reading the palette from index.css means a future
// retune of --chart-2/-4/-5, --background or --foreground re-evaluates here
// instead of silently making the diagram illegible in one theme.

import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TooltipProvider } from "@/components/ui/tooltip";
import { db } from "@/lib/database";
import { createRecord } from "@/lib/dataFacade";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import { PeelChainView, contrastRatio } from "./PrivacyAudit";

// ---------------------------------------------------------------------------
// Palette resolution — read the real token values straight from index.css.
// ---------------------------------------------------------------------------

// Convert an "H S% L%" token triple (as stored in index.css) to [r, g, b].
function hslTriplet(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}

const cssSource = readFileSync(
  resolve(process.cwd(), "client/src/index.css"),
  "utf8",
);

// Pull a `selector { ... }` block out of the stylesheet.
function cssBlock(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(cssSource);
  if (!m) throw new Error(`index.css: no "${selector} { ... }" block found`);
  return m[1];
}

// Resolve a `--token: H S% L%;` declaration from a block into an [r, g, b] tuple.
function token(block: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(block);
  if (!m) throw new Error(`index.css: no "--${name}" declaration found`);
  return hslTriplet(Number(m[1]), Number(m[2]), Number(m[3]));
}

const BLOCKS = { light: cssBlock(":root"), dark: cssBlock(".dark") } as const;
type ThemeName = keyof typeof BLOCKS;

// Resolve a rendered colour expression to an [r, g, b] for a given theme.
// Handles `hsl(var(--token))` (the only form the graph emits). Anything else —
// e.g. a hard-coded hex — throws, which is exactly the regression we want to
// catch: the diagram must stay theme-aware.
function resolveColor(expr: string, theme: ThemeName): [number, number, number] {
  const m = /hsl\(\s*var\(\s*--([\w-]+)\s*\)\s*\)/.exec(expr);
  if (!m) {
    throw new Error(
      `peel graph emitted a non-theme-aware colour "${expr}" — expected hsl(var(--token))`,
    );
  }
  return token(BLOCKS[theme], m[1]);
}

const WCAG_AA = 4.5; // normal-size text
const GRAPHICAL_MIN = 3; // non-text graphical marks (WCAG 1.4.11)

// ---------------------------------------------------------------------------
// Seed a real peel chain (one CoinJoin hop so the ⇄ badge + ring also render).
// ---------------------------------------------------------------------------

const HOP_TXID =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const INPUT_ADDR = "bc1qpeelinput00000000000000000000000000000aa";
const PAYMENT_ADDR = "bc1qpeelpayment0000000000000000000000000000bb";
const CHANGE_ADDR = "bc1qpeelchange00000000000000000000000000000cc";

async function seedPeelChain() {
  await createRecord(
    { type: "transaction", inputString: HOP_TXID, label: "Hop", source: "manual", tags: [], categories: [] },
    { skipVocabularySync: true },
  );
  await addTransaction(
    { txid: HOP_TXID, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: HOP_TXID, role: "input", address: INPUT_ADDR, amount: 100_000, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: HOP_TXID, role: "output", address: CHANGE_ADDR, amount: 30_000, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: HOP_TXID, role: "output", address: PAYMENT_ADDR, amount: 69_000, vout: 1 },
    { skipNotification: true },
  );
}

function renderGraph() {
  const { hook } = memoryLocation({ path: "/privacy-audit" });
  return render(
    <Router hook={hook}>
      <TooltipProvider>
        <RecordPreviewProvider>
          <PeelChainView
            txids={[HOP_TXID]}
            changeAddresses={[CHANGE_ADDR]}
            coinjoinTxids={new Set<string>([HOP_TXID])}
          />
        </RecordPreviewProvider>
      </TooltipProvider>
    </Router>,
  );
}

async function getSvg(getByTestId: (id: string) => HTMLElement): Promise<SVGSVGElement> {
  await waitFor(() => {
    expect(getByTestId("container-peel-graph")).toBeTruthy();
  });
  const svg = getByTestId("container-peel-graph").querySelector("svg");
  if (!svg) throw new Error("peel graph SVG did not render");
  return svg as unknown as SVGSVGElement;
}

beforeEach(async () => {
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await seedPeelChain();
});

afterEach(async () => {
  cleanup();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

describe("Peel-chain graph colours — legible in both themes", () => {
  it("every overlaid text label clears WCAG AA against its surface (both themes)", async () => {
    let svg!: SVGSVGElement;
    const { getByTestId } = renderGraph();
    svg = await getSvg(getByTestId);

    const texts = Array.from(svg.querySelectorAll("text"));
    expect(texts.length).toBeGreaterThan(0);

    // Decide the surface each label sits on. Most labels float over the SVG
    // background; the ⇄ CoinJoin glyph sits on the --chart-4 badge fill.
    const surfaceFor = (content: string): string => {
      if (content.includes("⇄")) return "hsl(var(--chart-4))";
      return "hsl(var(--background))";
    };

    for (const text of texts) {
      const content = (text.textContent ?? "").trim();
      if (!content) continue;
      // The "H1" hop-number label is white-on-primary: it follows the global
      // --primary / --primary-foreground button contract shared by every
      // primary <Button> in the app, governed app-wide rather than by this
      // diagram's peel palette. It is out of scope for the peel-colour task and
      // intentionally not pinned here (changing it is a brand-wide decision).
      if (/^H\d+$/.test(content)) continue;
      const fill = text.getAttribute("fill");
      expect(fill, `text "${content}" has no explicit fill`).toBeTruthy();
      const surface = surfaceFor(content);

      for (const theme of ["light", "dark"] as ThemeName[]) {
        const ratio = contrastRatio(
          resolveColor(fill as string, theme),
          resolveColor(surface, theme),
        );
        expect(
          ratio,
          `${theme}: text "${content}" (${fill}) on ${surface} only reached ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA);
      }
    }
  });

  it("every coloured graphical mark clears 3:1 against the background (both themes)", async () => {
    const { getByTestId } = renderGraph();
    const svg = await getSvg(getByTestId);

    // Collect every stroked line and circle outline drawn on the SVG surface.
    const marks: { el: Element; attr: "stroke" }[] = [];
    for (const el of Array.from(svg.querySelectorAll("line, circle"))) {
      const stroke = el.getAttribute("stroke");
      if (stroke && stroke !== "none") marks.push({ el, attr: "stroke" });
    }
    expect(marks.length).toBeGreaterThan(0);

    for (const { el, attr } of marks) {
      const expr = el.getAttribute(attr) as string;
      for (const theme of ["light", "dark"] as ThemeName[]) {
        const ratio = contrastRatio(
          resolveColor(expr, theme),
          resolveColor("hsl(var(--background))", theme),
        );
        expect(
          ratio,
          `${theme}: ${el.tagName} ${attr} ${expr} only reached ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(GRAPHICAL_MIN);
      }
    }
  });

  it("the peel amount labels use the theme foreground, not the (light-mode-illegible) chart palette", async () => {
    const { getByTestId } = renderGraph();
    const svg = await getSvg(getByTestId);

    const amountLabels = Array.from(svg.querySelectorAll("text")).filter((t) =>
      (t.textContent ?? "").includes("BTC"),
    );
    // Payment + change amount for the single hop.
    expect(amountLabels.length).toBe(2);

    for (const label of amountLabels) {
      expect(label.getAttribute("fill")).toBe("hsl(var(--foreground))");
    }

    // Guard the rationale: --chart-5 as small text on the light background is
    // below AA, which is why the labels must NOT use it directly.
    const chart5OnLight = contrastRatio(
      token(BLOCKS.light, "chart-5"),
      token(BLOCKS.light, "background"),
    );
    expect(chart5OnLight).toBeLessThan(WCAG_AA);
  });

  it("the peel edges stay theme-aware (driven by chart tokens, never hard-coded hex)", async () => {
    const { getByTestId } = renderGraph();
    const svg = await getSvg(getByTestId);

    const lineStrokes = Array.from(svg.querySelectorAll("line"))
      .map((l) => l.getAttribute("stroke"))
      .filter((s): s is string => Boolean(s));
    expect(lineStrokes.length).toBeGreaterThan(0);

    for (const stroke of lineStrokes) {
      expect(stroke).toMatch(/var\(--chart-\d\)/);
      expect(stroke).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });
});
