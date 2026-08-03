// @vitest-environment jsdom
//
// Guard test: a `?search=` deep link into /records must be applied
// unconditionally — even when the vault is empty (zero records) — instead of
// being silently dropped, which used to dump the user on the full unfiltered
// list with no sign of the identifier they clicked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks for the heavy dependency surface of Records.tsx (mirrors
// Records.loading.test.tsx — just enough to render the page shell).
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

const SEARCHED = "bc1qdeeplinkedaddressxxxxxxxxxxxxxxxxxxxx";

// Mutable so individual tests can simulate wouter's two modes:
// - packaged (hash-routed) mode: query string rides on the wouter location
// - browser mode: wouter strips the query string; it's only on window.location
let mockWouterLocation = `/records?search=${SEARCHED}`;
vi.mock("wouter", () => ({
  useLocation: () => [mockWouterLocation, vi.fn()],
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
  fetchRecordsPage: vi.fn(() =>
    Promise.resolve({ records: [], total: 0, effectiveTotal: 0, truncated: false }),
  ),
}));

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

vi.mock("dexie", () => {
  class FakeDexie {}
  return {
    default: { ...FakeDexie, minKey: -Infinity, maxKey: Infinity },
  };
});

// Mutable record served by the mocked records table get — lets the ?id= deep-link
// test provide a direct-loadable record without reworking the module mock.
let mockRecordById: Record<number, unknown> = {};

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
        // Hidden-match counting walks the discovery tiers with until().each().
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
    get: (id: number) => Promise.resolve(mockRecordById[id]),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordById = {};
});

afterEach(() => {
  cleanup();
});

describe("Records ?search= deep link", () => {
  it("applies the URL search even when the record list is empty", async () => {
    mockWouterLocation = `/records?search=${SEARCHED}`;
    render(<Records />);

    await waitFor(
      () => {
        const input = screen.getByTestId("input-search") as HTMLInputElement;
        expect(input.value).toBe(SEARCHED);
      },
      { timeout: 3000 },
    );
  });

  it("falls back to window.location.search when wouter strips the query (browser mode)", async () => {
    // In browser mode, wouter's location hook returns only the pathname —
    // the deep-link query must be read from window.location.search instead.
    mockWouterLocation = "/records";
    window.history.replaceState(null, "", `/records?search=${SEARCHED}`);
    try {
      render(<Records />);

      await waitFor(
        () => {
          const input = screen.getByTestId("input-search") as HTMLInputElement;
          expect(input.value).toBe(SEARCHED);
        },
        { timeout: 3000 },
      );
    } finally {
      window.history.replaceState(null, "", "/records");
    }
  });
});

describe("Records ?id= deep link", () => {
  it("opens the record detail view from window.location.search in browser mode", async () => {
    // Same wouter behavior as above: in browser mode the location hook returns
    // only the pathname, so `/records?id=<id>` must be read from
    // window.location.search — otherwise the plain list stays on screen
    // (Task #1814, observed while building the Metadata Sources dedup check).
    mockRecordById[42] = {
      id: 42,
      type: "address",
      inputString: "bc1qdeeplinkopenrecordxxxxxxxxxxxxxxxxxx",
      label: "Deep-linked record",
      tags: [],
      categories: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockWouterLocation = "/records";
    window.history.replaceState(null, "", "/records?id=42");
    try {
      render(<Records />);

      await waitFor(
        () => {
          // The dedicated detail view replaces the list entirely.
          expect(screen.getByTestId("mock-record-detail-panel")).toBeTruthy();
          expect(screen.getByTestId("text-page-title").textContent).toContain(
            "Record Details",
          );
          expect(screen.queryByTestId("mock-record-table")).toBeNull();
        },
        { timeout: 3000 },
      );
    } finally {
      window.history.replaceState(null, "", "/records");
    }
  });
});
