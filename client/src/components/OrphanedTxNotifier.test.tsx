// @vitest-environment jsdom
//
// Coverage for OrphanedTxNotifier's post-configure re-check (Task #443).
//
// The notifier runs a once-per-session startup scan for transaction records
// missing on-chain data. When orphans are found but no blockchain provider is
// configured, it records a sessionStorage gate (kyutxo:orphansAwaitingProvider)
// and prompts the user to "Configure" a provider. Once a provider is later
// configured (a nodeSettings db change), it re-runs detection exactly once and
// prompts to "Fix now" — consuming the gate so later nodeSettings writes (e.g.
// connection-status updates during a sync) can't re-trigger the prompt.
//
// We drive the real subscribeToDbChanges/notifyDbChange pub-sub from
// @/lib/database and mock the data accessors (detection, settings, node
// settings) plus useToast/useLocation so we can assert exactly which toast
// fires, and how many times.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { OrphanedTxNotifier } from "./OrphanedTxNotifier";
import { notifyDbChange } from "@/lib/database";

const SESSION_KEY = "kyutxo:orphanCheckDone";
const AWAITING_PROVIDER_KEY = "kyutxo:orphansAwaitingProvider";

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  setLocation: vi.fn(),
  getSettings: vi.fn(),
  getNodeSettings: vi.fn(),
  detectOrphanedTxRecords: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: h.toast, dismiss: vi.fn() }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", h.setLocation] as const,
}));

vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: h.getSettings,
}));

vi.mock("@/lib/data/node-settings-crud", () => ({
  getNodeSettings: h.getNodeSettings,
}));

vi.mock("@/lib/txid-backfill", () => ({
  detectOrphanedTxRecords: h.detectOrphanedTxRecords,
}));

// Flush all pending microtasks (dynamic imports + awaited promises inside the
// effect's detached async IIFEs) so we can make negative assertions.
async function flushAll() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

function orphans(...txids: string[]) {
  return { txids, recordIds: new Map<string, number>() };
}

/** description text of the nth toast() call. */
function toastDescription(n = 0): string {
  return h.toast.mock.calls[n]?.[0]?.description ?? "";
}

/** data-testid of the action element on the nth toast() call. */
function toastActionTestId(n = 0): string | undefined {
  return h.toast.mock.calls[n]?.[0]?.action?.props?.["data-testid"];
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  // Defaults: orphan check enabled, orphans present, no provider yet.
  h.getSettings.mockResolvedValue({});
  h.getNodeSettings.mockResolvedValue(undefined);
  h.detectOrphanedTxRecords.mockResolvedValue(orphans("a".repeat(64), "b".repeat(64)));
});

afterEach(() => {
  cleanup();
});

describe("OrphanedTxNotifier — startup → configure provider re-check", () => {
  it("startup with orphans + no provider sets the awaiting-provider gate and prompts to configure", async () => {
    render(<OrphanedTxNotifier />);

    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));

    // Configure prompt (not the rebuild prompt), and the gate is armed.
    expect(toastActionTestId(0)).toBe("button-configure-provider");
    expect(toastDescription(0)).toContain("Configure a blockchain provider");
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBe("1");
  });

  it("configuring a provider re-runs detection and shows the rebuild prompt exactly once", async () => {
    render(<OrphanedTxNotifier />);
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBe("1");

    // A provider now exists; a nodeSettings write fires.
    h.getNodeSettings.mockResolvedValue({ id: "default", provider: "esplora" });
    await act(async () => {
      notifyDbChange(["nodeSettings"]);
    });

    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(2));

    // Second toast is the "Fix now" rebuild prompt, and detection re-ran.
    expect(toastActionTestId(1)).toBe("button-rebuild-missing-transactions");
    expect(toastDescription(1)).toContain("Rebuild");
    expect(h.detectOrphanedTxRecords).toHaveBeenCalledTimes(2);
    // The gate is consumed once a provider is configured.
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBeNull();
  });

  it("startup with orphans AND a provider already present prompts to rebuild without arming the gate", async () => {
    h.getNodeSettings.mockResolvedValue({ id: "default", provider: "esplora" });

    render(<OrphanedTxNotifier />);

    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(toastActionTestId(0)).toBe("button-rebuild-missing-transactions");
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBeNull();
  });
});

describe("OrphanedTxNotifier — gate consumption", () => {
  beforeEach(() => {
    // Simulate a session where startup already ran and armed the gate.
    sessionStorage.setItem(SESSION_KEY, "1");
    sessionStorage.setItem(AWAITING_PROVIDER_KEY, "1");
    h.getNodeSettings.mockResolvedValue({ id: "default", provider: "esplora" });
    h.detectOrphanedTxRecords.mockResolvedValue(orphans("a".repeat(64)));
  });

  it("re-prompts once on the first nodeSettings write, then stays silent on later writes", async () => {
    render(<OrphanedTxNotifier />);
    await flushAll(); // startup check short-circuits (SESSION_KEY already set)
    expect(h.toast).not.toHaveBeenCalled();

    // First nodeSettings write: provider configured → rebuild prompt fires once.
    await act(async () => {
      notifyDbChange(["nodeSettings"]);
    });
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(toastActionTestId(0)).toBe("button-rebuild-missing-transactions");
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBeNull();

    // Later nodeSettings writes (e.g. connection-status updates) must not loop.
    await act(async () => {
      notifyDbChange(["nodeSettings"]);
    });
    await flushAll();
    await act(async () => {
      notifyDbChange(["nodeSettings"]);
    });
    await flushAll();

    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.detectOrphanedTxRecords).toHaveBeenCalledTimes(1);
  });

  it("ignores db changes that do not touch nodeSettings", async () => {
    render(<OrphanedTxNotifier />);
    await flushAll();

    await act(async () => {
      notifyDbChange(["records", "blockchainTransactions"]);
    });
    await flushAll();

    expect(h.toast).not.toHaveBeenCalled();
    // Unrelated changes never consume the gate.
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBe("1");
  });

  it("does not consume the gate when the nodeSettings write still has no provider", async () => {
    h.getNodeSettings.mockResolvedValue(undefined);

    render(<OrphanedTxNotifier />);
    await flushAll();

    await act(async () => {
      notifyDbChange(["nodeSettings"]);
    });
    await flushAll();

    expect(h.toast).not.toHaveBeenCalled();
    // Gate is preserved so a later real configuration can still re-prompt.
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBe("1");
  });
});

describe("OrphanedTxNotifier — no prompt when disabled or nothing orphaned", () => {
  it("startup respects disableOrphanCheck (no prompt, no gate)", async () => {
    h.getSettings.mockResolvedValue({ disableOrphanCheck: true });

    render(<OrphanedTxNotifier />);
    await flushAll();

    expect(h.toast).not.toHaveBeenCalled();
    expect(h.detectOrphanedTxRecords).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBeNull();
  });

  it("startup with no orphans does not prompt or arm the gate", async () => {
    h.detectOrphanedTxRecords.mockResolvedValue(orphans());

    render(<OrphanedTxNotifier />);
    await flushAll();

    expect(h.toast).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBeNull();
  });

  it("re-check respects disableOrphanCheck even after a provider is configured", async () => {
    sessionStorage.setItem(SESSION_KEY, "1");
    sessionStorage.setItem(AWAITING_PROVIDER_KEY, "1");
    h.getNodeSettings.mockResolvedValue({ id: "default", provider: "esplora" });
    h.getSettings.mockResolvedValue({ disableOrphanCheck: true });

    render(<OrphanedTxNotifier />);
    await flushAll();

    await act(async () => {
      notifyDbChange(["nodeSettings"]);
    });
    await flushAll();

    expect(h.toast).not.toHaveBeenCalled();
    // Gate is consumed (provider seen) before the disabled check bails out.
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBeNull();
  });

  it("re-check with a provider but no remaining orphans does not prompt", async () => {
    sessionStorage.setItem(SESSION_KEY, "1");
    sessionStorage.setItem(AWAITING_PROVIDER_KEY, "1");
    h.getNodeSettings.mockResolvedValue({ id: "default", provider: "esplora" });
    h.detectOrphanedTxRecords.mockResolvedValue(orphans());

    render(<OrphanedTxNotifier />);
    await flushAll();

    await act(async () => {
      notifyDbChange(["nodeSettings"]);
    });
    await flushAll();

    expect(h.toast).not.toHaveBeenCalled();
    expect(h.detectOrphanedTxRecords).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(AWAITING_PROVIDER_KEY)).toBeNull();
  });
});
