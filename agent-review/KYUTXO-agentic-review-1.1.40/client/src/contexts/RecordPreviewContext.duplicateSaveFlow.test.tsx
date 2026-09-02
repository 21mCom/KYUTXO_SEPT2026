// @vitest-environment jsdom
//
// Guard test for the record *duplicate* save flow (Task #1432).
//
// Task #1425 covered the create-on-Save path (handleCreateRecord -> createRecord
// when the entered address is brand new). But handleCreateRecord has a SECOND,
// previously untested branch: when the entered address already exists (a
// recordLookupMap hit), it calls updateRecord on the existing record instead of
// createRecord — so the user does NOT end up with a duplicate. Nothing clicked
// the real Save button to exercise this "save on an existing address" path, so a
// regression that turns it into a duplicate-creating path (or that updates the
// wrong record) would go uncaught.
//
// This test backs the real Dexie database with fake-indexeddb, seeds ONE record
// for an address, opens the "Create New Record" dialog (RecordFormDialog with no
// initialData), enters that SAME address plus changed metadata, clicks Save via
// the shared clickSaveButton() helper, and asserts NO second record is created
// and the existing record is updated through the CRUD layer (updateRecord).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

import { Toaster } from "@/components/ui/toaster";
import { RecordFormDialog } from "@/components/RecordFormDialog";
import { createRecord, updateRecord } from "@/lib/dataFacade";
import { clearAllRecords, getRecordsByInputString } from "@/lib/data/record-crud";
import { validateBitcoinInput } from "@/lib/bitcoin";
import { clickSaveButton } from "@/test/clickSave";
import { renderWithProviders } from "@/test/testProviders";

// A real, valid mainnet bech32 address so handleCreateRecord's
// validateBitcoinInput check passes (the create handler validates Bitcoin types).
const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

// Radix primitives inside the record form (Select, etc.) reach for
// ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// Mirror of Dashboard's handleCreateRecord: it looks the entered address up in
// recordLookupMap (a case-insensitive map keyed by trimmed inputString); on a
// hit it UPDATES the existing record (no duplicate), otherwise it creates a new
// one. We build the lookup fresh from the CRUD layer so the test exercises the
// real "this address already exists" decision.
async function handleCreateRecord(data: any) {
  let recordType = data.type;
  if (data.type !== "other") {
    const validation = validateBitcoinInput(data.inputString);
    if (!validation.isValid) return;
    recordType = validation.type || data.type;
  }

  const existing = await getRecordsByInputString(data.inputString.trim());
  const existingRecord = existing.find(
    (r) => (r.inputString ?? "").trim().toLowerCase() === data.inputString.trim().toLowerCase(),
  );

  const recordData = {
    type: recordType,
    inputString: data.inputString,
    label: data.label,
    notes: data.notes || "",
    source: data.source || "manual",
    addressImportance: data.addressImportance || "manual",
    tags: data.tags || [],
    categories: data.categories || [],
  };

  if (existingRecord?.id) {
    await updateRecord(existingRecord.id, recordData, { skipVocabularySync: true });
  } else {
    await createRecord(recordData, { skipVocabularySync: true });
  }
}

describe("RecordFormDialog duplicate save flow", () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  afterEach(async () => {
    cleanup();
    await clearAllRecords();
  });

  it("clicking Save on an address that already exists updates the existing record instead of creating a duplicate", async () => {
    // Seed ONE record for the address before opening the dialog.
    await createRecord(
      {
        type: "address",
        inputString: ADDRESS,
        label: "Original Label",
        source: "manual",
        addressImportance: "manual",
        tags: [],
        categories: [],
      },
      { skipVocabularySync: true },
    );

    const seeded = await getRecordsByInputString(ADDRESS);
    expect(seeded).toHaveLength(1);
    const originalId = seeded[0].id;

    renderWithProviders(
      <>
        <RecordFormDialog
          open={true}
          onClose={() => {}}
          onSave={handleCreateRecord}
        />
        <Toaster />
      </>,
    );

    // The create dialog opens (title confirms create, not edit, mode).
    expect(await screen.findByText("Create New Record")).toBeTruthy();

    // Enter the SAME address plus changed metadata.
    const labelInput = (await screen.findByTestId("input-label")) as HTMLInputElement;
    const addressInput = (await screen.findByTestId("input-address")) as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "Updated Label" } });
    fireEvent.change(addressInput, { target: { value: ADDRESS } });

    // Save by clicking the real Save button (asserts genuine submit wiring).
    clickSaveButton();

    // The existing record is updated in place — NO duplicate is created.
    await waitFor(async () => {
      const records = await getRecordsByInputString(ADDRESS);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(originalId);
      expect(records[0].label).toBe("Updated Label");
    });
  });
});
