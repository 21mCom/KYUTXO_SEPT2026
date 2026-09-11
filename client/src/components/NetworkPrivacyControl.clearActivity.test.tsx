// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activityState = vi.hoisted(() => ({
  rows: [{
    id: 1,
    timestamp: 1_700_000_000_000,
    providerClass: "own-node" as const,
    action: "sync" as const,
    addressCount: 2,
  }],
}));

vi.mock("@/lib/data/network-privacy-activity-crud", () => ({
  getNetworkPrivacyActivity: vi.fn(async () => activityState.rows),
  clearNetworkPrivacyActivity: vi.fn(async () => {
    activityState.rows = [];
  }),
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({
    nodeSettings: {
      id: "default",
      providerType: "custom-mempool",
      useTor: false,
      useElectrum: false,
      networkPrivacyMode: "own-node",
      networkAccessEnabled: true,
      networkOnboardingStage: "complete",
    },
    updateSettings: vi.fn(),
    isLoading: false,
  }),
}));

import { renderWithProviders } from "@/test/testProviders";
import { NetworkPrivacyControl } from "./NetworkPrivacyControl";

describe("NetworkPrivacyControl activity clearing", () => {
  afterEach(() => {
    cleanup();
    activityState.rows = [{
      id: 1,
      timestamp: 1_700_000_000_000,
      providerClass: "own-node",
      action: "sync",
      addressCount: 2,
    }];
  });

  it("refreshes protected activity rows after clearing", async () => {
    renderWithProviders(<NetworkPrivacyControl />);

    fireEvent.click(screen.getByTestId("button-network-privacy-activity"));
    expect(await screen.findByText("Own node")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-clear-network-privacy-activity"));
    expect(await screen.findByTestId("network-privacy-activity-empty")).toBeTruthy();
  });
});