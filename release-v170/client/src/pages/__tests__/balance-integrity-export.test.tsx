// @vitest-environment jsdom
//
// Component-level coverage for BalanceIntegrityCard's "Export CSV" / "Export
// JSON" buttons (button-export-stale-csv / -json). The card streams the full
// stale-address report back out of the local scratch store via
// exportStaleReport and hands the resulting Blob to an anchor download. This
// download path was previously untested at the component level, so a regression
// in the wiring (wrong filename, empty file, or a crash on click) could ship
// silently.
//
// The real stale-balance-report-store (backed by fake-indexeddb) is used so the
// exported Blob carries genuine streamed content; only the balance scan
// (detectStaleCachedBalances) is stubbed to deterministically yield stale rows,
// and exportStaleReport is wrapped with an optional gate so the in-progress
// disabled state can be observed mid-flight. Fully offline — no network.
import "fake-indexeddb/auto";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Fixture stale rows. One row deliberately carries a comma and a quote so the
// CSV escaping path (RFC 4180 quoting) is exercised by a real export.
const { STALE_ROWS } = vi.hoisted(() => ({
  STALE_ROWS: [
    { recordId: 1, address: "bc1qaddressone", cachedSats: 100, computedSats: 250 },
    { recordId: 2, address: 'bc1q"weird,name', cachedSats: 0, computedSats: 9999 },
    { recordId: 3, address: "3LegacyAddrThree", cachedSats: 5000, computedSats: 4200 },
  ],
}));

// Stub the balance scan so a run deterministically streams the fixture stale
// rows into the (real) scratch store and reports a non-zero stale count.
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(
    async (opts: {
      onStaleBatch?: (batch: typeof STALE_ROWS) => void | Promise<void>;
      onProgress?: (sampled: number, total?: number) => void;
      checkAll?: boolean;
    }) => {
      await opts.onStaleBatch?.(STALE_ROWS);
      opts.onProgress?.(STALE_ROWS.length, STALE_ROWS.length);
      return {
        sampled: STALE_ROWS.length,
        staleCount: STALE_ROWS.length,
        staleAddresses: [],
        checkedAll: !!opts.checkAll,
        cancelled: false,
      };
    },
  ),
  recomputeAddressStats: vi.fn(async () => undefined),
  countHeuristicMatchedAddresses: vi.fn(() => Promise.resolve(0)),
}));

// Wrap the real exportStaleReport so a test can hold it open and observe the
// "Exporting…" disabled state; otherwise it runs the genuine implementation
// against the same fake-indexeddb scratch store the card just populated.
// `rejectWith` forces the export to throw (simulating a streamed-read failure)
// and `forceEmpty` makes it resolve with rowCount === 0 (an empty scratch store)
// without going near the real implementation — both are reset between tests.
const exportGate = vi.hoisted(() => ({
  pending: null as null | Promise<void>,
  rejectWith: null as null | Error,
  forceEmpty: false,
}));
vi.mock("@/lib/data/stale-balance-report-store", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/data/stale-balance-report-store")>();
  return {
    ...actual,
    exportStaleReport: async (
      format: "csv" | "json",
      onProgress?: (written: number, total: number) => void,
    ) => {
      if (exportGate.pending) await exportGate.pending;
      if (exportGate.rejectWith) throw exportGate.rejectWith;
      if (exportGate.forceEmpty) {
        return {
          blob: new Blob([], {
            type:
              format === "csv"
                ? "text/csv;charset=utf-8"
                : "application/json;charset=utf-8",
          }),
          rowCount: 0,
        };
      }
      return actual.exportStaleReport(format, onProgress);
    },
  };
});

import { BalanceIntegrityCard } from "@/pages/DatabaseDoctor";

// jsdom implements neither URL.createObjectURL nor real anchor navigation.
// Capture the Blob handed to createObjectURL and the anchor download filename.
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickedDownloads: string[];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  toastSpy.mockClear();
  exportGate.pending = null;
  exportGate.rejectWith = null;
  exportGate.forceEmpty = false;
  clickedDownloads = [];
  createObjectURL = vi.fn(() => "blob:mock-url");
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownloads.push(this.download);
    });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  void clickSpy;
});

async function renderWithStaleRows() {
  const utils = renderWithProviders(<BalanceIntegrityCard />);
  fireEvent.click(screen.getByTestId("button-run-balance-check"));
  // Wait for the (stubbed) scan to stream rows in and the export buttons to show.
  await waitFor(() => screen.getByTestId("button-export-stale-csv"));
  return utils;
}

const CSV_NAME = /^stale-addresses-\d{4}-\d{2}-\d{2}\.csv$/;
const JSON_NAME = /^stale-addresses-\d{4}-\d{2}-\d{2}\.json$/;

describe("BalanceIntegrityCard — stale-address export buttons", () => {
  it("exports a CSV download with a dated filename and the real report content", async () => {
    await renderWithStaleRows();

    fireEvent.click(screen.getByTestId("button-export-stale-csv"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/csv;charset=utf-8");

    // A dated .csv download fired and the object URL was revoked afterwards.
    expect(clickedDownloads).toHaveLength(1);
    expect(clickedDownloads[0]).toMatch(CSV_NAME);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    // The Blob carries genuine, non-empty content: header + one line per row,
    // with the comma/quote-bearing address correctly RFC-4180 quoted.
    const text = await blob.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("recordId,address,cachedSats,computedSats");
    expect(text).toContain("1,bc1qaddressone,100,250");
    expect(text).toContain('2,"bc1q""weird,name",0,9999');
    expect(text).toContain("3,3LegacyAddrThree,5000,4200");
    expect(text.trimEnd().split("\n")).toHaveLength(STALE_ROWS.length + 1);
  });

  it("exports a JSON download with a dated filename and the real report content", async () => {
    await renderWithStaleRows();

    fireEvent.click(screen.getByTestId("button-export-stale-json"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json;charset=utf-8");

    expect(clickedDownloads).toHaveLength(1);
    expect(clickedDownloads[0]).toMatch(JSON_NAME);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    // The Blob is valid, non-empty JSON round-tripping every fixture row.
    const text = await blob.text();
    expect(text.length).toBeGreaterThan(0);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(STALE_ROWS);
  });

  it("disables both export buttons while an export is in progress, then re-enables them", async () => {
    await renderWithStaleRows();

    // Hold the export open so the in-flight state is observable.
    let releaseExport!: () => void;
    exportGate.pending = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });

    const csvBtn = screen.getByTestId("button-export-stale-csv") as HTMLButtonElement;
    const jsonBtn = screen.getByTestId("button-export-stale-json") as HTMLButtonElement;

    expect(csvBtn.disabled).toBe(false);
    expect(jsonBtn.disabled).toBe(false);

    fireEvent.click(csvBtn);

    // Both buttons disable while the CSV export runs; the active one shows the
    // in-progress label.
    await waitFor(() => expect(csvBtn.disabled).toBe(true));
    expect(jsonBtn.disabled).toBe(true);
    expect(csvBtn.textContent).toContain("Exporting");

    // Let the export finish and confirm both buttons return to enabled.
    releaseExport();
    await waitFor(() => expect(csvBtn.disabled).toBe(false));
    expect(jsonBtn.disabled).toBe(false);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickedDownloads).toEqual([expect.stringMatching(CSV_NAME)]);
  });

  it("shows a destructive 'Export failed' toast and fires no download when the export throws", async () => {
    await renderWithStaleRows();

    // Make the streamed read reject mid-export.
    exportGate.rejectWith = new Error("stream blew up");

    const csvBtn = screen.getByTestId("button-export-stale-csv") as HTMLButtonElement;
    fireEvent.click(csvBtn);

    // A destructive "Export failed" toast surfaces the failure.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Export failed",
        }),
      ),
    );

    // Nothing was downloaded and no object URL was ever created/revoked.
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(clickedDownloads).toHaveLength(0);

    // The exporting state resets so both buttons re-enable after the failure.
    await waitFor(() => expect(csvBtn.disabled).toBe(false));
    expect(
      (screen.getByTestId("button-export-stale-json") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("fires no download and creates no object URL when the report is empty", async () => {
    await renderWithStaleRows();

    // Simulate an empty scratch store: export resolves with rowCount === 0.
    exportGate.forceEmpty = true;

    const csvBtn = screen.getByTestId("button-export-stale-csv") as HTMLButtonElement;
    fireEvent.click(csvBtn);

    // The export runs (button disables) and then re-enables once it resolves.
    await waitFor(() => expect(csvBtn.disabled).toBe(true));
    await waitFor(() => expect(csvBtn.disabled).toBe(false));

    // No object URL was created and no anchor download fired for the empty set.
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(clickedDownloads).toHaveLength(0);

    // An empty export is not a failure — no destructive toast is shown.
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );

    // Both buttons remain enabled afterward.
    expect(
      (screen.getByTestId("button-export-stale-json") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
