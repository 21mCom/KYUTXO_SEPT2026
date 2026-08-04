// @vitest-environment jsdom
//
// Type-switch stale-metadata guard for the shared record edit flow (Task #1407).
//
// Since Task #1394 made editing a record's Type actually persist, switching a
// record between 'address', 'transaction', and 'other' could leave behind
// metadata the new type's form no longer renders: transaction-only fields
// (flowType, dispositionType) on a record switched to 'address', and
// address-only fields (counterpartyType, counterpartyName) on a record
// switched to 'transaction'. These orphaned values are hidden by the form but
// persist and can surface in reports/exports.
//
// handleUpdateRecord now applies getTypeSwitchClears() when the Type changes.
// This test drives the REAL provider handler (same harness as the
// editFieldFidelity test) and asserts, in both directions plus '→ other',
// that the irrelevant fields are cleared while the fields shared by the
// address and transaction sections (acquisitionMethod, costBasisUsd) are
// intentionally retained across an address<->transaction switch.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

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

vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: () => null,
}));

import {
  RecordPreviewProvider,
  useRecordPreview,
  getTypeSwitchClears,
} from "@/contexts/RecordPreviewContext";
import { ActivityBusProvider } from "@/lib/activity-bus";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { createRecord } from "@/lib/dataFacade";
import { clearAllRecords, getRecord } from "@/lib/data/record-crud";

const TXID = "a".repeat(64);
const ADDRESS = "bc1qtypeswitch00000000000000000000000000xyz";

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

async function openEditAndSave(recordId: number, payload: Record<string, unknown>) {
  renderProvider(recordId);
  fireEvent.click(document.querySelector('[data-testid="trigger-edit"]')!);
  await waitFor(() => {
    expect(formOpen).toBe(true);
    expect(capturedOnSave).toBeTruthy();
  });
  await act(async () => {
    await capturedOnSave!(payload, []);
  });
  return waitFor(async () => {
    const r = await getRecord(recordId);
    expect(r).toBeTruthy();
    return r!;
  });
}

describe("RecordPreviewContext type-switch clears stale type-specific fields", () => {
  beforeEach(async () => {
    capturedOnSave = null;
    formOpen = false;
    await clearAllRecords();
  });

  afterEach(async () => {
    cleanup();
    await clearAllRecords();
  });

  it("transaction -> address clears flowType/dispositionType but keeps shared fields", async () => {
    const id = await createRecord(
      {
        type: "transaction",
        inputString: TXID,
        label: "Tx to switch",
        tags: [],
        categories: [],
        flowType: "sent",
        acquisitionMethod: "purchase",
        dispositionType: "sale",
        costBasisUsd: 1234.56,
      },
      { skipVocabularySync: true },
    );

    const saved = await openEditAndSave(id, {
      type: "address",
      inputString: ADDRESS,
      label: "Now an address",
      tags: [],
      categories: [],
      // The form re-submits whatever is still in formData, including the
      // stale transaction-only values — the handler must clear them anyway.
      flowType: "sent",
      acquisitionMethod: "purchase",
      dispositionType: "sale",
      costBasisUsd: 1234.56,
    });

    expect(saved.type).toBe("address");
    expect(saved.flowType).toBeUndefined();
    expect(saved.dispositionType).toBeUndefined();
    // Shared by both sections: intentionally retained.
    expect(saved.acquisitionMethod).toBe("purchase");
    expect(saved.costBasisUsd).toBe(1234.56);
  });

  it("address -> transaction clears counterpartyType/counterpartyName but keeps shared fields", async () => {
    const id = await createRecord(
      {
        type: "address",
        inputString: ADDRESS,
        label: "Address to switch",
        tags: [],
        categories: [],
        acquisitionMethod: "gift-received",
        costBasisUsd: 42,
        counterpartyType: "exchange",
        counterpartyName: "Coinbase",
      },
      { skipVocabularySync: true },
    );

    const saved = await openEditAndSave(id, {
      type: "transaction",
      inputString: TXID,
      label: "Now a transaction",
      tags: [],
      categories: [],
      acquisitionMethod: "gift-received",
      costBasisUsd: 42,
      counterpartyType: "exchange",
      counterpartyName: "Coinbase",
    });

    expect(saved.type).toBe("transaction");
    expect(saved.counterpartyType).toBeUndefined();
    expect(saved.counterpartyName).toBeUndefined();
    // Shared by both sections: intentionally retained.
    expect(saved.acquisitionMethod).toBe("gift-received");
    expect(saved.costBasisUsd).toBe(42);
  });

  it("switching to 'other' clears every type-specific metadata field", async () => {
    const id = await createRecord(
      {
        type: "transaction",
        inputString: TXID,
        label: "Tx to other",
        tags: [],
        categories: [],
        flowType: "received",
        acquisitionMethod: "mining",
        dispositionType: "payment",
        costBasisUsd: 9.99,
        counterpartyType: "mining-pool",
        counterpartyName: "Some Pool",
      },
      { skipVocabularySync: true },
    );

    const saved = await openEditAndSave(id, {
      type: "other",
      inputString: "some-note-identifier",
      label: "Now other",
      tags: [],
      categories: [],
      flowType: "received",
      acquisitionMethod: "mining",
      dispositionType: "payment",
      costBasisUsd: 9.99,
      counterpartyType: "mining-pool",
      counterpartyName: "Some Pool",
    });

    expect(saved.type).toBe("other");
    expect(saved.flowType).toBeUndefined();
    expect(saved.acquisitionMethod).toBeUndefined();
    expect(saved.dispositionType).toBeUndefined();
    expect(saved.costBasisUsd).toBeUndefined();
    expect(saved.counterpartyType).toBeUndefined();
    expect(saved.counterpartyName).toBeUndefined();
  });

  it("keeps type-specific fields when the Type does NOT change", async () => {
    const id = await createRecord(
      {
        type: "transaction",
        inputString: TXID,
        label: "Tx unchanged",
        tags: [],
        categories: [],
        flowType: "sent",
        dispositionType: "sale",
        costBasisUsd: 5,
      },
      { skipVocabularySync: true },
    );

    const saved = await openEditAndSave(id, {
      type: "transaction",
      inputString: TXID,
      label: "Still a transaction",
      tags: [],
      categories: [],
      flowType: "sent",
      dispositionType: "sale",
      costBasisUsd: 5,
    });

    expect(saved.flowType).toBe("sent");
    expect(saved.dispositionType).toBe("sale");
    expect(saved.costBasisUsd).toBe(5);
  });

  it("getTypeSwitchClears mapping mirrors the form's per-type sections", () => {
    expect(getTypeSwitchClears("address")).toEqual({
      flowType: undefined,
      dispositionType: undefined,
    });
    expect(getTypeSwitchClears("transaction")).toEqual({
      counterpartyType: undefined,
      counterpartyName: undefined,
    });
    expect(getTypeSwitchClears("other")).toEqual({
      flowType: undefined,
      acquisitionMethod: undefined,
      dispositionType: undefined,
      costBasisUsd: undefined,
      counterpartyType: undefined,
      counterpartyName: undefined,
    });
  });
});
