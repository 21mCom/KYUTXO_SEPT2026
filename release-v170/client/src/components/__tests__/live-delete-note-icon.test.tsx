// @vitest-environment jsdom
//
// Durable, rendered-component regression for the SYMMETRIC removal case of the
// live note-icon behaviour. The create path (a record appearing makes the orange
// FileText "note" icon light up live) is covered by live-create-note-icon.test.tsx
// and live-create-note-icon-txid.test.tsx. This file covers the opposite: when a
// record that ALREADY has a note is deleted while its link (TxidLink/AddressLink)
// is on screen, the orange icon must DISAPPEAR live — with NO hover and NO
// reload/remount.
//
// A link renders with its identifier already resolved (the record exists, so the
// hover-metadata cache is warm and the icon is showing). When the user deletes
// that record, deleteRecord invalidates the hover-metadata cache, which — because
// the link is subscribed (i.e. visible) — immediately re-resolves from the DB,
// finds no record, and notifies the subscriber with null, clearing the icon
// within a render. A future change to the metadata-hover cache invalidation or
// the link subscription could silently leave a stale icon showing for a deleted
// record while the create path keeps passing; this test fails if that happens.
//
// This runs the REAL stack end-to-end: the real Dexie database (via
// fake-indexeddb), the real createRecord/deleteRecord CRUD primitives, the real
// metadata-hover cache + subscriber pipeline, and the real TxidLink/AddressLink
// rendered through the shared @/test/testProviders harness (so the Tooltip /
// RecordPreview providers are present). Nothing on the delete -> invalidate ->
// re-resolve -> icon-clears path is stubbed, so the test fails if any link in
// that chain breaks.
import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, cleanup, waitFor, act } from "@testing-library/react";

import { createRecord, deleteRecord, clearAllRecords } from "@/lib/data/record-crud";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import { renderWithProviders } from "@/test/testProviders";
import { TxidLink } from "../TxidLink";
import { AddressLink } from "../AddressLink";

// Distinct from any other suite; first 8 chars drive the link testid.
const TXID = "deadbeefde1e7e000000000000000000000000000000000000000000000000ff";
const ADDRESS = "bc1qdeletenoteicon0000000000000000000000aa";
const txidTriggerId = `link-txid-${TXID.slice(0, 8)}`;
const addressTriggerId = `link-address-${ADDRESS.slice(0, 8)}`;

function hasIndicator(trigger: HTMLElement): boolean {
  return trigger.querySelector("svg.lucide-file-text.text-orange-500") !== null;
}

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  // Drop any module-level cache residue so each identifier genuinely starts
  // from a clean slate.
  invalidateCachedRecord(TXID);
  invalidateCachedRecord(ADDRESS);
});

afterEach(async () => {
  cleanup();
  await clearAllRecords({ skipNotification: true });
  invalidateCachedRecord(TXID);
  invalidateCachedRecord(ADDRESS);
});

describe("live note icon disappears on deleteRecord (no hover, no remount)", () => {
  it("clears the orange note icon on a TxidLink when its record is deleted", async () => {
    renderWithProviders(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(txidTriggerId);
    // No record yet -> no icon.
    expect(hasIndicator(trigger)).toBe(false);

    // Create a record with a note for this txid. The subscribed (visible) link
    // re-resolves live and the orange icon appears with no hover/remount — this
    // establishes the "already HAS a record with a note" state on the SAME node.
    let recordId = 0;
    await act(async () => {
      recordId = await createRecord(
        {
          type: "transaction",
          inputString: TXID,
          label: "Has Note",
          notes: "counterparty note",
          tags: [],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });
    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(txidTriggerId))).toBe(true);
    });

    // The user deletes the record. No hover, no remount — the SAME node must
    // lose the icon on its own.
    await act(async () => {
      await deleteRecord(recordId, { skipNotification: true });
    });

    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(txidTriggerId))).toBe(false);
    });
    // Same DOM node throughout: proves a live subscription update, not a remount.
    expect(screen.getByTestId(txidTriggerId)).toBe(trigger);
  });

  it("clears the orange note icon on an AddressLink when its record is deleted", async () => {
    renderWithProviders(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(addressTriggerId);
    expect(hasIndicator(trigger)).toBe(false);

    let recordId = 0;
    await act(async () => {
      recordId = await createRecord(
        {
          type: "address",
          inputString: ADDRESS,
          label: "Has Note",
          notes: "counterparty note",
          tags: [],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });
    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(addressTriggerId))).toBe(true);
    });

    await act(async () => {
      await deleteRecord(recordId, { skipNotification: true });
    });

    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(addressTriggerId))).toBe(false);
    });
    expect(screen.getByTestId(addressTriggerId)).toBe(trigger);
  });
});
