// @vitest-environment jsdom
//
// Durable, rendered-component regression for the headline LIVE behaviour that
// was previously only verified via an ephemeral runTest browser check (which
// does NOT run in CI): creating a record for a transaction counterparty makes
// the orange FileText "note" icon appear on its ALREADY-RENDERED AddressLink
// with NO hover and NO reload/remount.
//
// A transaction counterparty link can be on screen before any record exists for
// it. It mounts un-cached (so no icon) and subscribes to its identifier. When
// the user creates a record for that address, createRecord invalidates the
// hover-metadata cache, which — because the link is subscribed (i.e. visible) —
// immediately re-resolves from the DB and notifies the subscriber, lighting the
// icon up within a render. If a future change to the metadata-hover cache or the
// AddressLink subscription broke that wiring, this user-visible behaviour would
// silently regress with nothing else failing.
//
// This runs the REAL stack end-to-end: the real Dexie database (via
// fake-indexeddb), the real createRecord CRUD primitive, the real metadata-hover
// cache + subscriber pipeline, and the real AddressLink rendered through the
// shared @/test/testProviders harness (so the Tooltip / RecordPreview providers
// are present). Nothing on the create -> invalidate -> re-resolve -> icon path is
// stubbed, so the test fails if any link in that chain breaks.
import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, cleanup, waitFor, act } from "@testing-library/react";

import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { invalidateCachedRecord } from "@/lib/metadata-hover";
import { renderWithProviders } from "@/test/testProviders";
import { AddressLink } from "../AddressLink";

// Distinct from any other suite; first 8 chars drive the link testid.
const ADDRESS = "bc1qlivecreatenoteicon000000000000000000aa";
const triggerId = `link-address-${ADDRESS.slice(0, 8)}`;

function hasIndicator(trigger: HTMLElement): boolean {
  return trigger.querySelector("svg.lucide-file-text.text-orange-500") !== null;
}

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  // Drop any module-level cache residue so the address genuinely starts with no
  // cached "record" state, exactly like a freshly-rendered counterparty link.
  invalidateCachedRecord(ADDRESS);
});

afterEach(async () => {
  cleanup();
  await clearAllRecords({ skipNotification: true });
  invalidateCachedRecord(ADDRESS);
});

describe("AddressLink live note icon on createRecord (no hover, no remount)", () => {
  it("lights up the orange note icon when a record with a note is created for it", async () => {
    renderWithProviders(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);

    // Rendered for an address with no record -> no note icon, no hover fired.
    expect(hasIndicator(trigger)).toBe(false);

    // The user creates a record (with a note) for this counterparty. No hover,
    // no remount — the SAME node must gain the icon on its own.
    await act(async () => {
      await createRecord(
        {
          type: "address",
          inputString: ADDRESS,
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
    renderWithProviders(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    // A bare record (Unlabeled, no note/tags) surfaces nothing hasHoverMetadata
    // would show, so the indicator must remain hidden even after the live
    // re-resolve runs.
    await act(async () => {
      await createRecord(
        {
          type: "address",
          inputString: ADDRESS,
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
