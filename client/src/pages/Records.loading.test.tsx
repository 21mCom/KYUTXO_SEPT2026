// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks for the heavy dependency surface of Records.tsx. We only need just
// enough behavior to exercise the loading/error/idle lifecycle.
// ---------------------------------------------------------------------------

interface ActivityCall {
  kind: "publish" | "complete";
  id: string;
  label?: string;
  phase?: string;
}
const activityCalls: ActivityCall[] = [];
let activeTasks = new Map<string, { label: string; phase: string }>();

vi.mock("@/lib/activity-bus", () => ({
  getActivityBus: () => ({
    publishTask: (task: { id: string; label: string; phase: string }) => {
      activityCalls.push({ kind: "publish", id: task.id, label: task.label, phase: task.phase });
      activeTasks.set(task.id, { label: task.label, phase: task.phase });
    },
    completeTask: (id: string) => {
      activityCalls.push({ kind: "complete", id });
      activeTasks.delete(id);
    },
    pushEvent: vi.fn(),
  }),
}));

let dbChangeCallback: (() => void) | null = null;
vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
  subscribeToDbChanges: (cb: () => void) => {
    dbChangeCallback = cb;
    return () => {
      dbChangeCallback = null;
    };
  },
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
  // No debouncing in tests — return value immediately, never pending.
  useDebouncedValue: <T,>(value: T): [T, boolean] => [value, false],
}));

vi.mock("@/lib/dataFacade", () => ({
  deleteRecord: vi.fn(),
  getParticipantsByTxids: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/records-query", () => ({
  buildRecordsCollection: vi.fn(() => ({})),
  fetchRecordsPage: vi.fn(() => Promise.resolve({ records: [], total: 0, effectiveTotal: 0, truncated: false })),
}));

// Stub heavy child components so we don't render their entire trees.
vi.mock("@/components/RecordTable", () => ({
  RecordTable: () => <div data-testid="mock-record-table" />,
}));
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: () => <div data-testid="mock-record-detail-panel" />,
}));
vi.mock("@/components/RecordFilters", () => ({
  RecordFilters: () => <div data-testid="mock-record-filters" />,
}));
vi.mock("@/components/BlockchainToggle", () => ({
  BlockchainToggle: () => <div data-testid="mock-blockchain-toggle" />,
}));
vi.mock("@/components/ClickableAddress", () => ({
  ClickableAddress: ({ address }: { address: string }) => <span>{address}</span>,
}));

// ---------------------------------------------------------------------------
// db mock — we control the resolution of the calls that the Records loader
// performs, so we can assert on the loading lifecycle.
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

vi.mock("@/lib/database", () => {
  const recordsBetween = () => ({
    reverse: () => ({
      limit: () => ({ toArray: () => mockDb.pageFetch() }),
      offset: () => ({ limit: () => ({ toArray: () => mockDb.pageFetch() }) }),
    }),
  });
  const records = {
    where: (_idx: string) => ({
      anyOf: (_v: unknown) => ({ count: () => mockDb.recordsAnyOfCount() }),
      between: recordsBetween,
      equals: () => ({
        reverse: () => ({ limit: () => ({ toArray: () => mockDb.pageFetch() }) }),
      }),
      startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
    }),
    count: () => mockDb.recordsCount(),
    orderBy: () => ({
      reverse: () => ({
        offset: () => ({ limit: () => ({ toArray: () => mockDb.pageFetch() }) }),
      }),
    }),
    get: () => Promise.resolve(undefined),
  };

  return {
    db: {
      records,
      blockchainTransactions: { where: () => ({ startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }) }) },
      customFields: { toArray: () => mockDb.customFieldsToArray() },
    },
  };
});

import Records from "./Records";

function renderRecordsPage() {
  return render(<Records />);
}

beforeEach(() => {
  activityCalls.length = 0;
  activeTasks = new Map();
  mockDb.customFieldsToArray.mockReset().mockResolvedValue([]);
  mockDb.recordsAnyOfCount.mockReset().mockResolvedValue(0);
  mockDb.recordsCount.mockReset().mockResolvedValue(0);
  mockDb.pageFetch.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("Records page loading lifecycle", () => {
  it("exits the loading state and shows the empty state within a reasonable timeout", async () => {
    renderRecordsPage();

    // Loading indicator is shown initially.
    expect(screen.getByTestId("text-records-loading")).toBeTruthy();

    // After the awaited db calls resolve, loading should clear and either
    // records or the empty state should be visible.
    await waitFor(
      () => {
        expect(screen.queryByTestId("text-records-loading")).toBeNull();
      },
      { timeout: 3000 },
    );

    expect(screen.queryByTestId("text-records-load-error")).toBeNull();
    // Empty state has no testid — assert by visible copy.
    expect(screen.getByText(/No records found/i)).toBeTruthy();
  });

  it("shows the error state with a Retry button when the DB query fails", async () => {
    mockDb.recordsAnyOfCount.mockRejectedValueOnce(new Error("Simulated DB failure"));

    renderRecordsPage();

    await waitFor(
      () => {
        expect(screen.queryByTestId("text-records-loading")).toBeNull();
      },
      { timeout: 3000 },
    );

    const errorBlock = screen.getByTestId("text-records-load-error");
    expect(errorBlock.textContent).toContain("Simulated DB failure");

    const retryBtn = screen.getByTestId("button-retry-load-records");
    expect(retryBtn).toBeTruthy();

    // Clicking retry, with the next call configured to succeed, clears the error.
    mockDb.recordsAnyOfCount.mockResolvedValueOnce(0);
    await act(async () => {
      retryBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId("text-records-load-error")).toBeNull();
      },
      { timeout: 3000 },
    );
    expect(screen.queryByTestId("text-records-loading")).toBeNull();
  });

  it("publishes a 'Loading Records' task while loading and removes it once idle", async () => {
    // Hold customFields.toArray pending so we can observe the in-flight task.
    let resolveCustomFields: (v: unknown[]) => void = () => {};
    mockDb.customFieldsToArray.mockReturnValueOnce(
      new Promise<unknown[]>((res) => {
        resolveCustomFields = res;
      }),
    );

    renderRecordsPage();

    // While the load is in flight, the activity bus should hold the task.
    await waitFor(
      () => {
        const labels = Array.from(activeTasks.values()).map((t) => t.label);
        expect(labels).toContain("Loading Records");
      },
      { timeout: 1000 },
    );
    // The publish call should also appear in the call log.
    expect(
      activityCalls.some((c) => c.kind === "publish" && c.label === "Loading Records"),
    ).toBe(true);
    // Loading UI should still be visible while the task is pending.
    expect(screen.getByTestId("text-records-loading")).toBeTruthy();

    // Let the load complete.
    await act(async () => {
      resolveCustomFields([]);
    });

    await waitFor(
      () => {
        const labels = Array.from(activeTasks.values()).map((t) => t.label);
        expect(labels).not.toContain("Loading Records");
      },
      { timeout: 3000 },
    );
    expect(activeTasks.size).toBe(0);
    expect(screen.queryByTestId("text-records-loading")).toBeNull();
    // A matching completeTask should have been called for every publishTask id.
    const publishedIds = activityCalls.filter((c) => c.kind === "publish").map((c) => c.id);
    const completedIds = activityCalls.filter((c) => c.kind === "complete").map((c) => c.id);
    for (const id of publishedIds) {
      expect(completedIds).toContain(id);
    }
  });

  it("clears the activity task even when the load fails", async () => {
    mockDb.recordsAnyOfCount.mockRejectedValueOnce(new Error("Boom"));

    renderRecordsPage();

    await waitFor(
      () => {
        expect(screen.getByTestId("text-records-load-error")).toBeTruthy();
      },
      { timeout: 3000 },
    );

    // The 'Loading Records' task should be removed in the finally block,
    // returning the activity bus to idle even on error.
    const labels = Array.from(activeTasks.values()).map((t) => t.label);
    expect(labels).not.toContain("Loading Records");
    expect(activeTasks.size).toBe(0);
    expect(
      activityCalls.some((c) => c.kind === "publish" && c.label === "Loading Records"),
    ).toBe(true);
    expect(activityCalls.some((c) => c.kind === "complete")).toBe(true);
  });
});
