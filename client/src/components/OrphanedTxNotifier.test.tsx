// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  ORPHAN_CHECK_DONE_KEY,
  ORPHANS_AWAITING_PROVIDER_KEY,
  resetOrphanCheckGate,
} from "@/lib/orphan-check-session";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const setLocationSpy = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/", setLocationSpy],
}));

const detectMock = vi.fn();
vi.mock("@/lib/txid-backfill", () => ({
  detectOrphanedTxRecords: () => detectMock(),
}));

vi.mock("@/lib/database", () => ({
  subscribeToDbChanges: () => () => {},
}));

const getSettingsMock = vi.fn();
vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: () => getSettingsMock(),
}));

const getNodeSettingsMock = vi.fn();
vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: () => getNodeSettingsMock(),
}));

import { OrphanedTxNotifier } from "./OrphanedTxNotifier";

beforeEach(() => {
  sessionStorage.clear();
  toastSpy.mockReset();
  setLocationSpy.mockReset();
  detectMock.mockReset();
  getSettingsMock.mockReset();
  getNodeSettingsMock.mockReset();
  // Sensible defaults: orphans exist, check not disabled.
  getSettingsMock.mockResolvedValue({ id: "default" });
  detectMock.mockResolvedValue({ txids: ["txa", "txb"], recordIds: new Map() });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("OrphanedTxNotifier startup check", () => {
  it("shows the 'Fix now' toast when a blockchain provider is configured", async () => {
    getNodeSettingsMock.mockResolvedValue({ id: "default" });

    render(<OrphanedTxNotifier />);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));

    const arg = toastSpy.mock.calls[0][0];
    expect(arg.title).toBe("Missing transaction data");
    expect(arg.description).toContain("Rebuild");
    expect(arg.action.props["data-testid"]).toBe(
      "button-rebuild-missing-transactions",
    );
    expect(arg.action.props.children).toBe("Fix now");

    // Provider is configured, so we never set the awaiting-provider gate.
    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBeNull();
    // The done gate is set so the check won't re-run this session.
    expect(sessionStorage.getItem(ORPHAN_CHECK_DONE_KEY)).toBe("1");
  });

  it("shows the 'Configure' toast and sets the awaiting-provider gate when no provider is configured", async () => {
    getNodeSettingsMock.mockResolvedValue(undefined);

    render(<OrphanedTxNotifier />);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));

    const arg = toastSpy.mock.calls[0][0];
    expect(arg.title).toBe("Missing transaction data");
    expect(arg.description).toContain("Configure a blockchain provider");
    expect(arg.action.props["data-testid"]).toBe("button-configure-provider");
    expect(arg.action.props.children).toBe("Configure");

    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBe("1");
  });

  it("does not prompt when no orphaned transactions are found", async () => {
    getNodeSettingsMock.mockResolvedValue({ id: "default" });
    detectMock.mockResolvedValue({ txids: [], recordIds: new Map() });

    render(<OrphanedTxNotifier />);

    // Give the async startup IIFE a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("does not run twice within the same session without a gate reset", async () => {
    getNodeSettingsMock.mockResolvedValue({ id: "default" });

    const first = render(<OrphanedTxNotifier />);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    first.unmount();

    // Remount without resetting the gate: the done flag suppresses a re-run.
    render(<OrphanedTxNotifier />);
    await Promise.resolve();
    await Promise.resolve();

    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("re-runs and re-prompts after the gate is reset (post-restore behavior)", async () => {
    getNodeSettingsMock.mockResolvedValue({ id: "default" });

    const first = render(<OrphanedTxNotifier />);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    first.unmount();

    // Simulate a backup restore clearing the gate before a page reload.
    resetOrphanCheckGate();
    expect(sessionStorage.getItem(ORPHAN_CHECK_DONE_KEY)).toBeNull();

    render(<OrphanedTxNotifier />);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));

    const arg = toastSpy.mock.calls[1][0];
    expect(arg.action.props["data-testid"]).toBe(
      "button-rebuild-missing-transactions",
    );
  });
});
