// @vitest-environment jsdom
//
// Write-path field-fidelity guard for the shared record edit flow (Task #1329).
//
// Task #1322 added a READ-path guard (RecordPreviewContext.fieldFidelity.test.tsx)
// proving the detail panel keeps every record field. The WRITE path has the same
// silent-drop risk and no equivalent guard: when a user edits a record,
// `handleUpdateRecord` in RecordPreviewContext calls `updateRecord(...)` with a
// HAND-LISTED object of ~20 fields. Any new editable schema field added later is
// easy to forget there, so an edit to it would be silently discarded on save with
// no error — exactly the class of bug the read-side panel test now prevents.
//
// This test seeds a BASELINE record whose editable fields all differ from the
// shared `Required<DbRecord>` fixture, opens the edit form through the real
// provider, submits a fully-populated form payload built FROM the fixture, and
// asserts that every user-editable field was actually persisted via the CRUD
// layer (getRecord). Because `updateRecord` MERGES into the existing row, a field
// that `handleUpdateRecord` forgets to carry through keeps its baseline value
// (not the submitted one) and the assertion fails.
//
// The editable field set is derived from the shared fixture MINUS an explicit
// non-editable exclusion set (system / derived / cache fields plus the columns
// this edit path intentionally does not round-trip). So a newly added editable
// schema column is, by default, treated as editable and forced through this guard
// — forgetting it in `handleUpdateRecord` fails the test.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

import { fullRecord } from "@/test/fullRecordFixture";
import type { Record as DbRecord } from "@/lib/database";

// Capture the real `onSave` (= handleUpdateRecord) the provider wires into the
// form. We mock the form itself (mirroring how the read-path test mocks the
// detail panel) so the test drives a controlled, fully-populated submit payload
// straight into the provider's persistence handler — the actual bug site.
type SaveFn = (data: unknown, files?: File[]) => Promise<void>;
let capturedOnSave: SaveFn | null = null;
let formOpen = false;
vi.mock("@/components/RecordFormDialog", () => ({
  RecordFormDialog: (props: { open: boolean; onSave: SaveFn }) => {
    formOpen = props.open;
    if (props.open) capturedOnSave = props.onSave;
    return null;
  },
}));

// The detail panel is irrelevant to the edit-save path; stub it out so the test
// stays isolated from tooltip/preview rendering.
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: () => null,
}));

import {
  RecordPreviewProvider,
  useRecordPreview,
} from "@/contexts/RecordPreviewContext";
import { ActivityBusProvider } from "@/lib/activity-bus";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { createRecord } from "@/lib/dataFacade";
import { clearAllRecords, getRecord } from "@/lib/data/record-crud";

// Fields that this edit path intentionally does NOT round-trip through
// handleUpdateRecord, so they must be excluded from the "every editable field
// persists" assertion. Anything NOT listed here is treated as user-editable, so
// a newly added editable schema column is caught by default.
//   - identity / auto-managed: id, createdAt, updatedAt, inputStringLower
//   - XPUB / derivation provenance (set at import, not edited here):
//     chainType, derivationPath, xpub, syncDepth, maxSyncedDepth,
//     discoveredInTxid, discoveredFromRecordId, firstSeenBlockTime
//   - per-address stats cache (written only by the sync/recompute path):
//     cachedBalanceSats, cachedTxCount, cachedLastActivityTime,
//     statsComputedAt, cachedUtxoCount
//   - conflict-resolution audit trail (written only by the Conflict Resolution
//     flow, never rendered or submitted by RecordFormDialog): conflictResolutions.
//     DELIBERATE DECISION (Task #1913): handleUpdateRecord must NOT carry this
//     field — updateRecord merges into the existing row, so omitting it
//     preserves recorded decisions, while carrying `data.conflictResolutions`
//     (always undefined from the form) would OVERWRITE and drop them via
//     IndexedDB's structured clone. See the matching note in
//     RecordPreviewContext.handleUpdateRecord.
const NON_EDITABLE_FIELDS: ReadonlySet<keyof DbRecord> = new Set<keyof DbRecord>([
  "id",
  "createdAt",
  "updatedAt",
  "inputStringLower",
  "chainType",
  "derivationPath",
  "xpub",
  "syncDepth",
  "maxSyncedDepth",
  "discoveredInTxid",
  "discoveredFromRecordId",
  "firstSeenBlockTime",
  "cachedBalanceSats",
  "cachedTxCount",
  "cachedLastActivityTime",
  "statsComputedAt",
  "cachedUtxoCount",
  "conflictResolutions",
]);

// Derived from the shared fixture, NOT hand-listed: every key on the fully
// populated record minus the explicit non-editable set above.
const EDITABLE_FIELDS = (Object.keys(fullRecord) as (keyof DbRecord)[]).filter(
  (k) => !NON_EDITABLE_FIELDS.has(k),
);

function OpenEditButton({ recordId }: { recordId: number }) {
  const { openRecordEdit } = useRecordPreview();
  return (
    <button data-testid="trigger-edit" onClick={() => openRecordEdit(recordId)}>
      open edit
    </button>
  );
}

function renderProvider(recordId: number) {
  return render(
    <ActivityBusProvider>
      <TooltipProvider>
        <RecordPreviewProvider>
          <OpenEditButton recordId={recordId} />
          <Toaster />
        </RecordPreviewProvider>
      </TooltipProvider>
    </ActivityBusProvider>,
  );
}

describe("RecordPreviewContext edit-save field fidelity", () => {
  beforeEach(async () => {
    capturedOnSave = null;
    formOpen = false;
    await clearAllRecords();
  });

  afterEach(async () => {
    cleanup();
    await clearAllRecords();
  });

  it("persists every user-editable field through updateRecord on save", async () => {
    // Baseline: each editable field deliberately DIFFERS from the fixture, so a
    // dropped field (which keeps its baseline value after the merge update) is
    // detectable.
    const baselineId = await createRecord(
      {
        type: "address",
        inputString: "bc1qbaseline000000000000000000000000000000xy",
        label: "Baseline Label",
        // 'wallet-import' so a dropped `source` (fixture is 'manual') is caught.
        source: "wallet-import",
        addressImportance: "manual",
        tags: [],
        categories: [],
      },
      { skipVocabularySync: true },
    );

    renderProvider(baselineId);

    // Open the edit form through the real provider so the captured onSave is the
    // real handleUpdateRecord bound to this record.
    fireEvent.click(document.querySelector('[data-testid="trigger-edit"]')!);
    await waitFor(() => {
      expect(formOpen).toBe(true);
      expect(capturedOnSave).toBeTruthy();
    });

    // The fully-populated submit payload the form would emit: every editable
    // field carries the fixture's value (including `type` and `vault`, which are
    // now asserted). The fixture's placeholder address still passes the
    // Bitcoin-input validation in handleUpdateRecord via the lenient bech32
    // format check, so `type: "address"` does not abort the save.
    const formPayload: { [key: string]: unknown } = {};
    for (const field of EDITABLE_FIELDS) {
      formPayload[field] = fullRecord[field];
    }

    await act(async () => {
      await capturedOnSave!(formPayload, []);
    });

    const saved = await waitFor(async () => {
      const r = await getRecord(baselineId);
      expect(r).toBeTruthy();
      return r!;
    });

    // Every editable field must have been persisted with the submitted value.
    // A field that handleUpdateRecord forgets to carry keeps its baseline value
    // here and fails — the silent-drop guard.
    for (const field of EDITABLE_FIELDS) {
      expect({ field, value: saved[field] }).toEqual({
        field,
        value: fullRecord[field],
      });
    }
  });
});
