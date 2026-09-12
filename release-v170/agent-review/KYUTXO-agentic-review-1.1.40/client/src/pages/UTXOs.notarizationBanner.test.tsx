// @vitest-environment jsdom
//
// Regression coverage for the notarization-intent banner on the UTXOs page.
// The Evidence page hands off a pending notarization via a tab-scoped store
// (sessionStorage + in-tab subscription). The store itself is unit-tested; this
// test locks in the PAGE wiring:
//   - an intent published while the page is already mounted shows the
//     "bar-notarization-intent" banner without a remount (subscription path);
//   - dismiss clears the banner and only the MATCHING intent (nonce-scoped),
//     so a stale dismiss can never wipe a newer handoff;
//   - an intent older than PENDING_NOTARIZATION_TTL_MS never shows the banner
//     on a later visit (and is purged from storage).
//
// The full page is rendered against real Dexie (fake-indexeddb) with an empty
// vault — the banner is independent of UTXO data. The engine freshness gate is
// mocked to fall back to Dexie, and the virtualizer is stubbed (jsdom has no
// layout), matching the sibling UTXOs page tests.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// jsdom has no layout: render every row instead of a measured window.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));

// ScrollPositionIndicator uses window.matchMedia, which jsdom lacks.
vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

// Force the Dexie path: the engine is never available in jsdom.
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: false }),
}));
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountOwnedUtxos: vi.fn().mockResolvedValue(0),
  engineGetHeuristicOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountHeuristicOwnedUtxos: vi.fn().mockResolvedValue(0),
  engineGetOutpointCoverage: vi.fn().mockResolvedValue(null),
}));

import { renderWithProviders } from "@/test/testProviders";
import {
  setPendingNotarization,
  peekPendingNotarization,
  clearPendingNotarization,
  PENDING_NOTARIZATION_TTL_MS,
  type NotarizationIntent,
} from "@/lib/evidence-notarization";
import UTXOs from "./UTXOs";

// Must match STORAGE_KEY in evidence-notarization.ts (used to seed an expired
// intent directly — setPendingNotarization always stamps a fresh createdAt).
const STORAGE_KEY = "kyutxo-pending-notarization";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

describe("UTXOs page notarization banner", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    clearPendingNotarization();
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the banner without a remount when an intent is published while mounted, and dismiss clears it", async () => {
    renderWithProviders(<UTXOs />);

    // Wait for the page to settle; no intent yet -> no banner.
    await waitFor(
      () => {
        expect(screen.getByTestId("text-utxo-count")).toBeTruthy();
      },
      { timeout: 10000 },
    );
    expect(screen.queryByTestId("bar-notarization-intent")).toBeNull();

    // Publish an intent the way the Evidence page does (same tab, page stays
    // mounted — the in-tab subscription must surface it, no remount).
    act(() => {
      setPendingNotarization({
        payloadHex: "ab".repeat(32),
        evidenceId: 1,
        evidenceAttachmentId: 2,
        evidenceTitle: "Contract",
        evidenceFilename: "contract.pdf",
      });
    });

    const banner = await screen.findByTestId("bar-notarization-intent");
    expect(banner.textContent).toContain("contract.pdf");

    // Dismiss clears the banner and the stored intent.
    fireEvent.click(screen.getByTestId("button-dismiss-notarization"));
    await waitFor(() => {
      expect(screen.queryByTestId("bar-notarization-intent")).toBeNull();
    });
    expect(peekPendingNotarization()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("a stale dismiss (old nonce) never wipes a newer handoff; the banner tracks the newest intent", async () => {
    renderWithProviders(<UTXOs />);
    await waitFor(
      () => {
        expect(screen.getByTestId("text-utxo-count")).toBeTruthy();
      },
      { timeout: 10000 },
    );

    let first: NotarizationIntent;
    act(() => {
      first = setPendingNotarization({
        payloadHex: "11".repeat(32),
        evidenceFilename: "first.pdf",
      });
    });
    await screen.findByTestId("bar-notarization-intent");

    // A newer handoff replaces the first; the banner updates in place.
    act(() => {
      setPendingNotarization({
        payloadHex: "22".repeat(32),
        evidenceFilename: "second.pdf",
      });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("bar-notarization-intent").textContent,
      ).toContain("second.pdf");
    });

    // A dismiss scoped to the STALE nonce must be a no-op.
    act(() => {
      clearPendingNotarization(first!.nonce);
    });
    expect(screen.getByTestId("bar-notarization-intent").textContent).toContain(
      "second.pdf",
    );
    expect(peekPendingNotarization()?.evidenceFilename).toBe("second.pdf");

    // Dismissing via the button clears the currently-shown (newer) intent.
    fireEvent.click(screen.getByTestId("button-dismiss-notarization"));
    await waitFor(() => {
      expect(screen.queryByTestId("bar-notarization-intent")).toBeNull();
    });
    expect(peekPendingNotarization()).toBeNull();
  });

  it("never shows the banner for an expired intent, and purges it from storage", async () => {
    // Seed a structurally-valid but expired intent directly (the public setter
    // always stamps Date.now()).
    const expired: NotarizationIntent = {
      payloadHex: "cd".repeat(32),
      nonce: "expired-nonce",
      createdAt: Date.now() - PENDING_NOTARIZATION_TTL_MS - 60_000,
      evidenceFilename: "stale.pdf",
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(expired));

    renderWithProviders(<UTXOs />);
    await waitFor(
      () => {
        expect(screen.getByTestId("text-utxo-count")).toBeTruthy();
      },
      { timeout: 10000 },
    );

    expect(screen.queryByTestId("bar-notarization-intent")).toBeNull();
    // The expired intent was purged on peek, not left to resurrect.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(peekPendingNotarization()).toBeNull();
  });
});
