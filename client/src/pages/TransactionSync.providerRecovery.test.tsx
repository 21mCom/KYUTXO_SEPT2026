// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import {
  NETWORK_BLOCKED_MESSAGE,
  NETWORK_CHOICE_REQUIRED_MESSAGE,
} from "@/lib/network-privacy";
import {
  consumePendingSyncAddresses,
  setPendingSyncAddresses,
} from "@/lib/sync/pendingSyncTargets";

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
    syncWithDepth: vi.fn(),
    query: vi.fn(),
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

vi.mock("@/lib/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repository")>();
  return {
    ...actual,
    getVaultRepository: () => {
      const repository = actual.getVaultRepository();
      return new Proxy(repository, {
        get(target, property, receiver) {
          if (property === "query") {
            return (...args: unknown[]) => mocks.query(...args);
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

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
    syncWithDepth: (...args: unknown[]) => mocks.syncWithDepth(...args),
    setSyncProtection: vi.fn(),
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
    consumePendingSyncAddresses();
    window.history.replaceState({}, "", "/transaction-sync");
    mocks.nodeSettings.firstSyncConfirmedAt = undefined;
    mocks.markFirstSyncConfirmed.mockResolvedValue(undefined);
    mocks.getPausedState.mockResolvedValue(PAUSED_STATE);
    mocks.query.mockResolvedValue([{
      id: 42,
      type: "address",
      inputString: ADDRESS,
      inputStringLower: ADDRESS,
    }]);
    mocks.updateProvider.mockImplementation(() => {
      throw new Error(message);
    });
  });

  afterEach(cleanup);

  it("offers Node Settings when deferred resume provider construction is blocked after approval", async () => {
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

  it("offers Node Settings when deferred report-targeted provider construction is blocked after approval", async () => {
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

  it("offers Node Settings when deferred report-targeted provider construction is blocked after approval", async () => {
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

  it("offers Node Settings when deferred report-targeted provider construction is blocked after approval", async () => {
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

  it("offers Node Settings when deferred report-targeted provider construction is blocked after approval", async () => {
    const settingsBefore = JSON.stringify(mocks.nodeSettings);
    setPendingSyncAddresses([ADDRESS]);
    renderWithProviders(<TransactionSync />);

    expect(await screen.findByTestId("dialog-first-sync-disclosure")).toBeTruthy();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-confirm-first-sync"));

    await expectSettingsActionWithoutMutation(settingsBefore, "Sync Failed", message);
    expect(mocks.markFirstSyncConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1);
    expect(mocks.syncWithDepth).not.toHaveBeenCalled();
  });
});

describe("Transaction Sync report-targeted first-sync approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumePendingSyncAddresses();
    window.history.replaceState({}, "", "/transaction-sync");
    mocks.nodeSettings.firstSyncConfirmedAt = undefined;
    mocks.markFirstSyncConfirmed.mockResolvedValue(undefined);
    mocks.getPausedState.mockResolvedValue(null);
    mocks.updateProvider.mockImplementation(() => undefined);
    mocks.query.mockResolvedValue([{
      id: 42,
      type: "address",
      inputString: ADDRESS,
      inputStringLower: ADDRESS,
    }]);
    mocks.syncWithDepth.mockResolvedValue({
      success: true,
      addressesSynced: 1,
      addressesSkipped: 0,
      addressesFiltered: 0,
      transactionsImported: 0,
      newlyQueuedTransactions: 0,
      newAddressRecords: 0,
      errors: [],
    });
  });

  afterEach(() => {
    consumePendingSyncAddresses();
    cleanup();
  });

  it("runs the report-targeted sync exactly once after approving the disclosure", async () => {
    setPendingSyncAddresses([ADDRESS]);
    renderWithProviders(<TransactionSync />);

    expect(await screen.findByTestId("dialog-first-sync-disclosure")).toBeTruthy();
    expect(mocks.syncWithDepth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-confirm-first-sync"));

    await waitFor(() => expect(mocks.syncWithDepth).toHaveBeenCalledTimes(1));
    expect(mocks.markFirstSyncConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1);
    expect(mocks.syncWithDepth).toHaveBeenCalledWith(
      {
        sourceFilter: "all",
        maxDepth: 1,
        specificRecordIds: [42],
      },
      undefined,
    );
  });
});

describe("Transaction Sync first-sync confirmation recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumePendingSyncAddresses();
    window.history.replaceState({}, "", "/transaction-sync");
    mocks.nodeSettings.firstSyncConfirmedAt = undefined;
    mocks.getPausedState.mockResolvedValue(PAUSED_STATE);
    mocks.updateProvider.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consumePendingSyncAddresses();
    cleanup();
  });

  it("keeps the requested sync pending when saving approval fails and allows retry", async () => {
    mocks.markFirstSyncConfirmed
      .mockRejectedValueOnce(new Error("settings write failed"))
      .mockResolvedValueOnce(undefined);

    renderWithProviders(<TransactionSync />);
    fireEvent.click(await screen.findByTestId("button-resume-sync"));
    fireEvent.click(await screen.findByTestId("button-confirm-first-sync"));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    const payload = mocks.toast.mock.calls[0][0];
    expect(payload.title).toBe("Could Not Save Privacy Confirmation");
    expect(payload.description).toContain("syncing did not start");
    expect(payload.action).toBeTruthy();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    expect(mocks.resumeSync).not.toHaveBeenCalled();
    expect(screen.getByTestId("dialog-first-sync-disclosure")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-confirm-first-sync"));

    await waitFor(() => expect(mocks.markFirstSyncConfirmed).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.updateProvider).toHaveBeenCalledTimes(1));
    expect(mocks.resumeSync).toHaveBeenCalledTimes(1);
  });

  it("shows a failure toast when the report-targeted address lookup rejects", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
    setPendingSyncAddresses([ADDRESS]);

    renderWithProviders(<TransactionSync />);

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith({
        title: "Sync Failed",
        description: "Could not look up the flagged addresses for syncing. Please try again.",
        variant: "destructive",
      });
    });
    expect(mocks.markFirstSyncConfirmed).not.toHaveBeenCalled();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    expect(mocks.syncWithDepth).not.toHaveBeenCalled();
  });
});
