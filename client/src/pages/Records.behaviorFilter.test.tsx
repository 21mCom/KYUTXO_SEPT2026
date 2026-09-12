// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// This suite exercises the *page-level glue* for the Records behavior filter:
// selecting a label narrows displayRecords down to the matching address rows,
// the "applies to this page" notice appears, and the behavior-specific empty
// state shows when no loaded row matches. The BehaviorFilter control itself is
// unit-tested elsewhere, so here it is stubbed to drive `onChange` directly.
//
// Mock surface mirrors Records.loading.test.tsx, with two deliberate changes:
//   * RecordTable renders one testid'd row per record so we can assert which
//     rows survive the filter.
//   * BehaviorFilter is stubbed with plain buttons that toggle a single label,
//     bypassing the Radix popover entirely.
// ---------------------------------------------------------------------------

// Records calls useRecordPreview() directly, and its RecordCard rows render the
// real AddressLink/TxidLink (which also consume the context). Stub the context so
// the page renders without the full provider stack (and its Dexie dependencies).
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: vi.fn(),
    openRecordPreviewByAddress: vi.fn(),
    openRecordEdit: vi.fn(),
    closePreview: vi.fn(),
    isOpen: false,
    isLoading: false,
  }),
  RecordPreviewProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/lib/activity-bus", () => ({
  getActivityBus: () => ({
    publishTask: vi.fn(),
    completeTask: vi.fn(),
    pushEvent: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
  subscribeToDbChanges: () => () => {},
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/records", vi.fn()],
}));

const emptyVocab = { tags: [], categories: [], owners: [], walletNames: [], seedNames: [], walletSoftware: [] };
vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: emptyVocab.tags }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ categories: emptyVocab.categories }) }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: emptyVocab.owners }) }));
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: emptyVocab.walletNames }) }));
vi.mock("@/hooks/use-seed-names", () => ({ useSeedNames: () => ({ seedNames: emptyVocab.seedNames }) }));
vi.mock("@/hooks/use-wallet-software", () => ({ useWalletSoftware: () => ({ walletSoftware: emptyVocab.walletSoftware }) }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T): [T, boolean] => [value, false],
}));

vi.mock("@/lib/dataFacade", () => ({
  deleteRecord: vi.fn(),
  getParticipantsByTxids: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/records-query", () => ({
  buildRecordsCollection: vi.fn(() => ({})),
  buildIdentifierSearchCollection: vi.fn(() => ({})),
  looksLikeBitcoinIdentifier: vi.fn(() => null),
  resolveVisibleTierValues: vi.fn(() =>
    Promise.resolve(["verified", "manual", "wallet-import", "xpub-derived"]),
  ),
  fetchRecordsPage: vi.fn(async () => {
    const records = await mockDb.pageFetch();
    return {
      records,
      total: records.length,
      effectiveTotal: records.length,
      truncated: false,
    };
  }),
}));

// RecordTable renders the records it was handed so we can assert which rows
// survive the client-side behavior filter.
vi.mock("@/components/RecordTable", () => ({
  RecordTable: ({ records }: { records: Array<{ id: string; inputString: string }> }) => (
    <div data-testid="mock-record-table">
      {records.map((r) => (
        <div key={r.id} data-testid={`record-row-${r.id}`}>{r.inputString}</div>
      ))}
    </div>
  ),
}));
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: () => <div data-testid="mock-record-detail-panel" />,
}));
vi.mock("@/components/RecordFilters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/RecordFilters")>();
  return {
    ...actual,
    RecordFilters: () => <div data-testid="mock-record-filters" />,
  };
});
vi.mock("@/components/BlockchainToggle", () => ({
  BlockchainToggle: () => <div data-testid="mock-blockchain-toggle" />,
}));
// Stub the behavior picker with plain buttons that toggle a single label into
// the selected set — the page-level wiring is what we are testing.
vi.mock("@/components/BehaviorFilter", () => ({
  BehaviorFilter: ({
    selected,
    onChange,
  }: {
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
  }) => (
    <div data-testid="mock-behavior-filter">
      {["dormant", "high-activity", "accumulator", "distributor"].map((label) => (
        <button
          key={label}
          data-testid={`set-behavior-${label}`}
          onClick={() => {
            const next = new Set(selected);
            if (next.has(label)) next.delete(label);
            else next.add(label);
            onChange(next);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// db mock — the no-filter / blockchain-hidden default load path fans out into
// getAddressRecordsByImportanceTierLimited(tier) once per USER_CURATED_TIER,
// each resolving via mockDb.pageFetch(). We return the seeded rows on the first
// tier call and an empty array for the rest so the merged page is exactly our
// fixture set (no duplicates).
// ---------------------------------------------------------------------------

interface MockDb {
  customFieldsToArray: ReturnType<typeof vi.fn>;
  recordsAnyOfCount: ReturnType<typeof vi.fn>;
  recordsCount: ReturnType<typeof vi.fn>;
  pageFetch: ReturnType<typeof vi.fn>;
}
const mockDb: MockDb = {
  customFieldsToArray: vi.fn(() => Promise.resolve([])),
  recordsAnyOfCount: vi.fn(() => Promise.resolve(0)),
  recordsCount: vi.fn(() => Promise.resolve(0)),
  pageFetch: vi.fn(() => Promise.resolve([])),
};

vi.mock("dexie", () => {
  class FakeDexie {}
  return {
    default: { ...FakeDexie, minKey: -Infinity, maxKey: Infinity },
  };
});

vi.mock("@/lib/database", async () => {
  // database.ts does `export * from "./db-types"`, but `import`ing the real
  // module would evaluate its `class extends Dexie` against the mocked dexie.
  // Spread the plain db-types module so the harness's deep imports (RecordCard →
  // AddressLink → RecordPreviewContext → RecordDetailPanel → use-node-settings)
  // still find their re-exported constants without touching Dexie.
  const dbTypes = await import("@/lib/db-types");
  const recordsCollection = () => ({
    count: () => mockDb.recordsAnyOfCount(),
    and: () => recordsCollection(),
    until: () => ({
      each: async (visitor: (row: unknown) => void) => {
        for (const row of await mockDb.pageFetch()) visitor(row);
      },
    }),
    toArray: () => mockDb.pageFetch(),
  });
  const recordsBetween = () => ({
    reverse: () => ({
      limit: () => ({ toArray: () => mockDb.pageFetch() }),
      offset: () => ({ limit: () => ({ toArray: () => mockDb.pageFetch() }) }),
    }),
  });
  const records = {
    where: (_idx: string) => ({
      anyOf: (_v: unknown) => recordsCollection(),
      between: recordsBetween,
      equals: () => ({
        reverse: () => ({ limit: () => ({ toArray: () => mockDb.pageFetch() }) }),
      }),
      startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
    }),
    count: () => mockDb.recordsCount(),
    orderBy: () => ({
      uniqueKeys: () => Promise.resolve([]),
      reverse: () => ({
        offset: () => ({ limit: () => ({ toArray: () => mockDb.pageFetch() }) }),
      }),
    }),
    get: () => Promise.resolve(undefined),
  };

  return {
    ...dbTypes,
    USER_CURATED_TIERS: ['verified', 'manual', 'wallet-import', 'xpub-derived'],
    db: {
      records,
      settings: { get: () => Promise.resolve(undefined) },
      blockchainTransactions: { where: () => ({ startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }) }) },
      customFields: {
        orderBy: () => ({
          reverse: () => ({
            limit: () => ({ toArray: () => mockDb.customFieldsToArray() }),
          }),
          limit: () => ({ toArray: () => mockDb.customFieldsToArray() }),
          toArray: () => mockDb.customFieldsToArray(),
        }),
        toArray: () => mockDb.customFieldsToArray(),
      },
    },
  };
});

vi.mock("@/hooks/use-behavior-tally", () => ({
  useBehaviorTally: () => ({
    counts: {},
    computing: false,
    progress: null,
    cancel: vi.fn(),
    restart: vi.fn(),
  }),
}));

import Records from "./Records";

// ---------------------------------------------------------------------------
// Fixtures — three synced address records that each classify to a distinct,
// stable behavior label regardless of when the test runs. Times are anchored
// to "now" so the dormant/recency thresholds are deterministic.
// ---------------------------------------------------------------------------

const nowSec = Math.floor(Date.now() / 1000);
const YEAR_SECONDS = 365.25 * 24 * 3600;

const fixtureRecords = [
  {
    // Dormant: synced, has txs, last activity ~4 years ago (>= 3yr threshold).
    id: 1,
    type: "address",
    inputString: "addr-dormant",
    label: "Dormant Addr",
    statsComputedAt: 1000,
    cachedTxCount: 5,
    cachedUtxoCount: 1,
    cachedBalanceSats: 50_000,
    cachedLastActivityTime: nowSec - Math.floor(4 * YEAR_SECONDS),
  },
  {
    // High Activity: synced, 60 txs (>= 50), recent activity (not dormant).
    id: 2,
    type: "address",
    inputString: "addr-high-activity",
    label: "High Activity Addr",
    statsComputedAt: 1000,
    cachedTxCount: 60,
    cachedUtxoCount: 1,
    cachedBalanceSats: 50_000,
    cachedLastActivityTime: nowSec - 1000,
  },
  {
    // Accumulator: positive balance, 4 UTXOs over 5 txs (ratio 0.8 >= 0.4).
    id: 3,
    type: "address",
    inputString: "addr-accumulator",
    label: "Accumulator Addr",
    statsComputedAt: 1000,
    cachedTxCount: 5,
    cachedUtxoCount: 4,
    cachedBalanceSats: 100_000,
    cachedLastActivityTime: nowSec - 1000,
  },
];

function seedLoadedRecords() {
  // The current page query reads through the mocked records-query helper.
  mockDb.pageFetch.mockReset();
  mockDb.pageFetch.mockResolvedValue(fixtureRecords);
}

async function renderLoadedRecordsPage() {
  render(<Records />);
  await waitFor(
    () => {
      expect(screen.queryByTestId("text-records-loading")).toBeNull();
    },
    { timeout: 3000 },
  );
}

beforeEach(() => {
  mockDb.customFieldsToArray.mockReset().mockResolvedValue([]);
  mockDb.recordsAnyOfCount.mockReset().mockResolvedValue(0);
  mockDb.recordsCount.mockReset().mockResolvedValue(3);
  seedLoadedRecords();
});

afterEach(() => {
  cleanup();
});

describe("Records page behavior filter (page-level glue)", () => {
  it("shows every loaded row and no page-local notice when no behavior label is selected", async () => {
    await renderLoadedRecordsPage();

    expect(screen.getByTestId("record-row-1")).toBeTruthy();
    expect(screen.getByTestId("record-row-2")).toBeTruthy();
    expect(screen.getByTestId("record-row-3")).toBeTruthy();
    expect(screen.queryByTestId("text-behavior-filter-notice")).toBeNull();
  });

  it("narrows displayRecords to only the rows matching the selected label", async () => {
    await renderLoadedRecordsPage();

    fireEvent.click(screen.getByTestId("set-behavior-dormant"));

    await waitFor(() => {
      expect(screen.getByTestId("record-row-1")).toBeTruthy();
    });
    // The high-activity and accumulator rows must be filtered out.
    expect(screen.queryByTestId("record-row-2")).toBeNull();
    expect(screen.queryByTestId("record-row-3")).toBeNull();
  });

  it("renders the page-local notice while a behavior filter is active", async () => {
    await renderLoadedRecordsPage();

    fireEvent.click(screen.getByTestId("set-behavior-accumulator"));

    const notice = await screen.findByTestId("text-behavior-filter-notice");
    // Notice reports rows loaded on the page and how many matched the filter.
    expect(notice.textContent).toContain("3");
    expect(notice.textContent).toContain("1 match");
    // Only the accumulator row should survive.
    expect(screen.getByTestId("record-row-3")).toBeTruthy();
    expect(screen.queryByTestId("record-row-1")).toBeNull();
    expect(screen.queryByTestId("record-row-2")).toBeNull();
  });

  it("shows the behavior-specific empty state when no loaded row matches the filter", async () => {
    await renderLoadedRecordsPage();

    // No fixture classifies as a distributor.
    fireEvent.click(screen.getByTestId("set-behavior-distributor"));

    const empty = await screen.findByTestId("text-records-empty");
    expect(empty.textContent).toMatch(/No records on this page match the selected behavior labels/i);
    expect(screen.queryByTestId("record-row-1")).toBeNull();
    expect(screen.queryByTestId("record-row-2")).toBeNull();
    expect(screen.queryByTestId("record-row-3")).toBeNull();
  });
});
