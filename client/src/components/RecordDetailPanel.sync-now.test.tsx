// @vitest-environment jsdom
//
// Regression coverage for the "Sync Now" button in RecordDetailPanel.
//
// The Sync Now control lets the user pull confirmed transactions for a single
// tracked address on demand. It must only appear for address-type records, must
// disable itself while a sync is in flight (and re-enable afterwards), and must
// surface the outcome through a toast — a success toast carrying the imported
// transaction count, or a destructive toast on failure (whether the service
// returns success:false or throws).
//
// We render the real RecordDetailPanel and stub the data-fetching chain plus the
// transaction-sync service so the test exercises only the Sync Now behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const {
  toastSpy,
  updateProviderSpy,
  syncSingleAddressSpy,
  getParticipantsByAddressSpy,
  getTransactionsByTxidsSpy,
} = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  updateProviderSpy: vi.fn(),
  syncSingleAddressSpy: vi.fn(),
  getParticipantsByAddressSpy: vi.fn(async () => [] as unknown[]),
  getTransactionsByTxidsSpy: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/dataFacade", () => ({
  getRecordOrigins: vi.fn(async () => []),
  getParticipantsByAddress: getParticipantsByAddressSpy,
  getParticipantsByTxid: vi.fn(async () => []),
  getTransactionByTxid: vi.fn(async () => null),
  getTransactionsByTxids: getTransactionsByTxidsSpy,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: { providerType: "mempool-space" } }),
}));

vi.mock("@/lib/transaction-sync", () => ({
  transactionSyncService: {
    updateProvider: updateProviderSpy,
    syncSingleAddress: syncSingleAddressSpy,
  },
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,stub") },
}));

const { RecordDetailPanel } = await import("./RecordDetailPanel");

function makeSyncResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    addressesSynced: 1,
    transactionsImported: 0,
    transactionsUpdated: 0,
    newAddressRecords: 0,
    addressesSkipped: 0,
    addressesFiltered: 0,
    transactionsAlreadySynced: 0,
    depthsProcessed: [0],
    errors: [] as string[],
    ...overrides,
  };
}

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    type: "address" as const,
    inputString: "bc1qexampleaddress",
    label: "Test Address",
    tags: [],
    categories: [],
    ...overrides,
  };
}

function renderPanel(record: ReturnType<typeof baseRecord>, extraProps: Record<string, unknown> = {}) {
  return renderWithProviders(
    <RecordDetailPanel open={true} onClose={() => {}} record={record} {...extraProps} />,
  );
}

describe("RecordDetailPanel Sync Now button", () => {
  beforeEach(() => {
    toastSpy.mockClear();
    updateProviderSpy.mockClear();
    syncSingleAddressSpy.mockReset();
    getParticipantsByAddressSpy.mockReset();
    getParticipantsByAddressSpy.mockResolvedValue([]);
    getTransactionsByTxidsSpy.mockReset();
    getTransactionsByTxidsSpy.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the Sync Now button only for address-type records", () => {
    const { getByTestId } = renderPanel(baseRecord());
    expect(getByTestId("button-sync-now")).toBeTruthy();
  });

  it("does not render the Sync Now button for transaction records", () => {
    const { queryByTestId } = renderPanel(
      baseRecord({ type: "transaction", inputString: "a".repeat(64) }),
    );
    expect(queryByTestId("button-sync-now")).toBeNull();
  });

  it("does not render the Sync Now button for other records", () => {
    const { queryByTestId } = renderPanel(baseRecord({ type: "other" }));
    expect(queryByTestId("button-sync-now")).toBeNull();
  });

  it("disables the button while syncing and re-enables it after completion", async () => {
    let resolveSync: (value: ReturnType<typeof makeSyncResult>) => void = () => {};
    syncSingleAddressSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    );

    const { getByTestId } = renderPanel(baseRecord());
    const button = getByTestId("button-sync-now") as HTMLButtonElement;

    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));

    resolveSync(makeSyncResult({ transactionsImported: 2 }));

    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("shows a success toast with the imported transaction count (plural)", async () => {
    syncSingleAddressSpy.mockResolvedValue(makeSyncResult({ transactionsImported: 3 }));

    const onSyncComplete = vi.fn();
    const { getByTestId } = renderPanel(baseRecord(), { onSyncComplete });

    fireEvent.click(getByTestId("button-sync-now"));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(updateProviderSpy).toHaveBeenCalledTimes(1);
    expect(syncSingleAddressSpy).toHaveBeenCalledWith(
      "bc1qexampleaddress",
      expect.any(Function),
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Sync Complete",
        description: "Found 3 new transactions.",
      }),
    );
    expect(toastSpy.mock.calls[0][0].variant).toBeUndefined();
    await waitFor(() => expect(onSyncComplete).toHaveBeenCalledTimes(1));
  });

  it("shows a success toast with singular wording for a single transaction", async () => {
    syncSingleAddressSpy.mockResolvedValue(makeSyncResult({ transactionsImported: 1 }));

    const { getByTestId } = renderPanel(baseRecord());

    fireEvent.click(getByTestId("button-sync-now"));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Sync Complete",
        description: "Found 1 new transaction.",
      }),
    );
  });

  it("shows a destructive toast when the sync result reports failure", async () => {
    syncSingleAddressSpy.mockResolvedValue(
      makeSyncResult({ success: false, errors: ["Node unreachable"] }),
    );

    const onSyncComplete = vi.fn();
    const { getByTestId } = renderPanel(baseRecord(), { onSyncComplete });

    fireEvent.click(getByTestId("button-sync-now"));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Sync Failed",
        description: "Node unreachable",
        variant: "destructive",
      }),
    );
    expect(onSyncComplete).not.toHaveBeenCalled();
  });

  it("reloads the Transaction History list and renders newly imported transactions after a successful sync", async () => {
    // Before the sync, the data layer reports no participants for this address,
    // so the Transaction History section shows its empty state.
    getParticipantsByAddressSpy.mockResolvedValue([]);
    getTransactionsByTxidsSpy.mockResolvedValue([]);
    syncSingleAddressSpy.mockResolvedValue(makeSyncResult({ transactionsImported: 1 }));

    const { getByTestId, findByTestId } = renderPanel(baseRecord());

    // Open the Transaction History section so the initial (empty) load runs.
    fireEvent.click(getByTestId("button-toggle-tx-history"));
    await findByTestId("tx-history-empty");

    // Simulate the sync importing a new transaction: the data layer now returns
    // a freshly imported participant + its transaction record.
    const newTxid = "a".repeat(64);
    getParticipantsByAddressSpy.mockResolvedValue([
      { txid: newTxid, role: "output", vout: 0, amount: 100000 },
    ]);
    getTransactionsByTxidsSpy.mockResolvedValue([
      { txid: newTxid, blockTime: 1_700_000_000 },
    ]);

    // The empty state was rendered without any participant lookups yet beyond
    // the initial load; capture that baseline before syncing.
    const callsBeforeSync = getParticipantsByAddressSpy.mock.calls.length;

    fireEvent.click(getByTestId("button-sync-now"));

    // The refresh trigger must flow through to TransactionHistorySection, causing
    // it to re-fetch and render the newly available transaction row.
    const row = await findByTestId(`tx-history-row-${newTxid.slice(0, 8)}`);
    expect(row).toBeTruthy();

    // Confirm the list actually re-fetched (didn't just show stale data).
    expect(getParticipantsByAddressSpy.mock.calls.length).toBeGreaterThan(callsBeforeSync);

    // The imported amount renders as a receive (positive) entry.
    expect(getByTestId(`text-tx-amount-${newTxid.slice(0, 8)}`).textContent).toContain("+");
  });

  it("shows a destructive toast and clears the spinner when the sync throws", async () => {
    syncSingleAddressSpy.mockRejectedValue(new Error("boom"));

    const { getByTestId } = renderPanel(baseRecord());
    const button = getByTestId("button-sync-now") as HTMLButtonElement;

    fireEvent.click(button);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Sync Failed",
        description: "boom",
        variant: "destructive",
      }),
    );
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
