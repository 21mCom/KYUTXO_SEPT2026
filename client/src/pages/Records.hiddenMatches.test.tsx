// @vitest-environment jsdom
//
// Task #1740 — hidden-tier match hint in Records search.
//
// When a default-view search (blockchain-discovered rows hidden) has matches
// only among hidden discovery-tier rows, the page must NOT dead-end on a
// silent "No records match your search": it shows a count-based notice with a
// one-click "Show hidden matches" button that flips the include toggle. These
// tests drive the page shell with the same mock surface as
// Records.urlSearch.test.tsx and a partial record-crud mock whose
// countHiddenTierMatches result each test controls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mutable per-test knobs (read lazily inside mock implementations).
// ---------------------------------------------------------------------------

let hiddenResult = { count: 0, capped: false, scanCapped: false };
let pageRecords: unknown[] = [];

// ---------------------------------------------------------------------------
// Mocks for the heavy dependency surface of Records.tsx (mirrors
// Records.urlSearch.test.tsx).
// ---------------------------------------------------------------------------

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

let mockLocation = "/records?search=stash";
vi.mock("wouter", () => ({
  useLocation: () => [mockLocation, vi.fn()],
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
  MAX_MATERIALIZE: 100000,
  buildRecordsCollection: vi.fn(() => ({})),
  buildIdentifierSearchCollection: vi.fn(() => ({})),
  looksLikeBitcoinIdentifier: vi.fn(() => null),
  resolveVisibleTierValues: vi.fn(() =>
    Promise.resolve(["verified", "manual", "wallet-import", "xpub-derived"]),
  ),
  fetchRecordsPage: vi.fn(() =>
    Promise.resolve({
      records: pageRecords,
      total: pageRecords.length,
      effectiveTotal: pageRecords.length,
      truncated: false,
    }),
  ),
}));

// Partial mock: the page must call the REAL record-crud count helpers for the
// deferred badge counts (they run against the fake db below), but the
// hidden-match count is the unit under test here.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    countHiddenTierMatches: vi.fn(() => Promise.resolve(hiddenResult)),
    // The date-added (addedSince) branch hits the createdAt keyset helpers,
    // which need a fuller Dexie surface than the fake db below provides.
    getRecordsPageByCreatedAtKeyset: vi.fn(() => Promise.resolve([])),
    countRecordsByCreatedAtWindow: vi.fn(() =>
      Promise.resolve({ count: 0, truncated: false }),
    ),
  };
});

vi.mock("@/components/RecordTable", () => ({
  RecordTable: () => <div data-testid="mock-record-table" />,
}));
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: () => <div data-testid="mock-record-detail-panel" />,
}));
// Interactive stand-in so tests can apply a tag column filter without a search.
vi.mock("@/components/RecordFilters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/RecordFilters")>();
  return {
    ...actual,
    RecordFilters: ({
      onFiltersChange,
    }: {
      onFiltersChange: (filters: unknown[]) => void;
    }) => (
      <button
        type="button"
        data-testid="mock-record-filters"
        onClick={() =>
          onFiltersChange([
            { id: "t1", field: "tags", operator: "includes", value: "hiddenonlytag" },
          ])
        }
      />
    ),
  };
});
// Inert tally hook so the real BehaviorFilter's vault-wide counts never touch
// the fake db surface.
vi.mock("@/hooks/use-behavior-tally", () => ({
  useBehaviorTally: () => ({
    counts: null,
    computing: false,
    progress: null,
    cancel: vi.fn(),
    restart: vi.fn(),
  }),
}));
// Interactive stand-in for the behavior filter: one click toggles a single
// "not-enough-data" selection on/off.
vi.mock("@/components/BehaviorFilter", () => ({
  BehaviorFilter: ({
    selected,
    onChange,
  }: {
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-behavior-filter"
      onClick={() =>
        onChange(selected.size > 0 ? new Set() : new Set(["not-enough-data"]))
      }
    />
  ),
}));
// Interactive stand-in for the recency-window filter (addedSince).
vi.mock("@/components/DateAddedFilter", () => ({
  DateAddedFilter: ({
    onSinceChange,
  }: {
    onSinceChange: (since: number | null) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-date-added-filter"
      onClick={() => onSinceChange(1000)}
    />
  ),
}));
// Interactive stand-in so the "Show hidden matches" click can be observed
// flipping the include toggle.
vi.mock("@/components/BlockchainToggle", () => ({
  BlockchainToggle: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-blockchain-toggle"
      data-checked={String(checked)}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

vi.mock("dexie", () => {
  class FakeDexie {}
  return {
    default: { ...FakeDexie, minKey: -Infinity, maxKey: Infinity },
  };
});

vi.mock("@/lib/database", async () => {
  const dbTypes = await import("@/lib/db-types");
  const recordsBetween = () => ({
    reverse: () => ({
      limit: () => ({ toArray: () => Promise.resolve([]) }),
      offset: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
    }),
  });
  const records = {
    where: (_idx: string) => ({
      anyOf: (_v: unknown) => ({
        count: () => Promise.resolve(0),
        until: () => ({ each: () => Promise.resolve() }),
      }),
      between: recordsBetween,
      equals: () => ({
        reverse: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
        filter: () => ({ count: () => Promise.resolve(0) }),
      }),
      startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
    }),
    count: () => Promise.resolve(0),
    orderBy: () => ({
      reverse: () => ({
        offset: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
      }),
    }),
    get: () => Promise.resolve(undefined),
  };

  return {
    ...dbTypes,
    USER_CURATED_TIERS: ["verified", "manual", "wallet-import", "xpub-derived"],
    db: {
      records,
      blockchainTransactions: {
        where: () => ({
          startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
        }),
      },
      customFields: { toArray: () => Promise.resolve([]) },
    },
  };
});

import Records from "./Records";
import { countHiddenTierMatches } from "@/lib/data/record-crud";

beforeEach(() => {
  vi.clearAllMocks();
  hiddenResult = { count: 0, capped: false, scanCapped: false };
  pageRecords = [];
  mockLocation = "/records?search=stash";
});

afterEach(() => {
  cleanup();
});

describe("Records hidden-tier match notice", () => {
  it("shows the hidden-match count on an empty search and one click includes them", async () => {
    hiddenResult = { count: 3, capped: false, scanCapped: false };
    render(<Records />);

    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 3000,
    });
    expect(notice.textContent).toContain("3 matches are hidden");
    expect(screen.getByTestId("mock-blockchain-toggle").getAttribute("data-checked")).toBe(
      "false",
    );

    fireEvent.click(screen.getByTestId("button-show-hidden-matches"));

    await waitFor(() => {
      expect(
        screen.getByTestId("mock-blockchain-toggle").getAttribute("data-checked"),
      ).toBe("true");
      // Once hidden rows are included the notice has nothing to say.
      expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
    });
  });

  it("renders a capped count as N+ and flags a partially scanned discovered set", async () => {
    hiddenResult = { count: 1000, capped: true, scanCapped: true };
    render(<Records />);

    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 3000,
    });
    expect(notice.textContent).toContain("1,000+");
    expect(notice.textContent).toContain("at least");
  });

  it("shows no notice when nothing matching is hidden", async () => {
    hiddenResult = { count: 0, capped: false, scanCapped: false };
    render(<Records />);

    await screen.findByText(/No records match/i, undefined, { timeout: 3000 });
    await waitFor(() => {
      expect(vi.mocked(countHiddenTierMatches).mock.calls.length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
  });

  it("a tag-only column filter (no search) still triggers the hidden-match count and notice", async () => {
    mockLocation = "/records";
    hiddenResult = { count: 2, capped: false, scanCapped: false };
    render(<Records />);

    // No narrowing yet → no count started, no notice.
    await waitFor(() => {
      expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
    });
    expect(vi.mocked(countHiddenTierMatches).mock.calls.length).toBe(0);

    fireEvent.click(screen.getByTestId("mock-record-filters"));

    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 3000,
    });
    expect(notice.textContent).toContain("2 matches are hidden");

    fireEvent.click(screen.getByTestId("button-show-hidden-matches"));
    await waitFor(() => {
      expect(
        screen.getByTestId("mock-blockchain-toggle").getAttribute("data-checked"),
      ).toBe("true");
      expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
    });
  });

  it("a recency-window-only narrowing (addedSince) triggers the hidden-match count", async () => {
    mockLocation = "/records";
    hiddenResult = { count: 1, capped: false, scanCapped: false };
    render(<Records />);

    await waitFor(() => {
      expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
    });
    expect(vi.mocked(countHiddenTierMatches).mock.calls.length).toBe(0);

    fireEvent.click(screen.getByTestId("mock-date-added-filter"));

    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 3000,
    });
    expect(notice.textContent).toContain("1 match is hidden");
  });

  it("a behavior-only narrowing triggers the hidden-match count with a behavior-aware predicate", async () => {
    mockLocation = "/records";
    hiddenResult = { count: 2, capped: false, scanCapped: false };
    render(<Records />);

    // No narrowing yet → no count started, no notice.
    await waitFor(() => {
      expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
    });
    expect(vi.mocked(countHiddenTierMatches).mock.calls.length).toBe(0);

    // Select the "not-enough-data" behavior label.
    fireEvent.click(screen.getByTestId("mock-behavior-filter"));

    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 3000,
    });
    expect(notice.textContent).toContain("2 matches are hidden");

    // The count's predicate must honor the behavior selection: an unsynced
    // address record matches "not-enough-data"; a synced one and a non-address
    // record do not.
    const calls = vi.mocked(countHiddenTierMatches).mock.calls;
    const { matches } = calls[calls.length - 1][0];
    expect(
      matches({ type: "address", tags: [] } as never),
    ).toBe(true);
    expect(
      matches({ type: "address", statsComputedAt: 1, cachedTxCount: 5, cachedLastActivityTime: Math.floor(Date.now() / 1000), tags: [] } as never),
    ).toBe(false);
    expect(matches({ type: "transaction", tags: [] } as never)).toBe(false);

    // One click includes the hidden rows.
    fireEvent.click(screen.getByTestId("button-show-hidden-matches"));
    await waitFor(() => {
      expect(
        screen.getByTestId("mock-blockchain-toggle").getAttribute("data-checked"),
      ).toBe("true");
      expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
    });
  });

  it("a search term combined with a behavior label counts hidden matches via the load effect's deferred count", async () => {
    // Task #1892 — the behavior-only test above exercises the recount effect
    // (deps: [behaviorFilters]). Changing the SEARCH while a behavior label is
    // already selected instead re-runs the load effect, whose deferred count
    // reads the behavior selection via behaviorFiltersRef at call time. That
    // deferred predicate must honor BOTH narrowings.
    mockLocation = "/records";
    hiddenResult = { count: 2, capped: false, scanCapped: false };
    render(<Records />);

    // Select the "not-enough-data" behavior label first (recount path).
    fireEvent.click(screen.getByTestId("mock-behavior-filter"));
    await screen.findByTestId("notice-hidden-matches", undefined, { timeout: 3000 });
    const callsBefore = vi.mocked(countHiddenTierMatches).mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    // Now add a search term — this triggers a full load, not the recount.
    fireEvent.change(screen.getByTestId("input-search"), {
      target: { value: "stash" },
    });

    await waitFor(
      () => {
        expect(
          vi.mocked(countHiddenTierMatches).mock.calls.length,
        ).toBeGreaterThan(callsBefore);
      },
      { timeout: 3000 },
    );

    // The load effect's deferred predicate must compose the search residual
    // AND the behavior selection (read via the ref at call time).
    const calls = vi.mocked(countHiddenTierMatches).mock.calls;
    const { matches } = calls[calls.length - 1][0];
    // Unsynced address ("not-enough-data") whose label matches the search.
    expect(
      matches({ type: "address", label: "cold stash", tags: [] } as never),
    ).toBe(true);
    // Behavior matches, search does not.
    expect(
      matches({ type: "address", label: "unrelated", tags: [] } as never),
    ).toBe(false);
    // Search matches, behavior does not (synced, recent activity).
    expect(
      matches({
        type: "address",
        label: "hot stash",
        statsComputedAt: 1,
        cachedTxCount: 5,
        cachedLastActivityTime: Math.floor(Date.now() / 1000),
        tags: [],
      } as never),
    ).toBe(false);

    // The notice stays up with the combined-narrowing count.
    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 3000,
    });
    expect(notice.textContent).toContain("2 matches are hidden");
  });

  it("clearing a behavior-only narrowing clears the notice", async () => {
    mockLocation = "/records";
    hiddenResult = { count: 4, capped: false, scanCapped: false };
    render(<Records />);

    fireEvent.click(screen.getByTestId("mock-behavior-filter"));
    await screen.findByTestId("notice-hidden-matches", undefined, { timeout: 3000 });

    // Toggle back to an empty selection → no narrowing → no notice.
    fireEvent.click(screen.getByTestId("mock-behavior-filter"));
    await waitFor(() => {
      expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
    });
  });

  it("also surfaces the notice under non-empty results", async () => {
    hiddenResult = { count: 2, capped: false, scanCapped: false };
    pageRecords = [
      {
        id: 1,
        type: "address",
        inputString: "bc1qvisiblestashrow0000000000000000001",
        inputStringLower: "bc1qvisiblestashrow0000000000000000001",
        label: "Visible stash",
        tags: [],
        categories: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(<Records />);

    await screen.findByTestId("mock-record-table", undefined, { timeout: 3000 });
    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 3000,
    });
    expect(notice.textContent).toContain("2 matches are hidden");
  });
});
