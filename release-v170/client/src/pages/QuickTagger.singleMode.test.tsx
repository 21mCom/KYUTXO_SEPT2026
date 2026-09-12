// @vitest-environment jsdom
//
// Coverage for the Quick Tagger single-mode behavior (Task: "Quick Tagger:
// single-mode input"). The page now operates in exactly one mode at a time
// (Addresses OR Transactions):
//   • mixed pastes flag entries of the non-active type as mismatched (with a
//     switch-mode hint) instead of silently blending them,
//   • the metadata step only shows mode-appropriate fields (address-only
//     fields hidden in Transactions mode and vice-versa; address-centric
//     shared fields like Private Key Status / Wallet Name hidden in
//     Transactions mode),
//   • applying metadata only ever creates records of the active mode's type.
//
// We back the real Dexie database with fake-indexeddb and render the real page
// through the shared provider stack.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

// ScrollPositionIndicator (review-step table) reads matchMedia, absent in jsdom.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import { renderWithProviders } from "@/test/testProviders";
import { clearAllRecords, getAllRecords } from "@/lib/data/record-crud";
import QuickTagger from "./QuickTagger";

const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TXID =
  "a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d";

async function pasteAndParse(text: string) {
  fireEvent.change(screen.getByTestId("textarea-paste-input"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByTestId("button-parse-entries"));
  await waitFor(() => {
    expect(screen.getByTestId("button-continue-to-metadata")).toBeTruthy();
  });
}

describe("QuickTagger single-mode input", () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  afterEach(() => {
    cleanup();
  });

  it("flags non-matching entries as mismatched in Addresses mode and shows address-only metadata fields", async () => {
    renderWithProviders(<QuickTagger />);

    await pasteAndParse(`${ADDRESS}\n${TXID}`);

    // Mismatched TXID is flagged with a switch-mode hint, not silently mixed in
    const alert = screen.getByTestId("alert-mismatched-entries");
    expect(alert.textContent).toContain(
      "1 transaction ID ignored — switch to Transactions mode",
    );

    fireEvent.click(screen.getByTestId("button-continue-to-metadata"));

    await waitFor(() => {
      expect(screen.getByTestId("select-address-importance")).toBeTruthy();
    });
    // Address-only fields present, transaction-only fields hidden
    expect(screen.getByTestId("select-counterparty-type")).toBeTruthy();
    expect(screen.queryByTestId("select-flow-type")).toBeNull();
    expect(screen.queryByTestId("select-acquisition-method")).toBeNull();
    expect(screen.queryByTestId("select-disposition-type")).toBeNull();
    expect(screen.queryByTestId("input-cost-basis")).toBeNull();
    // Address-centric shared fields still visible in Addresses mode
    expect(screen.getByTestId("select-private-key-status")).toBeTruthy();
    expect(screen.getByTestId("select-wallet-name")).toBeTruthy();
  });

  it("switching modes re-validates entries and shows transaction-only metadata fields", async () => {
    renderWithProviders(<QuickTagger />);

    await pasteAndParse(`${ADDRESS}\n${TXID}`);

    // Switch from the review step's mismatch hint
    fireEvent.click(screen.getByTestId("button-switch-mode"));

    await waitFor(() => {
      expect(
        screen.getByTestId("alert-mismatched-entries").textContent,
      ).toContain("1 address ignored — switch to Addresses mode");
    });

    fireEvent.click(screen.getByTestId("button-continue-to-metadata"));

    await waitFor(() => {
      expect(screen.getByTestId("select-flow-type")).toBeTruthy();
    });
    expect(screen.getByTestId("select-acquisition-method")).toBeTruthy();
    expect(screen.getByTestId("select-disposition-type")).toBeTruthy();
    expect(screen.getByTestId("input-cost-basis")).toBeTruthy();
    // Address-only fields hidden
    expect(screen.queryByTestId("select-address-importance")).toBeNull();
    expect(screen.queryByTestId("select-counterparty-type")).toBeNull();
    // Address-centric shared fields hidden in Transactions mode
    expect(screen.queryByTestId("select-private-key-status")).toBeNull();
    expect(screen.queryByTestId("select-wallet-name")).toBeNull();
    expect(screen.queryByTestId("select-seed-name")).toBeNull();
    expect(screen.queryByTestId("select-wallet-software")).toBeNull();
    // Shared fields that apply to transactions stay visible
    expect(screen.getByTestId("select-owner")).toBeTruthy();
    expect(screen.getByTestId("input-label")).toBeTruthy();
    expect(screen.getByTestId("textarea-notes")).toBeTruthy();
  });

  it("apply only creates records of the active mode's type from a mixed paste", async () => {
    renderWithProviders(<QuickTagger />);

    // Choose Transactions mode up front on the paste step
    fireEvent.click(screen.getByTestId("button-mode-transaction"));

    await pasteAndParse(`${ADDRESS}\n${TXID}`);
    fireEvent.click(screen.getByTestId("button-continue-to-metadata"));

    await waitFor(() => {
      expect(screen.getByTestId("button-apply-metadata")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("input-label"), {
      target: { value: "tagged tx" },
    });
    fireEvent.click(screen.getByTestId("button-apply-metadata"));

    await waitFor(() => {
      expect(screen.getByTestId("button-tag-more")).toBeTruthy();
    });

    const records = await getAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("transaction");
    expect(records[0].inputString).toBe(TXID);
    expect(records[0].label).toBe("tagged tx");
    // Never writes address-only or address-centric fields
    expect(records[0].counterpartyType).toBeUndefined();
    expect(records[0].privateKeyStatus).toBeUndefined();
    expect(records[0].walletName).toBeUndefined();
  });
});
