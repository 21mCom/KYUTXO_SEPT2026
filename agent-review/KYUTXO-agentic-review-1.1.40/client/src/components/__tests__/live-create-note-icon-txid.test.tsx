// @vitest-environment jsdom
//
// Durable, rendered-component regression mirroring live-create-note-icon.test.tsx
// but for *transaction-ID* links (TxidLink) instead of address links. Transaction
// counterparties render as TxidLinks before any record exists for them, exactly
// like address counterparties. Creating a record for that txid must light up the
// orange FileText "note" icon on the ALREADY-RENDERED link with NO hover and NO
// reload/remount.
//
// A TxidLink mounts un-cached (so no icon) and subscribes to its identifier. When
// the user creates a record for that txid, createRecord invalidates the
// hover-metadata cache, which — because the link is subscribed (i.e. visible) —
// immediately re-resolves from the DB and notifies the subscriber, lighting the
// icon up within a render. The address path is already covered by a durable test;
// without this one, a future change to the metadata-hover cache or the TxidLink
// subscription could silently break the txid case while the address case keeps
// passing.
//
// This runs the REAL stack end-to-end: the real Dexie database (via
// fake-indexeddb), the real createRecord CRUD primitive, the real metadata-hover
// cache + subscriber pipeline, and the real TxidLink rendered through the shared
// @/test/testProviders harness (so the Tooltip / RecordPreview providers are
// present). Nothing on the create -> invalidate -> re-resolve -> icon path is
// stubbed, so the test fails if any link in that chain breaks.
import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, cleanup, waitFor, act } from "@testing-library/react";

import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import { renderWithProviders } from "@/test/testProviders";
import { TxidLink } from "../TxidLink";

// Distinct from any other suite; first 8 chars drive the link testid.
const TXID = "deadbeefcafe00000000000000000000000000000000000000000000000000ff";
const triggerId = `link-txid-${TXID.slice(0, 8)}`;

function hasIndicator(trigger: HTMLElement): boolean {
  return trigger.querySelector("svg.lucide-file-text.text-orange-500") !== null;
}

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  // Drop any module-level cache residue so the txid genuinely starts with no
  // cached "record" state, exactly like a freshly-rendered counterparty link.
  invalidateCachedRecord(TXID);
});

afterEach(async () => {
  cleanup();
  await clearAllRecords({ skipNotification: true });
  invalidateCachedRecord(TXID);
});

describe("TxidLink live note icon on createRecord (no hover, no remount)", () => {
  it("lights up the orange note icon when a record with a note is created for it", async () => {
    renderWithProviders(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(triggerId);

    // Rendered for a txid with no record -> no note icon, no hover fired.
    expect(hasIndicator(trigger)).toBe(false);

    // The user creates a record (with a note) for this counterparty. No hover,
    // no remount — the SAME node must gain the icon on its own.
    await act(async () => {
      await createRecord(
        {
          type: "transaction",
          inputString: TXID,
          label: "Newly Created",
          notes: "counterparty note",
          tags: [],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    // The icon appears on the original trigger node (same getByTestId), proving
    // the live subscription updated it without a remount or hover.
    await waitFor(() => {
      expect(hasIndicator(screen.getByTestId(triggerId))).toBe(true);
    });
    expect(screen.getByTestId(triggerId)).toBe(trigger);
  });

  it("stays icon-less when the created record carries no surfaced metadata", async () => {
    renderWithProviders(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    // A bare record (Unlabeled, no note/tags) surfaces nothing hasHoverMetadata
    // would show, so the indicator must remain hidden even after the live
    // re-resolve runs.
    await act(async () => {
      await createRecord(
        {
          type: "transaction",
          inputString: TXID,
          label: "Unlabeled",
          notes: "",
          tags: [],
          categories: [],
        } as Parameters<typeof createRecord>[0],
        { skipNotification: true, skipVocabularySync: true },
      );
    });

    // Give the fire-and-forget re-resolve a chance to run, then assert it stayed
    // icon-less.
    await waitFor(() => {
      expect(screen.getByTestId(triggerId)).toBeTruthy();
    });
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(hasIndicator(screen.getByTestId(triggerId))).toBe(false);
  });
});
