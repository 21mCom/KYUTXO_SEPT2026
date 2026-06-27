// @vitest-environment jsdom
//
// Coverage for the CoinJoin fund-flow Sankey in the transaction deep-dive
// (Task: "Test the CoinJoin fund-flow diagram in the transaction deep-dive").
//
// The deep-dive (DeepDiveDialog → TransactionDeepDive) renders a CoinJoin
// fund-flow Sankey (container data-testid="container-coinjoin-sankey") only when
// the opened txid is in the coinjoinTxids set. For an ordinary transaction the
// Sankey must be absent. We also unit-test buildSankey to confirm each input's
// value is distributed across the outputs proportionally.
//
// We render the real DeepDiveDialog (controlled-open, no trigger) so the whole
// auto-analyse → setData → Sankey render path runs. The two data loaders it
// calls are mocked (no IndexedDB) and the Boltzmann Worker is stubbed since the
// Sankey itself doesn't depend on the worker result.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionByTxid: vi.fn(),
}));
vi.mock("@/lib/data/record-queries", () => ({
  getParticipantsByTxids: vi.fn(),
}));

import { getTransactionByTxid } from "@/lib/data/transaction-crud";
import { getParticipantsByTxids } from "@/lib/data/record-queries";
import {
  DeepDiveDialog,
  buildSankey,
  contrastRatio,
  SANKEY_NODE_FILL,
  SANKEY_LINK_STROKE,
} from "./PrivacyAudit";

const TXID = "a".repeat(64);

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

const mockedGetTx = vi.mocked(getTransactionByTxid);
const mockedGetParticipants = vi.mocked(getParticipantsByTxids);

// A CoinJoin-shaped tx: two inputs, two equal-sized outputs.
function coinjoinParticipants() {
  return [
    { txid: TXID, role: "input", address: "bc1qinput1", amount: 100_000, vout: 0 },
    { txid: TXID, role: "input", address: "bc1qinput2", amount: 100_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qout1", amount: 99_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qout2", amount: 99_000, vout: 1 },
  ] as any;
}

function renderDialog(coinjoinTxids: Set<string>) {
  return render(
    <DeepDiveDialog
      txid={TXID}
      coinjoinTxids={coinjoinTxids}
      open
      showTrigger={false}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  mockedGetTx.mockResolvedValue({ txid: TXID, fee: 2_000 } as any);
  mockedGetParticipants.mockResolvedValue(coinjoinParticipants());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DeepDiveDialog CoinJoin fund-flow Sankey", () => {
  it("renders the Sankey when the txid is a CoinJoin", async () => {
    renderDialog(new Set<string>([TXID]));

    // The dialog opens and auto-analyses the txid.
    expect(await screen.findByTestId("dialog-deep-dive")).toBeTruthy();

    // The fund-flow Sankey appears for a CoinJoin transaction.
    expect(await screen.findByTestId("container-coinjoin-sankey")).toBeTruthy();
  });

  it("does not render the Sankey for an ordinary (non-CoinJoin) transaction", async () => {
    // Same participant data, but the txid is NOT flagged as a CoinJoin.
    renderDialog(new Set<string>());

    expect(await screen.findByTestId("dialog-deep-dive")).toBeTruthy();

    // Wait until the analysis has loaded participant data (worker posted to),
    // then confirm the Sankey is still absent.
    await waitFor(() => {
      expect(mockedGetParticipants).toHaveBeenCalled();
    });
    // Give any post-load render a chance to flush, then assert absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("container-coinjoin-sankey")).toBeNull();
  });
});

describe("buildSankey", () => {
  it("distributes each input proportionally across the outputs", () => {
    const inputs = [
      { txid: TXID, role: "input", address: "in1", amount: 100_000, vout: 0 },
      { txid: TXID, role: "input", address: "in2", amount: 300_000, vout: 0 },
    ] as any;
    const outputs = [
      { txid: TXID, role: "output", address: "out1", amount: 200_000, vout: 0 },
      { txid: TXID, role: "output", address: "out2", amount: 200_000, vout: 1 },
    ] as any;

    const { nodes, links } = buildSankey(inputs, outputs);

    // 2 inputs + 2 outputs = 4 nodes; outputs are indexed after the inputs.
    expect(nodes).toHaveLength(4);
    // Fully connected: every input links to every output (all values > 0).
    expect(links).toHaveLength(4);

    const totalIn = 400_000;
    // input i (si), output t (target = inputs.length + ti)
    const find = (si: number, ti: number) =>
      links.find((l) => l.source === si && l.target === inputs.length + ti);

    // in1 (100k / 400k = 25%) feeds 25% of each 200k output = 50k each.
    expect(find(0, 0)!.value).toBe(Math.round((100_000 / totalIn) * 200_000));
    expect(find(0, 0)!.value).toBe(50_000);
    expect(find(0, 1)!.value).toBe(50_000);
    // in2 (300k / 400k = 75%) feeds 75% of each 200k output = 150k each.
    expect(find(1, 0)!.value).toBe(150_000);
    expect(find(1, 1)!.value).toBe(150_000);

    // Each output receives its full value back across all input links.
    const out0Total = links
      .filter((l) => l.target === inputs.length + 0)
      .reduce((s, l) => s + l.value, 0);
    expect(out0Total).toBe(200_000);
  });

  it("omits zero-value links (skips empty inputs/outputs)", () => {
    const inputs = [
      { txid: TXID, role: "input", address: "in1", amount: 100_000, vout: 0 },
    ] as any;
    const outputs = [
      { txid: TXID, role: "output", address: "out1", amount: 100_000, vout: 0 },
      { txid: TXID, role: "output", address: "out2", amount: 0, vout: 1 },
    ] as any;

    const { links } = buildSankey(inputs, outputs);

    // The zero-amount output produces a zero-value link, which is dropped.
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source: 0, target: 1, value: 100_000 });
  });
});

// ─── Legibility / contrast ────────────────────────────────────────────────────
//
// The Sankey draws nodes as filled rectangles and links as flow paths; it
// renders no overlaid text labels (recharts' default node item is a bare
// Rectangle — values only appear in the hover Tooltip, which carries its own
// theme-aware surface). The risk is the same one that bit the heatmap: a fixed
// node/link colour that becomes invisible against the page background in one
// theme. Recharts' defaults fail WCAG AA — the node fill (#0088fe @ 0.8) only
// reaches ~2.8:1 in light mode and the link stroke (#333 @ 0.2) is near
// invisible — so the component drives BOTH colours from theme-aware tokens at
// full opacity (--chart-2 for nodes, --muted-foreground for links). These tests
// read the actual token values out of client/src/index.css (so a future palette
// change is genuinely caught, not silently passed by duplicated literals) and
// confirm both the node AND the link clear WCAG AA (4.5:1) against the page
// background in light and dark mode.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Convert an "H S% L%" token triple (as stored in index.css) to [r, g, b].
function hslTriplet(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}

// Read the real token values straight from index.css so these contrast checks
// track the actual palette — if someone retunes --chart-2 / --muted-foreground /
// --background, the assertions below re-evaluate against the new values rather
// than a stale copy.
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

// WCAG AA minimum contrast for normal-size content.
const WCAG_AA = 4.5;

const lightBlock = cssBlock(":root");
const darkBlock = cssBlock(".dark");

// Effective on-screen colours: both node (fillOpacity 1) and link
// (strokeOpacity 1) render their token value with no alpha, so the rendered
// colour equals the resolved token and we can compare it directly to the
// background.
const themes = {
  light: {
    background: token(lightBlock, "background"),
    node: token(lightBlock, "chart-2"),
    link: token(lightBlock, "muted-foreground"),
  },
  dark: {
    background: token(darkBlock, "background"),
    node: token(darkBlock, "chart-2"),
    link: token(darkBlock, "muted-foreground"),
  },
};

describe("CoinJoin Sankey colours — theme-aware and legible in both themes", () => {
  it("drives both node and link colours from theme-aware tokens (no fixed hex)", () => {
    // Node fill is --chart-2 (flips lightness between themes); link stroke is
    // --muted-foreground. Neither is a hard-coded hex colour, so both adapt
    // automatically to light/dark mode.
    expect(SANKEY_NODE_FILL).toContain("var(--chart-2)");
    expect(SANKEY_LINK_STROKE).toContain("var(--muted-foreground)");
    expect(SANKEY_NODE_FILL).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(SANKEY_LINK_STROKE).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`node fill clears WCAG AA against the background in ${name} mode`, () => {
      const ratio = contrastRatio(t.node, t.background);
      expect(
        ratio,
        `${name} node only reached ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it(`link stroke clears WCAG AA against the background in ${name} mode`, () => {
      const ratio = contrastRatio(t.link, t.background);
      expect(
        ratio,
        `${name} link only reached ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA);
    });
  }

  it("renders no overlaid text labels inside the Sankey (so there is no label-vs-fill text to misread)", async () => {
    renderDialog(new Set<string>([TXID]));
    const container = await screen.findByTestId("container-coinjoin-sankey");

    // Recharts' default node item is a bare Rectangle: the only <text> the chart
    // can emit lives in the hover Tooltip, which isn't shown until hover. With no
    // overlaid labels, there is no fixed label colour that could fall below
    // contrast against the node fill — the legibility risk is the node/link
    // colours alone, covered above. (Supplemental to the contrast checks.)
    expect(container.querySelectorAll("text")).toHaveLength(0);
  });
});
