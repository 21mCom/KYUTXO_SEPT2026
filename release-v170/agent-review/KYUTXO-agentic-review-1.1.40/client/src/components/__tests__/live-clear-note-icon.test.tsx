// @vitest-environment jsdom
//
// Durable, rendered-component regression for the EDIT case of the live
// note-icon behaviour. Create (icon appears live on createRecord) and delete
// (icon disappears live on deleteRecord) are covered by
// live-create-note-icon*.test.tsx and live-delete-note-icon.test.tsx. This
// file covers the remaining symmetric gap: EDITING an existing record via the
// real updateRecord so it no longer surfaces any hover metadata (note/label/
// tags cleared). The record still exists, but the orange FileText icon must
// DISAPPEAR live on the already-rendered link — with NO hover and NO
// reload/remount.
//
// updateRecord invalidates the hover-metadata cache for the identifier; since
// the link is subscribed (visible), the cache immediately re-resolves from the
// DB, finds a record with no surfaced metadata, and notifies the subscriber,
// clearing the icon within a render. A future change to the cache
// invalidation or the link subscription could leave a stale icon showing for
// a record whose metadata was cleared while the create/delete paths keep
// passing; this test fails if that happens.
//
// This runs the REAL stack end-to-end: the real Dexie database (via
// fake-indexeddb), the real createRecord/updateRecord CRUD primitives, the
// real metadata-hover cache + subscriber pipeline, and the real
// TxidLink/AddressLink rendered through the shared @/test/testProviders
// harness. Nothing on the update -> invalidate -> re-resolve -> icon-clears
// path is stubbed.
import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, cleanup, waitFor, act } from "@testing-library/react";

import { createRecord, updateRecord, clearAllRecords } from "@/lib/data/record-crud";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import { renderWithProviders } from "@/test/testProviders";
import { TxidLink } from "../TxidLink";
import { AddressLink } from "../AddressLink";

// Distinct from any other suite; first 8 chars drive the link testid.
const TXID = "c1eaeb00c1eaeb00000000000000000000000000000000000000000000000000";
const ADDRESS = "bc1qclearnoteicon00000000000000000000000aa";
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

describe("live note icon disappears on updateRecord clearing metadata (no hover, no remount)", () => {
  it("clears the orange note icon on a TxidLink when its record's metadata is cleared", async () => {
    renderWithProviders(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(txidTriggerId);
    // No record yet -> no icon.
    expect(hasIndicator(trigger)).toBe(false);

    // Create a record with a note/label/tags for this txid. The subscribed
    // (visible) link re-resolves live and the orange icon appears — this
    // establishes the "already HAS surfaced metadata" state on the SAME node.
    let recordId = 0;
    await act(async () => {
      recordId = await createRecord(
        {
          type: "transaction",
          inputString: TXID,
          label: "Has Note",
          notes: "counterparty note",
          tags: ["watch"],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });
    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(txidTriggerId))).toBe(true);
    });

    // The user edits the record and clears everything that surfaces hover
    // metadata. The record still exists — but no hover, no remount, the SAME
    // node must lose the icon on its own.
    await act(async () => {
      await updateRecord(
        recordId,
        { label: "", notes: "", tags: [] },
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(txidTriggerId))).toBe(false);
    });
    // Same DOM node throughout: proves a live subscription update, not a remount.
    expect(screen.getByTestId(txidTriggerId)).toBe(trigger);
  });

  it("clears the orange note icon on an AddressLink when its record's metadata is cleared", async () => {
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
          tags: ["watch"],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });
    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(addressTriggerId))).toBe(true);
    });

    await act(async () => {
      await updateRecord(
        recordId,
        { label: "", notes: "", tags: [] },
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(addressTriggerId))).toBe(false);
    });
    expect(screen.getByTestId(addressTriggerId)).toBe(trigger);
  });
});
