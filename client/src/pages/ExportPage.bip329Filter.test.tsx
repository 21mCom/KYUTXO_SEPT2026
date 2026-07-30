// @vitest-environment jsdom
//
// Regression guard: the BIP-329 export must honor the filter state VISIBLE at
// click time. The live match count debounces the search box (300ms via
// useDebouncedValue); the export handler must NOT reuse that debounced value,
// or a type-and-click / clear-and-click export silently ships a file filtered
// by the stale previous query.
//
// The page is rendered with every Dexie-backed seam mocked (vocabulary hooks,
// CRUD counts, eachRecord, db stub) so the test isolates the
// filter-state -> downloaded-blob wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { toastMock, downloadCapture } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  downloadCapture: { blob: null as Blob | null, name: null as string | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

// Vocabulary hooks -> empty lists (no IndexedDB).
vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [], isLoading: false }) }));
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: [], isLoading: false }) }));

// CRUD counts -> zero / fixture-driven cursor iteration (no IndexedDB).
vi.mock("@/lib/data/attachments-crud", () => ({ countAttachments: vi.fn(async () => 0) }));
vi.mock("@/lib/data/derivation-templates-crud", () => ({ countDerivationTemplates: vi.fn(async () => 0) }));
vi.mock("@/lib/data/transaction-crud", () => ({
  countTransactions: vi.fn(async () => 0),
  countTransactionParticipants: vi.fn(async () => 0),
}));
vi.mock("@/lib/data/address-sync-crud", () => ({ countAddressSyncState: vi.fn(async () => 0) }));
vi.mock("@/lib/data/lineage-crud", () => ({
  countUtxoLineage: vi.fn(async () => 0),
  countCustodySegments: vi.fn(async () => 0),
  countLineageSnapshots: vi.fn(async () => 0),
}));

// The ZIP-backup path is never exercised here, but its module wires CRUD page
// readers together at import time — stub it so the CRUD mocks above can stay
// minimal.
vi.mock("@/lib/backup/export", () => ({
  exportBackup: vi.fn(async () => {}),
  estimateExportBytes: vi.fn(() => 0),
}));
vi.mock("@/lib/backup/restore", () => ({
  evaluateDiskSpace: vi.fn(() => ({ sufficient: true, requiredBytes: 0 })),
}));

const ADDR = "bc1qexportpagefiltercheckaddressxxxxxxxxxx";
const TXID = "c".repeat(64);
const OUTPOINT = `${"d".repeat(64)}:1`;

const FIXTURE = [
  { type: "address", inputString: ADDR, label: "Savings address", walletName: "W1", tags: ["t1"] },
  { type: "transaction", inputString: TXID, label: "Coffee tx", walletName: "W2", tags: [] },
  {
    type: "transaction",
    inputString: OUTPOINT,
    label: "Frozen output",
    notes: "BIP-329 output at index 1. Spendable: false",
    walletName: "W1",
    tags: ["t1"],
  },
];

vi.mock("@/lib/data/record-crud", () => ({
  countRecords: vi.fn(async () => FIXTURE.length),
  eachRecord: vi.fn(async (cb: (r: unknown) => void) => {
    for (const r of FIXTURE) cb(r);
  }),
}));

// Keep the real sink module (types + helpers) but capture downloads instead of
// clicking an anchor.
vi.mock("@/lib/backup/sink", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/backup/sink")>();
  return {
    ...mod,
    downloadBlob: (blob: Blob, fileName: string) => {
      downloadCapture.blob = blob;
      downloadCapture.name = fileName;
    },
  };
});

// db stub: ExportPage's loadCounts only touches *.count() on these tables.
vi.mock("@/lib/database", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/database")>();
  const zeroTable = { count: async () => 0 };
  return {
    ...mod,
    db: {
      tags: zeroTable,
      categories: zeroTable,
      owners: zeroTable,
      walletNames: zeroTable,
      seedNames: zeroTable,
      walletSoftware: zeroTable,
    },
  };
});

import ExportPage from "./ExportPage";

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function downloadedLines(): Promise<Array<Record<string, unknown>>> {
  await waitFor(() => expect(downloadCapture.blob).not.toBeNull());
  const text = await blobText(downloadCapture.blob!);
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("ExportPage BIP-329 export uses the visible (not debounced) filter state", () => {
  beforeEach(() => {
    downloadCapture.blob = null;
    downloadCapture.name = null;
    toastMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("type-and-immediately-export applies the just-typed search", async () => {
    render(<ExportPage />);
    const search = await screen.findByTestId("input-bip329-search");
    fireEvent.change(search, { target: { value: "frozen output" } });
    // Do NOT wait out the 300ms count debounce — export right away. With the
    // stale-debounce bug this downloaded all 3 lines.
    fireEvent.click(screen.getByTestId("button-export-bip329"));

    const lines = await downloadedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "output", ref: OUTPOINT, label: "Frozen output" });
  });

  it("clear-filters-and-immediately-export ships the full unfiltered set", async () => {
    render(<ExportPage />);
    const search = await screen.findByTestId("input-bip329-search");
    fireEvent.change(search, { target: { value: "frozen output" } });
    // Wait for the debounce to fire so the Clear filters control appears.
    const clear = await screen.findByTestId("button-bip329-clear-filters", undefined, { timeout: 5000 });
    fireEvent.click(clear);
    // Export before the debounced search catches up with the cleared box. With
    // the stale-debounce bug this downloaded only the 1 matching line.
    fireEvent.click(screen.getByTestId("button-export-bip329"));

    const lines = await downloadedLines();
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.type).sort()).toEqual(["addr", "output", "tx"]);
  });
});
