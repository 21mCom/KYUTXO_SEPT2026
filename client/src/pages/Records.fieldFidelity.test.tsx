// @vitest-environment jsdom
//
// Consumer-wiring guard for the Records page (Task #1322).
//
// The shared converter `toPanelRecord` is contract-tested on its own. This test
// covers the OTHER end of the wire: that the Records page actually hands the
// fully-converted record to <RecordDetailPanel> without dropping a field on its
// own derivation path (`directLoadedRecord = convertRecord(getRecord(id))`).
// Because the fixture is the shared `Required<DbRecord>` record, a newly added
// schema field that the page forgets to carry through fails here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

import { fullRecord } from "@/test/fullRecordFixture";
import { toPanelRecord, type PanelRecord } from "@/lib/recordToPanel";

// Capture the record handed to <RecordDetailPanel> from the Records page path.
let capturedPanelRecord: PanelRecord | null | undefined;

// The page reaches the detail panel via `directLoadedRecord`, fed by getRecord.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecord: vi.fn(async () => fullRecord),
  };
});

// Stub the heavy context/hooks/db surface, mirroring Records.loading.test.tsx,
// so the page renders without the full provider stack or a live Dexie.
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

// Drive the page to the "single record selected" branch via the URL (?id=...).
vi.mock("wouter", () => ({
  useLocation: () => [`/records?id=${fullRecord.id}`, vi.fn()],
}));

vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ categories: [] }) }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [] }) }));
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: [] }) }));
vi.mock("@/hooks/use-seed-names", () => ({ useSeedNames: () => ({ seedNames: [] }) }));
vi.mock("@/hooks/use-wallet-software", () => ({ useWalletSoftware: () => ({ walletSoftware: [] }) }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T): [T, boolean] => [value, false],
}));

vi.mock("@/hooks/use-behavior-tally", () => ({
  useBehaviorTally: () => ({
    counts: {},
    computing: false,
    progress: null,
    cancel: vi.fn(),
    restart: vi.fn(),
  }),
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
  // Empty page so the selected id falls through to the directLoadedRecord path.
  fetchRecordsPage: vi.fn(() =>
    Promise.resolve({ records: [], total: 0, effectiveTotal: 0, truncated: false }),
  ),
}));

vi.mock("@/lib/metadata-hover", () => ({
  batchPreloadIdentifiers: vi.fn(() => Promise.resolve()),
}));

// Stub heavy child components; capture the panel record on the real consumer path.
vi.mock("@/components/RecordTable", () => ({
  RecordTable: () => <div data-testid="mock-record-table" />,
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
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: (props: { open: boolean; record?: PanelRecord }) => {
    if (props.open) capturedPanelRecord = props.record;
    return <div data-testid="mock-record-detail-panel" />;
  },
}));

vi.mock("dexie", () => {
  class FakeDexie {}
  return { default: { ...FakeDexie, minKey: -Infinity, maxKey: Infinity } };
});

vi.mock("@/lib/database", async () => {
  const dbTypes = await import("@/lib/db-types");
  const records = {
    where: () => ({
      anyOf: () => ({ count: () => Promise.resolve(0) }),
      between: () => ({ reverse: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }) }),
      equals: () => ({ reverse: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }) }),
      startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
    }),
    count: () => Promise.resolve(0),
    orderBy: () => ({ reverse: () => ({ offset: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }) }) }),
    get: () => Promise.resolve(undefined),
  };
  return {
    ...dbTypes,
    USER_CURATED_TIERS: ["verified", "manual", "wallet-import", "xpub-derived"],
    db: {
      records,
      blockchainTransactions: {
        where: () => ({ startsWithIgnoreCase: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }) }),
      },
      customFields: { toArray: () => Promise.resolve([]) },
    },
  };
});

import Records from "./Records";

const expectedPanelRecord = toPanelRecord(fullRecord);

beforeEach(() => {
  capturedPanelRecord = null;
});

afterEach(() => {
  cleanup();
});

describe("Records page panel record field fidelity", () => {
  it("hands every field of the selected record to the detail panel", async () => {
    render(<Records />);

    await waitFor(
      () => {
        expect(capturedPanelRecord).toBeTruthy();
      },
      { timeout: 3000 },
    );

    // Key set must match the converter output exactly — no field dropped/added.
    expect(new Set(Object.keys(capturedPanelRecord!))).toEqual(
      new Set(Object.keys(expectedPanelRecord)),
    );
    // Every value must survive untouched on the page's own derivation path.
    expect(capturedPanelRecord).toEqual(expectedPanelRecord);
  });
});
