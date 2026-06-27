// @vitest-environment jsdom
//
// Covers the FindingCard hop-path rendering for proximity findings. The
// privacy-audit engine records a connecting txid for each hop, and FindingCard
// renders those between consecutive addresses as a clickable transaction link
// (TxidLink) plus a deep-dive button (DeepDiveDialog). The engine side is
// unit-tested elsewhere; this verifies the component wiring:
//   - one connecting transaction link AND one deep-dive button per consecutive
//     address pair (i.e. hopPath.length - 1 of each),
//   - each link/button is wired to the correct hop txid,
//   - the fallback where hopTxids is missing/empty still renders the path
//     (the addresses) without throwing and without any tx links/buttons.
//
// TxidLink and ClickableAddress are leaf components with their own IndexedDB /
// context dependencies that are tested independently, so they are stubbed here
// to keep this focused on FindingCard's per-hop rendering logic. The stubs
// preserve the real data-testid shape (link-txid-<first8>) so the assertions
// still prove FindingCard passes the right txid to each link. DeepDiveDialog is
// the real component from PrivacyAudit (when closed it only renders its trigger
// button, data-testid button-deep-dive-<first8>).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PrivacyFinding } from "@/lib/privacy-audit";

vi.mock("@/components/TxidLink", () => ({
  TxidLink: ({ txid }: { txid: string }) => (
    <span data-testid={`link-txid-${txid.slice(0, 8)}`}>{txid}</span>
  ),
}));

vi.mock("@/components/ClickableAddress", () => ({
  ClickableAddress: ({ address }: { address: string }) => (
    <span data-testid={`address-${address}`}>{address}</span>
  ),
}));

import { FindingCard } from "./PrivacyAudit";

// Distinct 64-hex txids whose first 8 chars differ so every link/button gets a
// unique data-testid.
const TX = (n: number) => `${String(n).repeat(8)}${"0".repeat(56)}`;

function proximityFinding(overrides: Partial<PrivacyFinding> = {}): PrivacyFinding {
  return {
    type: "PROXIMITY",
    severity: "MEDIUM",
    description: "Funds sit close to a flagged entity.",
    details: {},
    correction: "Add a hop before spending.",
    txids: [],
    addresses: [],
    ...overrides,
  };
}

function renderCard(finding: PrivacyFinding) {
  return render(
    <TooltipProvider>
      <FindingCard finding={finding} coinjoinTxids={new Set<string>()} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("FindingCard proximity hop-path connecting transactions", () => {
  it("renders one tx link and one deep-dive button per consecutive address pair, wired to the right txid", () => {
    const hopPath = ["bc1qhopA", "bc1qhopB", "bc1qhopC", "bc1qhopD"];
    const hopTxids = [TX(1), TX(2), TX(3)]; // one per pair → 3

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));

    // The hop path lives inside the collapsed details section.
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const container = screen.getByTestId("container-hop-path");

    // Every address in the path is rendered.
    for (const addr of hopPath) {
      expect(within(container).getByTestId(`address-${addr}`)).toBeTruthy();
    }

    // Exactly one connecting tx link AND one deep-dive button per pair.
    const pairs = hopPath.length - 1;
    expect(within(container).getAllByTestId(/^link-txid-/)).toHaveLength(pairs);
    expect(within(container).getAllByTestId(/^button-deep-dive-/)).toHaveLength(pairs);

    // Each is wired to the matching hop txid (in order).
    for (const txid of hopTxids) {
      const first8 = txid.slice(0, 8);
      expect(within(container).getByTestId(`link-txid-${first8}`)).toBeTruthy();
      expect(within(container).getByTestId(`button-deep-dive-${first8}`)).toBeTruthy();
    }
  });

  it("renders fewer links than pairs when some hop txids are absent (sparse array)", () => {
    const hopPath = ["bc1qa", "bc1qb", "bc1qc"];
    // Only the first hop has a connecting txid; the second is undefined.
    const hopTxids = [TX(7)];

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const container = screen.getByTestId("container-hop-path");

    // Path still fully renders.
    for (const addr of hopPath) {
      expect(within(container).getByTestId(`address-${addr}`)).toBeTruthy();
    }

    // Only the hop that has a txid gets a link + deep-dive button.
    expect(within(container).getAllByTestId(/^link-txid-/)).toHaveLength(1);
    expect(within(container).getAllByTestId(/^button-deep-dive-/)).toHaveLength(1);
    expect(within(container).getByTestId(`link-txid-${TX(7).slice(0, 8)}`)).toBeTruthy();
  });

  it("renders the hop path without any tx links when hopTxids is missing entirely", () => {
    const hopPath = ["bc1qx", "bc1qy", "bc1qz"];

    // No hopTxids key at all — fallback arrows are shown instead.
    expect(() =>
      renderCard(proximityFinding({ details: { hopPath } })),
    ).not.toThrow();

    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const container = screen.getByTestId("container-hop-path");

    // Addresses still render…
    for (const addr of hopPath) {
      expect(within(container).getByTestId(`address-${addr}`)).toBeTruthy();
    }

    // …but no connecting transaction links or deep-dive buttons appear.
    expect(within(container).queryAllByTestId(/^link-txid-/)).toHaveLength(0);
    expect(within(container).queryAllByTestId(/^button-deep-dive-/)).toHaveLength(0);
  });

  it("does not render a hop-path section for a single-address path", () => {
    renderCard(proximityFinding({ details: { hopPath: ["bc1qonly"], hopTxids: [] } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    expect(screen.queryByTestId("container-hop-path")).toBeNull();
  });
});
