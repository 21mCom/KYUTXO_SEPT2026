// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import {
  ToastProvider,
  Toast,
  ToastViewport,
} from "@/components/ui/toast";
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

// Capture the DB-change listener so tests can simulate a nodeSettings write
// later in the session (the post-configure re-check branch).
let dbChangeListener: ((tables: string[]) => void) | null = null;
const unsubscribeSpy = vi.fn();
vi.mock("@/lib/database", () => ({
  subscribeToDbChanges: (cb: (tables: string[]) => void) => {
    dbChangeListener = cb;
    return unsubscribeSpy;
  },
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
  dbChangeListener = null;
  unsubscribeSpy.mockReset();
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

describe("OrphanedTxNotifier provider-configured re-check", () => {
  it("re-prompts with 'Fix now' when a provider is configured mid-session", async () => {
    // Startup: no provider configured → sets awaiting-provider gate + Configure
    // toast. Re-check (after the nodeSettings change): provider now present.
    getNodeSettingsMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: "default" });

    render(<OrphanedTxNotifier />);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBe("1");
    expect(toastSpy.mock.calls[0][0].action.props["data-testid"]).toBe(
      "button-configure-provider",
    );

    // The component subscribed to DB changes during mount.
    expect(dbChangeListener).not.toBeNull();

    // Simulate a nodeSettings write now that a provider is configured.
    dbChangeListener!(["nodeSettings"]);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));

    const arg = toastSpy.mock.calls[1][0];
    expect(arg.title).toBe("Missing transaction data");
    expect(arg.description).toContain("Rebuild");
    expect(arg.action.props["data-testid"]).toBe(
      "button-rebuild-missing-transactions",
    );
    expect(arg.action.props.children).toBe("Fix now");
  });

  it("consumes the awaiting-provider gate so a second nodeSettings change does not re-prompt", async () => {
    getNodeSettingsMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: "default" });

    render(<OrphanedTxNotifier />);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBe("1");

    // First nodeSettings change with a configured provider → one "Fix now".
    dbChangeListener!(["nodeSettings"]);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));

    // The gate must be consumed so later writes can't loop the prompt.
    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBeNull();

    // A second nodeSettings change (e.g. a sync connection-status update) must
    // not re-trigger the prompt.
    dbChangeListener!(["nodeSettings"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastSpy).toHaveBeenCalledTimes(2);
  });

  it("does nothing on a nodeSettings change when the awaiting-provider gate is not set", async () => {
    // Startup finds no orphans, so the awaiting-provider gate is never set.
    detectMock.mockResolvedValue({ txids: [], recordIds: new Map() });
    getNodeSettingsMock.mockResolvedValue({ id: "default" });

    render(<OrphanedTxNotifier />);

    await Promise.resolve();
    await Promise.resolve();
    expect(toastSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBeNull();

    // A nodeSettings change with no gate set must be a no-op.
    expect(dbChangeListener).not.toBeNull();
    dbChangeListener!(["nodeSettings"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastSpy).not.toHaveBeenCalled();
    // getNodeSettings is never consulted by the re-check when the gate is unset.
    expect(getNodeSettingsMock).not.toHaveBeenCalled();
  });
});

describe("OrphanedTxNotifier toast action buttons", () => {
  // Renders the toast's action element inside a minimal Radix Toast context so
  // the real onClick handler runs when the button is clicked. These exercise
  // the navigation + autoBackfill side effects the handlers actually carry.
  const renderAction = (action: React.ReactElement) =>
    render(
      <ToastProvider>
        <Toast open>{action}</Toast>
        <ToastViewport />
      </ToastProvider>,
    );

  it("'Fix now' sets the autoBackfill flag and navigates to /settings when clicked", async () => {
    getNodeSettingsMock.mockResolvedValue({ id: "default" });

    render(<OrphanedTxNotifier />);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));

    const action = toastSpy.mock.calls[0][0].action as React.ReactElement;
    expect(action.props["data-testid"]).toBe(
      "button-rebuild-missing-transactions",
    );

    const { getByTestId } = renderAction(action);

    // Pre-condition: neither side effect has happened yet.
    expect(sessionStorage.getItem("kyutxo:autoBackfill")).toBeNull();
    expect(setLocationSpy).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("button-rebuild-missing-transactions"));

    expect(sessionStorage.getItem("kyutxo:autoBackfill")).toBe("1");
    expect(setLocationSpy).toHaveBeenCalledWith("/settings");
  });

  it("'Configure' navigates to /settings without setting the autoBackfill flag", async () => {
    getNodeSettingsMock.mockResolvedValue(undefined);

    render(<OrphanedTxNotifier />);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));

    const action = toastSpy.mock.calls[0][0].action as React.ReactElement;
    expect(action.props["data-testid"]).toBe("button-configure-provider");

    const { getByTestId } = renderAction(action);

    expect(setLocationSpy).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("button-configure-provider"));

    expect(setLocationSpy).toHaveBeenCalledWith("/settings");
    // The Configure handler must never arm the auto-backfill path.
    expect(sessionStorage.getItem("kyutxo:autoBackfill")).toBeNull();
  });
});
