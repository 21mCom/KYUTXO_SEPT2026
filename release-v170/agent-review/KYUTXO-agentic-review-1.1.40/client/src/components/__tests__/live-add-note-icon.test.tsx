// @vitest-environment jsdom
//
// Durable, rendered-component regression for the remaining EDIT direction of
// the live note-icon behaviour. Create (icon appears live on createRecord),
// delete (icon disappears live on deleteRecord), and the clearing edit (icon
// disappears when updateRecord clears note/label/tags) are covered by
// live-create-note-icon*.test.tsx, live-delete-note-icon.test.tsx, and
// live-clear-note-icon.test.tsx. This file covers the symmetric gap: a record
// that EXISTS but surfaces no hover metadata (empty label/notes/tags), then
// the real updateRecord ADDS a note — the orange FileText icon must APPEAR
// live on the already-rendered TxidLink/AddressLink, with NO hover and NO
// reload/remount.
//
// updateRecord invalidates the hover-metadata cache for the identifier; since
// the link is subscribed (visible), the cache immediately re-resolves from the
// DB, finds the newly surfaced metadata, and notifies the subscriber, showing
// the icon within a render. A regression in the update-path cache
// invalidation could keep the icon hidden after an edit while the create/
// delete/clear paths keep passing; this test fails if that happens.
//
// This runs the REAL stack end-to-end: the real Dexie database (via
// fake-indexeddb), the real createRecord/updateRecord CRUD primitives, the
// real metadata-hover cache + subscriber pipeline, and the real
// TxidLink/AddressLink rendered through the shared @/test/testProviders
// harness. Nothing on the update -> invalidate -> re-resolve -> icon-appears
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
const TXID = "add10e77add10e77000000000000000000000000000000000000000000000000";
const ADDRESS = "bc1qaddnoteicon000000000000000000000000000";
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

describe("live note icon appears on updateRecord adding metadata to a bare record (no hover, no remount)", () => {
  it("shows the orange note icon on a TxidLink when a note is added to its bare record", async () => {
    // Bare record: exists, but surfaces no hover metadata.
    let recordId = 0;
    await act(async () => {
      recordId = await createRecord(
        {
          type: "transaction",
          inputString: TXID,
          label: "",
          notes: "",
          tags: [],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    renderWithProviders(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(txidTriggerId);
    // Record exists but is bare -> no icon. Give the subscription a beat to
    // resolve so a wrongly-shown icon would be caught, then assert steady state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(hasIndicator(screen.getByTestId(txidTriggerId))).toBe(false);

    // The user edits the record and adds a note. No hover, no remount — the
    // SAME node must gain the icon on its own.
    await act(async () => {
      await updateRecord(
        recordId,
        { notes: "counterparty note" },
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(txidTriggerId))).toBe(true);
    });
    // Same DOM node throughout: proves a live subscription update, not a remount.
    expect(screen.getByTestId(txidTriggerId)).toBe(trigger);
  });

  it("shows the orange note icon on an AddressLink when a note is added to its bare record", async () => {
    let recordId = 0;
    await act(async () => {
      recordId = await createRecord(
        {
          type: "address",
          inputString: ADDRESS,
          label: "",
          notes: "",
          tags: [],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    renderWithProviders(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(addressTriggerId);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(hasIndicator(screen.getByTestId(addressTriggerId))).toBe(false);

    await act(async () => {
      await updateRecord(
        recordId,
        { notes: "counterparty note" },
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(addressTriggerId))).toBe(true);
    });
    expect(screen.getByTestId(addressTriggerId)).toBe(trigger);
  });
});
