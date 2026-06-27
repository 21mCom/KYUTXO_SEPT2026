// @vitest-environment jsdom
//
// Guard test for the shared record-preview "view / edit" flow (Task #1168).
//
// The address/txid hover tooltip promises "Click to view / edit". Clicking a
// link opens the shared preview panel via RecordPreviewProvider. Previously the
// panel's Edit button was a dead no-op because the provider rendered
// RecordDetailPanel without an `onEdit` handler. This test backs the real Dexie
// database with fake-indexeddb, seeds a curated record, opens the shared preview
// through `useRecordPreview().openRecordPreview(id)`, then exercises the Edit
// button to confirm it:
//   1. opens the editable record form prefilled with the record's data, and
//   2. persists changes through the CRUD layer (updateRecord) on save.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

import { ActivityBusProvider } from "@/lib/activity-bus";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  RecordPreviewProvider,
  useRecordPreview,
} from "@/contexts/RecordPreviewContext";
import { Toaster } from "@/components/ui/toaster";
import { createRecord } from "@/lib/dataFacade";
import { clearAllRecords, getRecord } from "@/lib/data/record-crud";

const ADDRESS = "bc1qeditflow00000000000000000000000000000000xy";

// Radix primitives inside the record form (Select, etc.) reach for
// ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

function OpenPreviewButton({ recordId }: { recordId: number }) {
  const { openRecordPreview } = useRecordPreview();
  return (
    <button data-testid="trigger-open" onClick={() => openRecordPreview(recordId)}>
      open preview
    </button>
  );
}

function renderFlow(recordId: number) {
  return render(
    <ActivityBusProvider>
      <TooltipProvider>
        <RecordPreviewProvider>
          <OpenPreviewButton recordId={recordId} />
          <Toaster />
        </RecordPreviewProvider>
      </TooltipProvider>
    </ActivityBusProvider>,
  );
}

describe("RecordPreviewContext view / edit flow", () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  afterEach(async () => {
    cleanup();
    await clearAllRecords();
  });

  it("opens the preview and lets the Edit button open a prefilled editable form that saves via CRUD", async () => {
    const id = await createRecord(
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

    renderFlow(id);

    // View: open the shared preview panel.
    fireEvent.click(screen.getByTestId("trigger-open"));
    const editButton = await screen.findByTestId("button-edit-panel");

    // Edit: clicking Edit must open the editable record form (previously a no-op).
    fireEvent.click(editButton);

    // The edit form opens (title confirms edit, not create, mode).
    expect(await screen.findByText("Edit Record")).toBeTruthy();

    const labelInput = (await screen.findByTestId("input-label")) as HTMLInputElement;
    // Form is prefilled with the existing record's data.
    await waitFor(() => expect(labelInput.value).toBe("Original Label"));

    // Change the label and save through the form.
    fireEvent.change(labelInput, { target: { value: "Updated Label" } });
    fireEvent.click(screen.getByTestId("button-save"));

    // Persisted via the CRUD layer (updateRecord).
    await waitFor(async () => {
      const updated = await getRecord(id);
      expect(updated?.label).toBe("Updated Label");
    });
  });
});
