// @vitest-environment jsdom
//
// Consumer-wiring guard for the record detail panel (Task #1322).
//
// Task #1318 added a contract test for the shared converter `toPanelRecord`
// itself. But a consumer that builds a panel record could still drop a field on
// ITS OWN path — after the converter — by hand-copying or post-processing the
// result before handing it to <RecordDetailPanel>. RecordPreviewContext used to
// hand-build the panel record field-by-field (see memory note "RecordDetailPanel
// render paths"), which is exactly how a synced-but-empty record's stats got
// dropped.
//
// These tests feed a fully-populated DB record through the two RecordPreviewContext
// entry points (openRecordPreview by id, openRecordPreviewByAddress) AND through
// AddressLink (which, when clicked, opens the shared preview via the context) and
// assert that the object actually handed to <RecordDetailPanel> still carries
// every field — not just whatever the converter returned. Because the fixture is
// the shared `Required<DbRecord>` record, a newly added schema field that a
// consumer forgets to carry through fails here.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { fullRecord } from "@/test/fullRecordFixture";
import { toPanelRecord } from "@/lib/recordToPanel";
import type { PanelRecord } from "@/lib/recordToPanel";

// Capture the `record` prop that the context hands to <RecordDetailPanel>. This
// is the rendered/derived panel record at the very end of each consumer path.
let capturedPanelRecord: PanelRecord | null | undefined;
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: (props: { open: boolean; record?: PanelRecord }) => {
    if (props.open) capturedPanelRecord = props.record;
    return null;
  },
}));

// The record CRUD reads are the seam each consumer uses to fetch the DB record.
// Return the fully-populated fixture so the test isolates the consumer's own
// derivation path from any field-stripping in the persistence layer.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecord: vi.fn(async () => fullRecord),
    getRecordsByInputString: vi.fn(async () => [fullRecord]),
  };
});

import {
  RecordPreviewProvider,
  useRecordPreview,
} from "@/contexts/RecordPreviewContext";
import { AddressLink } from "@/components/AddressLink";
import { ActivityBusProvider } from "@/lib/activity-bus";
import { TooltipProvider } from "@/components/ui/tooltip";

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ActivityBusProvider>
      <TooltipProvider>
        <RecordPreviewProvider>{children}</RecordPreviewProvider>
      </TooltipProvider>
    </ActivityBusProvider>
  );
}

function ById() {
  const { openRecordPreview } = useRecordPreview();
  return (
    <button data-testid="open-by-id" onClick={() => openRecordPreview(fullRecord.id!)}>
      open by id
    </button>
  );
}

function ByAddress() {
  const { openRecordPreviewByAddress } = useRecordPreview();
  return (
    <button
      data-testid="open-by-address"
      onClick={() => openRecordPreviewByAddress(fullRecord.inputString)}
    >
      open by address
    </button>
  );
}

// The expected panel record is the converter output. Comparing the consumer's
// rendered panel record against THIS (not against a hand-listed subset) means a
// consumer dropping a field after the converter fails, while a benign converter
// change stays in sync automatically.
const expectedPanelRecord = toPanelRecord(fullRecord);

function assertRetainsEveryField(captured: PanelRecord | null | undefined) {
  expect(captured).toBeTruthy();
  // Key set must match the converter output exactly — no field dropped or added.
  expect(new Set(Object.keys(captured!))).toEqual(
    new Set(Object.keys(expectedPanelRecord)),
  );
  // And every value must survive untouched (catches a consumer that mutates a
  // field's value, not just one that omits the key).
  expect(captured).toEqual(expectedPanelRecord);
}

describe("RecordPreviewContext panel record field fidelity", () => {
  beforeEach(() => {
    capturedPanelRecord = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("openRecordPreview (by id) hands every field to the detail panel", async () => {
    render(
      <Providers>
        <ById />
      </Providers>,
    );

    fireEvent.click(await waitFor(() => document.querySelector('[data-testid="open-by-id"]')!));
    await waitFor(() => assertRetainsEveryField(capturedPanelRecord));
  });

  it("openRecordPreviewByAddress hands every field to the detail panel", async () => {
    render(
      <Providers>
        <ByAddress />
      </Providers>,
    );

    fireEvent.click(
      await waitFor(() => document.querySelector('[data-testid="open-by-address"]')!),
    );
    await waitFor(() => assertRetainsEveryField(capturedPanelRecord));
  });

  it("AddressLink click opens the shared preview retaining every field", async () => {
    render(
      <Providers>
        <AddressLink address={fullRecord.inputString} recordId={fullRecord.id} />
      </Providers>,
    );

    const link = await waitFor(() =>
      document.querySelector(
        `[data-testid="link-address-${fullRecord.inputString.slice(0, 8)}"]`,
      ),
    );
    fireEvent.click(link!);
    await waitFor(() => assertRetainsEveryField(capturedPanelRecord));
  });
});
