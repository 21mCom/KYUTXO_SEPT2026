// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import {
  NETWORK_BLOCKED_MESSAGE,
  NETWORK_CHOICE_REQUIRED_MESSAGE,
} from "@/lib/network-privacy";

const mocks = vi.hoisted(() => {
  const nodeSettings = {
    id: "default",
    providerType: "mempool-space",
    useTor: false,
    requestTimeout: 30_000,
    network: "mainnet",
    allowLocalNetwork: false,
    trustedLocalHosts: [],
    useElectrum: false,
    electrumPort: 50_001,
    electrumSSL: false,
    networkAccessEnabled: false,
    networkPrivacyMode: "standard",
    networkOnboardingStage: "complete",
    firstSyncConfirmedAt: undefined as number | undefined,
  };

  return {
    nodeSettings,
    updateProvider: vi.fn(),
    resumeSync: vi.fn(),
    syncSingleAddress: vi.fn(),
    getPausedState: vi.fn(),
    toast: vi.fn(),
    markFirstSyncConfirmed: vi.fn(),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: mocks.nodeSettings }),
}));

vi.mock("@/lib/network-privacy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network-privacy")>()),
  markFirstSyncConfirmed: (...args: unknown[]) => mocks.markFirstSyncConfirmed(...args),
}));

vi.mock("@/lib/transaction-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transaction-sync")>()),
  loadAddressRecords: vi.fn(async () => []),
  getAddressSourcesFromRecords: vi.fn(() => []),
  transactionSyncService: {
    getStats: vi.fn(async () => ({
      totalAddresses: 1,
      syncedAddresses: 0,
      totalTransactions: 0,
      lastSyncTime: null,
    })),
    getPausedState: (...args: unknown[]) => mocks.getPausedState(...args),
    getSkippedAddresses: vi.fn(async () => []),
    getBlacklist: vi.fn(async () => []),
    getMultiDepthEstimateFromRecords: vi.fn(() => ({
      depth0: 1,
      totalAddresses: 1,
      estimatedRequests: 1,
    })),
    setProgressCallback: vi.fn(),
    updateProvider: (...args: unknown[]) => mocks.updateProvider(...args),
    resumeSync: (...args: unknown[]) => mocks.resumeSync(...args),
    syncSingleAddress: (...args: unknown[]) => mocks.syncSingleAddress(...args),
  },
}));

import TransactionSync from "./TransactionSync";

const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const PAUSED_STATE = {
  remainingRecordIds: [1],
  addressesSynced: 2,
  transactionsImported: 3,
  newlyQueuedTransactions: 0,
  newAddressRecords: 0,
  currentDepth: 1,
};
const failedSyncResult = (message: string) => ({
  success: false,
  addressesSynced: 0,
  transactionsImported: 0,
  transactionsUpdated: 0,
  newlyQueuedTransactions: 0,
  newAddressRecords: 0,
  addressesSkipped: 0,
  addressesFiltered: 0,
  transactionsAlreadySynced: 0,
  depthsProcessed: [],
  errors: [message],
});

async function expectSettingsActionWithoutMutation(
  settingsBefore: string,
  expectedTitle: string,
  expectedMessage: string,
) {
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
  const payload = mocks.toast.mock.calls[0][0];
  expect(payload.title).toBe(expectedTitle);
  expect(payload.description).toBe(expectedMessage);
  expect(payload.action).toBeTruthy();
  render(payload.action);
  const action = screen.getByTestId("action-open-node-settings");
  expect(action.textContent).toBe("Open Node Settings");
  fireEvent.click(action);
  expect(window.location.pathname).toBe("/node-settings");
  expect(JSON.stringify(mocks.nodeSettings)).toBe(settingsBefore);
}

describe.each([
  ["configured-offline", NETWORK_BLOCKED_MESSAGE],
  ["unconfigured-source", NETWORK_CHOICE_REQUIRED_MESSAGE],
])("Transaction Sync provider recovery — %s", (_label, message) => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/transaction-sync");
    mocks.nodeSettings.firstSyncConfirmedAt = undefined;
    mocks.markFirstSyncConfirmed.mockResolvedValue(undefined);
    mocks.getPausedState.mockResolvedValue(PAUSED_STATE);
    mocks.updateProvider.mockImplementation(() => {
      throw new Error(message);
    });
  });

  afterEach(cleanup);

  it("offers Node Settings when deferred resume provider construction is blocked after approval", async () => {
    const settingsBefore = JSON.stringify(mocks.nodeSettings);
    renderWithProviders(<TransactionSync />);

    fireEvent.click(await screen.findByTestId("button-resume-sync"));
    expect(await screen.findByTestId("dialog-first-sync-disclosure")).toBeTruthy();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-confirm-first-sync"));

    await expectSettingsActionWithoutMutation(settingsBefore, "Resume Failed", message);
    expect(mocks.markFirstSyncConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1);
    expect(mocks.resumeSync).not.toHaveBeenCalled();
  });

  it("offers Node Settings when resume returns a policy error", async () => {
    mocks.nodeSettings.firstSyncConfirmedAt = 1;
    mocks.updateProvider.mockReset();
    mocks.resumeSync.mockResolvedValue(failedSyncResult(message));
    const settingsBefore = JSON.stringify(mocks.nodeSettings);
    renderWithProviders(<TransactionSync />);

    fireEvent.click(await screen.findByTestId("button-resume-sync"));

    await expectSettingsActionWithoutMutation(
      settingsBefore,
      "Sync Completed with Errors",
      message,
    );
    expect(mocks.updateProvider).toHaveBeenCalledWith(mocks.nodeSettings);
    expect(mocks.resumeSync).toHaveBeenCalledTimes(1);
  });

  it("offers Node Settings when deferred single-address provider construction is blocked after approval", async () => {
    const settingsBefore = JSON.stringify(mocks.nodeSettings);
    renderWithProviders(<TransactionSync />);

    fireEvent.change(await screen.findByTestId("input-single-address"), {
      target: { value: ADDRESS },
    });
    fireEvent.click(screen.getByTestId("button-single-sync"));
    expect(await screen.findByTestId("dialog-first-sync-disclosure")).toBeTruthy();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-confirm-first-sync"));

    await expectSettingsActionWithoutMutation(settingsBefore, "Sync Failed", message);
    expect(mocks.markFirstSyncConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1);
    expect(mocks.syncSingleAddress).not.toHaveBeenCalled();
    await waitFor(() => {
      expect((screen.getByTestId("button-single-sync") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("offers Node Settings when single-address sync returns a policy error", async () => {
    mocks.nodeSettings.firstSyncConfirmedAt = 1;
    mocks.updateProvider.mockReset();
    mocks.syncSingleAddress.mockResolvedValue(failedSyncResult(message));
    const settingsBefore = JSON.stringify(mocks.nodeSettings);
    renderWithProviders(<TransactionSync />);

    fireEvent.change(await screen.findByTestId("input-single-address"), {
      target: { value: ADDRESS },
    });
    fireEvent.click(screen.getByTestId("button-single-sync"));

    await expectSettingsActionWithoutMutation(
      settingsBefore,
      "Single Address Sync Failed",
      message,
    );
    expect(mocks.updateProvider).toHaveBeenCalledWith(mocks.nodeSettings);
    expect(mocks.syncSingleAddress).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect((screen.getByTestId("button-single-sync") as HTMLButtonElement).disabled).toBe(false);
    });
  });
});