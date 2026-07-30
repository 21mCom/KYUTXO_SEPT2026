// @vitest-environment jsdom
//
// Regression guard for the CSV spreadsheet export section: it must offer the
// same filter vocabulary as the BIP-329 export, download only matching rows,
// and honor the filter state VISIBLE at click time (not the debounced value
// used by the live match count).
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

vi.mock("@/lib/backup/export", () => ({
  exportBackup: vi.fn(async () => {}),
  estimateExportBytes: vi.fn(() => 0),
}));
vi.mock("@/lib/backup/restore", () => ({
  evaluateDiskSpace: vi.fn(() => ({ sufficient: true, requiredBytes: 0 })),
}));

const ADDR = "bc1qexportpagecsvfiltercheckaddressxxxxxxx";
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
  // Unlabeled non-blockchain record: excluded from BIP-329 but present in CSV.
  { type: "other", inputString: "hardware-wallet-serial", label: "", tags: [] },
];

vi.mock("@/lib/data/record-crud", () => ({
  countRecords: vi.fn(async () => FIXTURE.length),
  eachRecord: vi.fn(async (cb: (r: unknown) => void) => {
    for (const r of FIXTURE) cb(r);
  }),
  getRecordsAfterId: vi.fn(async (afterId: number, limit: number) =>
    FIXTURE.map((r, i) => ({ ...r, id: i + 1 }))
      .filter((r) => r.id > afterId)
      .slice(0, limit)
  ),
}));

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

async function downloadedRows(): Promise<string[]> {
  await waitFor(() => expect(downloadCapture.blob).not.toBeNull());
  const text = await blobText(downloadCapture.blob!);
  return text.split("\r\n").filter((l) => l !== "");
}

describe("ExportPage CSV export filters", () => {
  beforeEach(() => {
    downloadCapture.blob = null;
    downloadCapture.name = null;
    toastMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the four filter controls and a live match count covering all records", async () => {
    render(<ExportPage />);
    expect(await screen.findByTestId("input-csv-search")).toBeTruthy();
    expect(screen.getByTestId("select-csv-type")).toBeTruthy();
    expect(screen.getByTestId("select-csv-tag")).toBeTruthy();
    expect(screen.getByTestId("select-csv-wallet")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("text-csv-match-count").textContent).toContain("4 records")
    );
  });

  it("unfiltered export downloads every record (including non-BIP-329 rows) as CSV", async () => {
    render(<ExportPage />);
    fireEvent.click(await screen.findByTestId("button-export-csv"));

    const rows = await downloadedRows();
    expect(downloadCapture.name).toMatch(/^kyutxo-records-.*\.csv$/);
    expect(rows).toHaveLength(5); // header + 4 records
    expect(rows[0].startsWith("Type,Identifier,Label")).toBe(true);
    expect(rows.some((r) => r.includes("hardware-wallet-serial"))).toBe(true);
  });

  it("type-and-immediately-export applies the just-typed search (no stale debounce)", async () => {
    render(<ExportPage />);
    const search = await screen.findByTestId("input-csv-search");
    fireEvent.change(search, { target: { value: "frozen output" } });
    // Do NOT wait out the 300ms count debounce — export right away.
    fireEvent.click(screen.getByTestId("button-export-csv"));

    const rows = await downloadedRows();
    expect(rows).toHaveLength(2); // header + 1 match
    expect(rows[1]).toContain(OUTPOINT);
    expect(rows[1]).toContain("Frozen output");
  });

  it("clear-filters-and-immediately-export ships the full unfiltered set", async () => {
    render(<ExportPage />);
    const search = await screen.findByTestId("input-csv-search");
    fireEvent.change(search, { target: { value: "frozen output" } });
    const clear = await screen.findByTestId("button-csv-clear-filters", undefined, { timeout: 5000 });
    fireEvent.click(clear);
    fireEvent.click(screen.getByTestId("button-export-csv"));

    const rows = await downloadedRows();
    expect(rows).toHaveLength(5);
  });
});
