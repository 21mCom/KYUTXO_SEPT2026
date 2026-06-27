// @vitest-environment jsdom
//
// Covers the FindingCard behavior-badge rendering in the Privacy Audit detail
// (Task #785). Each flagged address may sit next to a small badge describing its
// deterministic on-chain behavior, but only when the address is actually backed
// by a synced record with a recognisable pattern. This locks in three rules:
//   (a) a synced address with a known pattern shows the correct label
//       (matching BEHAVIOR_LABEL_DISPLAY),
//   (b) a synced-but-not-enough-data address AND an unsynced record show NO
//       badge (label === 'not-enough-data' is suppressed), and
//   (c) an address with no matching record at all shows nothing.
//
// FindingCard maps addresses → behavior via getRecordsByInputStrings, so that
// loader is mocked to return records with differing cached stats. ClickableAddress
// and TxidLink are leaf components with their own IndexedDB/context dependencies
// (tested independently), so they are stubbed to keep this focused on the badge.

import { useEffect, useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PrivacyFinding } from "@/lib/privacy-audit";

// FindingCard maps addresses → behavior inside a useLiveQuery. Dexie's
// useLiveQuery only emits when its querier touches a tracked Dexie table; here
// the querier is fed by a mocked loader, so we replace useLiveQuery with a thin
// run-the-querier-once hook to drive the async result deterministically.
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T,>(fn: () => Promise<T> | T, deps: unknown[] = []) => {
    const [val, setVal] = useState<T | undefined>(undefined);
    useEffect(() => {
      let active = true;
      Promise.resolve(fn()).then((v) => {
        if (active) setVal(v);
      });
      return () => {
        active = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return val;
  },
}));

vi.mock("@/components/ClickableAddress", () => ({
  ClickableAddress: ({ address }: { address: string }) => (
    <span data-testid={`address-${address}`}>{address}</span>
  ),
}));

vi.mock("@/components/TxidLink", () => ({
  TxidLink: ({ txid }: { txid: string }) => (
    <span data-testid={`link-txid-${txid.slice(0, 8)}`}>{txid}</span>
  ),
}));

// Control which records back each flagged address. The other record-crud exports
// PrivacyAudit imports aren't exercised by FindingCard, so they're inert stubs.
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByInputStrings: vi.fn(),
  updateRecord: vi.fn(),
  countRecordsByType: vi.fn(),
  getRecordsPageByTypeIdReverseKeyset: vi.fn(),
}));

import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import { BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";
import { FindingCard } from "./PrivacyAudit";

const mockedGetRecords = vi.mocked(getRecordsByInputStrings);

// Four distinct flagged addresses, each exercising a different badge rule.
const ADDR_ACCUMULATOR = "bc1qaccumulator0000000000000000000";
const ADDR_HIGH_ACTIVITY = "bc1qhighactivity00000000000000000";
const ADDR_UNSYNCED = "bc1qunsynced0000000000000000000000";
const ADDR_NO_RECORD = "bc1qnorecord0000000000000000000000";

function addressRecord(inputString: string, overrides: Record<string, unknown> = {}) {
  return {
    id: inputString,
    type: "address" as const,
    inputString,
    label: null,
    tags: [],
    categories: [],
    ...overrides,
  };
}

function finding(overrides: Partial<PrivacyFinding> = {}): PrivacyFinding {
  return {
    type: "ADDRESS_REUSE",
    severity: "HIGH",
    description: "These addresses were reused.",
    details: {},
    correction: "Stop reusing addresses.",
    txids: [],
    addresses: [],
    ...overrides,
  };
}

function renderCard(f: PrivacyFinding) {
  return render(
    <TooltipProvider>
      <FindingCard finding={f} coinjoinTxids={new Set<string>()} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FindingCard address behavior badges", () => {
  it("shows the correct label for synced records, and no badge for unsynced / not-enough-data / missing records", async () => {
    mockedGetRecords.mockResolvedValue([
      // Synced + positive balance + utxoCount 5 / txCount 10 (ratio 0.5 ≥ 0.4)
      // + last activity ~6 months ago → Accumulator.
      addressRecord(ADDR_ACCUMULATOR, {
        statsComputedAt: Date.now(),
        cachedTxCount: 10,
        cachedBalanceSats: 500_000,
        cachedUtxoCount: 5,
        cachedLastActivityTime: Math.floor(Date.now() / 1000) - 180 * 24 * 3600,
      }),
      // Synced + txCount ≥ 50 → High Activity.
      addressRecord(ADDR_HIGH_ACTIVITY, {
        statsComputedAt: Date.now(),
        cachedTxCount: 75,
        cachedBalanceSats: 120_000,
        cachedUtxoCount: 4,
        cachedLastActivityTime: Math.floor(Date.now() / 1000) - 10 * 24 * 3600,
      }),
      // Record exists but has never been synced → not-enough-data → no badge.
      addressRecord(ADDR_UNSYNCED, {
        statsComputedAt: undefined,
      }),
      // ADDR_NO_RECORD is intentionally absent from this result.
    ] as any);

    renderCard(
      finding({
        addresses: [ADDR_ACCUMULATOR, ADDR_HIGH_ACTIVITY, ADDR_UNSYNCED, ADDR_NO_RECORD],
      }),
    );

    // The address list (and badges) live inside the collapsed details section.
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // (a) Synced addresses with known patterns show their labels.
    await waitFor(() => {
      expect(screen.getByTestId(`badge-behavior-${ADDR_ACCUMULATOR}`)).toBeTruthy();
    });
    expect(screen.getByTestId(`badge-behavior-${ADDR_ACCUMULATOR}`).textContent).toBe(
      BEHAVIOR_LABEL_DISPLAY["accumulator"],
    );
    expect(screen.getByTestId(`badge-behavior-${ADDR_HIGH_ACTIVITY}`).textContent).toBe(
      BEHAVIOR_LABEL_DISPLAY["high-activity"],
    );

    // Sanity: every address itself still rendered.
    expect(screen.getByTestId(`address-${ADDR_UNSYNCED}`)).toBeTruthy();
    expect(screen.getByTestId(`address-${ADDR_NO_RECORD}`)).toBeTruthy();

    // (b) An unsynced / not-enough-data record shows NO badge.
    expect(screen.queryByTestId(`badge-behavior-${ADDR_UNSYNCED}`)).toBeNull();

    // (c) An address with no matching record shows nothing.
    expect(screen.queryByTestId(`badge-behavior-${ADDR_NO_RECORD}`)).toBeNull();
  });

  it("hides behavior badges for addresses beyond the first 10 until expanded, and explains the subset", async () => {
    // 12 synced high-activity addresses → all would carry a badge, but only the
    // first 10 render until the user expands the full list.
    const addrs = Array.from({ length: 12 }, (_, i) =>
      `bc1qmany${String(i).padStart(24, "0")}`,
    );
    mockedGetRecords.mockResolvedValue(
      addrs.map((a) =>
        addressRecord(a, {
          statsComputedAt: Date.now(),
          cachedTxCount: 75,
          cachedBalanceSats: 120_000,
          cachedUtxoCount: 4,
          cachedLastActivityTime: Math.floor(Date.now() / 1000) - 10 * 24 * 3600,
        }),
      ) as any,
    );

    renderCard(finding({ addresses: addrs }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // First 10 show badges; the 11th and 12th do not (collapsed).
    await waitFor(() => {
      expect(screen.getByTestId(`badge-behavior-${addrs[0]}`)).toBeTruthy();
    });
    expect(screen.getByTestId(`badge-behavior-${addrs[9]}`)).toBeTruthy();
    expect(screen.queryByTestId(`badge-behavior-${addrs[10]}`)).toBeNull();
    expect(screen.queryByTestId(`badge-behavior-${addrs[11]}`)).toBeNull();

    // The subset is clearly communicated.
    expect(screen.getByTestId("text-behavior-subset-note")).toBeTruthy();

    // Expanding reveals badges for all addresses and removes the subset note.
    fireEvent.click(screen.getByTestId("button-toggle-all-addresses"));
    await waitFor(() => {
      expect(screen.getByTestId(`badge-behavior-${addrs[10]}`)).toBeTruthy();
    });
    expect(screen.getByTestId(`badge-behavior-${addrs[11]}`)).toBeTruthy();
    expect(screen.queryByTestId("text-behavior-subset-note")).toBeNull();
  });

  it("renders no behavior badges at all when none of the flagged addresses are backed by records", async () => {
    mockedGetRecords.mockResolvedValue([] as any);

    renderCard(finding({ addresses: [ADDR_ACCUMULATOR, ADDR_NO_RECORD] }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // The addresses render, but there are zero behavior badges.
    await waitFor(() => {
      expect(screen.getByTestId(`address-${ADDR_ACCUMULATOR}`)).toBeTruthy();
    });
    expect(screen.queryAllByTestId(/^badge-behavior-/)).toHaveLength(0);
  });
});
