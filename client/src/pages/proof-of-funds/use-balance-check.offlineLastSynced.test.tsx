// @vitest-environment jsdom
//
// Regression: the offline balance-check path builds its "last synced" label
// from record.statsComputedAt, which is stored in MILLISECONDS (Date.now()).
// The summary timestamp contract (shared with the live path's nowTs and
// rendered via formatUnix, which multiplies by 1000) is Unix SECONDS. The
// hook previously passed the raw milliseconds value through, rendering a
// "last synced" date millennia in the future on the Proof of Funds page and
// in the exported PDF. These tests lock in the ms→seconds conversion.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: vi.fn(() => ({})),
  isNodeUnreachableError: () => false,
  NODE_PROBE_TIMEOUT_MS: 1000,
  NODE_UNREACHABLE_CONSECUTIVE_LIMIT: 3,
}));

vi.mock("@/lib/data/address-stats", () => ({
  computeStatsForAddresses: vi.fn(async (addresses: string[]) => {
    const m = new Map<string, { balanceSats: number }>();
    for (const a of addresses) m.set(a, { balanceSats: 1234 });
    return m;
  }),
}));

// 2025-01-25T14:30:00Z as Unix seconds; statsComputedAt is stored in ms.
const SYNCED_UNIX_SECONDS = 1_737_815_400;
const SYNCED_MS = SYNCED_UNIX_SECONDS * 1000;
// Must pass real address validation (BIP-173 test vector).
const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(async () => [
    {
      id: 1,
      type: "address",
      inputString: ADDRESS,
      statsComputedAt: SYNCED_MS,
    },
  ]),
}));

import { useBalanceCheck } from "./use-balance-check";
import { formatUnix } from "./address-helpers";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useBalanceCheck offline last-synced timestamp", () => {
  it("converts statsComputedAt (ms) to Unix seconds for the summary + label", async () => {
    const { result } = renderHook(() =>
      useBalanceCheck({ nodeSettings: {} as never, onReset: () => {} }),
    );

    act(() => {
      result.current.setPastedText(ADDRESS);
      result.current.setBalanceSource("offline");
    });

    await act(async () => {
      await result.current.runCheck();
    });

    await waitFor(() => expect(result.current.summary).not.toBeNull());
    const summary = result.current.summary!;

    // The stored contract is Unix seconds, matching the live path's nowTs.
    expect(summary.timestamp).toBe(SYNCED_UNIX_SECONDS);

    // The rendered label must show the real 2025 sync date — not a far-future
    // date (raw ms fed to a seconds-based formatter) and not 1970.
    const expected = formatUnix(SYNCED_UNIX_SECONDS);
    expect(summary.asOfLabel).toBe(`Offline vault data — last synced ${expected}`);
    expect(expected).toContain("2025");
  });
});
