// @vitest-environment jsdom
//
// Guard test for the record *create* save flow (Task #1425).
//
// Task #1420 covered the record *edit* save flow (clicking the real Save button
// -> updateRecord). The create flow goes through the SAME RecordFormDialog Save
// button but a DIFFERENT handler (handleCreateRecord -> createRecord). Nothing
// previously clicked the real Save button to create a brand-new record, so a
// regression that breaks create-on-Save (wrong handler wiring, a disabled
// button, or validation blocking submission) would go uncaught.
//
// This test backs the real Dexie database with fake-indexeddb, opens the
// "Create New Record" dialog (RecordFormDialog with no initialData), fills the
// required Label + address fields, clicks Save via the shared clickSaveButton()
// helper, and asserts a brand-new record is persisted through the CRUD layer
// (createRecord) — not an edit of an existing one.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

import { Toaster } from "@/components/ui/toaster";
import { RecordFormDialog } from "@/components/RecordFormDialog";
import { createRecord } from "@/lib/dataFacade";
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

// Mirror of Dashboard's handleCreateRecord create path: validate the Bitcoin
// input, then persist a brand-new record through the CRUD layer (createRecord).
async function handleCreateRecord(data: any) {
  let recordType = data.type;
  if (data.type !== "other") {
    const validation = validateBitcoinInput(data.inputString);
    if (!validation.isValid) return;
    recordType = validation.type || data.type;
  }
  await createRecord(
    {
      type: recordType,
      inputString: data.inputString,
      label: data.label,
      source: data.source || "manual",
      addressImportance: data.addressImportance || "manual",
      tags: data.tags || [],
      categories: data.categories || [],
    },
    { skipVocabularySync: true },
  );
}

describe("RecordFormDialog create flow", () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  afterEach(async () => {
    cleanup();
    await clearAllRecords();
  });

  it("clicking Save on the Create New Record dialog persists a brand-new record via CRUD", async () => {
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

    // The vault is empty before we save.
    expect(await getRecordsByInputString(ADDRESS)).toHaveLength(0);

    // Fill the required Label + address fields.
    const labelInput = (await screen.findByTestId("input-label")) as HTMLInputElement;
    const addressInput = (await screen.findByTestId("input-address")) as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "Brand New Record" } });
    fireEvent.change(addressInput, { target: { value: ADDRESS } });

    // Save by clicking the real Save button. clickSaveButton asserts the button
    // is genuinely wired to submit its form, so this guards against the Save
    // button being moved outside the <form>, losing type="submit", or being
    // blocked by an empty required field.
    clickSaveButton();

    // A brand-new record is persisted through the CRUD layer (createRecord).
    await waitFor(async () => {
      const records = await getRecordsByInputString(ADDRESS);
      expect(records).toHaveLength(1);
      expect(records[0].label).toBe("Brand New Record");
    });
  });
});
