// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { LegacyMigrationOverlay } from "./LegacyMigrationOverlay";

// ---------------------------------------------------------------------------
// LegacyMigrationOverlay only depends on the auth context (for the migration
// result/progress) and the router hook (for navigating to the recovery panel).
// We mock both so we can drive the overlay purely from synthetic auth state and
// assert on the "still locked" warning UI, the locked-records list/download,
// the live migration-progress screen, and the file-decryption screen. The
// on-demand re-scan path also calls countUnrecoveredLegacyRows, so we mock that
// too and drive its return value per-test.
// ---------------------------------------------------------------------------

type LockedRecordRef = { tableName: string; id: number };

type LegacyMigrationResult = {
  totalDecrypted: number;
  totalFailed: number;
  unexpectedError?: boolean;
  stillLocked?: number;
  verificationFailed?: boolean;
  lockedRecords?: LockedRecordRef[];
  lockedRecordsTruncated?: boolean;
} | null;

type LegacyMigrationProgress = {
  tableName: string;
  tableIndex: number;
  tableCount: number;
  current: number;
  total: number;
  failed: number;
} | null;

type FileDecryptProgress = {
  current: number;
  total: number;
  decrypted: number;
  failed: number;
  skipped: number;
  phase?: string;
} | null;

let mockAuthValue: {
  legacyMigrationProgress: LegacyMigrationProgress;
  legacyMigrationResult: LegacyMigrationResult;
  fileDecryptProgress: FileDecryptProgress;
};

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => mockAuthValue,
}));

const setLocationSpy = vi.fn();
vi.mock("@/lib/hashLocation", () => ({
  useAdaptiveLocation: () => ["/", setLocationSpy] as [string, (to: string) => void],
}));

const countUnrecoveredLegacyRowsSpy = vi.fn();
vi.mock("@/lib/legacy-decrypt", () => ({
  countUnrecoveredLegacyRows: () => countUnrecoveredLegacyRowsSpy(),
}));

function renderWithResult(result: LegacyMigrationResult) {
  mockAuthValue = {
    legacyMigrationProgress: null,
    legacyMigrationResult: result,
    fileDecryptProgress: null,
  };
  return render(<LegacyMigrationOverlay />);
}

function renderWithProgress(progress: LegacyMigrationProgress) {
  mockAuthValue = {
    legacyMigrationProgress: progress,
    legacyMigrationResult: null,
    fileDecryptProgress: null,
  };
  return render(<LegacyMigrationOverlay />);
}

function renderWithFileDecrypt(fileDecryptProgress: FileDecryptProgress) {
  mockAuthValue = {
    legacyMigrationProgress: null,
    legacyMigrationResult: null,
    fileDecryptProgress,
  };
  return render(<LegacyMigrationOverlay />);
}

beforeEach(() => {
  setLocationSpy.mockClear();
  countUnrecoveredLegacyRowsSpy.mockReset();
  mockAuthValue = {
    legacyMigrationProgress: null,
    legacyMigrationResult: null,
    fileDecryptProgress: null,
  };
});

afterEach(() => {
  cleanup();
});

describe("LegacyMigrationOverlay still-locked warning", () => {
  it("shows the still-locked notice and recovery button when stillLocked > 0", () => {
    renderWithResult({ totalDecrypted: 10, totalFailed: 0, stillLocked: 3 });

    expect(screen.getByTestId("notice-still-locked")).toBeTruthy();
    expect(screen.getByTestId("button-open-restore-locked-data")).toBeTruthy();
    expect(
      screen.getByText(/3 records could not be unlocked during login\./i),
    ).toBeTruthy();
  });

  it("uses singular wording when exactly one record stays locked", () => {
    renderWithResult({ totalDecrypted: 5, totalFailed: 0, stillLocked: 1 });

    expect(screen.getByTestId("notice-still-locked")).toBeTruthy();
    expect(
      screen.getByText(/1 record could not be unlocked during login\./i),
    ).toBeTruthy();
  });

  it("hides the misleading 'All records were successfully migrated' line when records remain locked", () => {
    renderWithResult({ totalDecrypted: 10, totalFailed: 0, stillLocked: 2 });

    expect(screen.queryByText(/All records were successfully migrated\./i)).toBeNull();
    expect(screen.getByTestId("notice-still-locked")).toBeTruthy();
  });

  it("covers the verificationFailed branch wording", () => {
    renderWithResult({ totalDecrypted: 8, totalFailed: 0, verificationFailed: true });

    expect(screen.getByTestId("notice-still-locked")).toBeTruthy();
    expect(screen.getByTestId("button-open-restore-locked-data")).toBeTruthy();
    expect(
      screen.getByText(
        /We couldn't confirm that every record was unlocked\. Some records may still be locked\./i,
      ),
    ).toBeTruthy();
    // The exact-count wording must not appear in the verification-failed case.
    expect(screen.queryByText(/could not be unlocked during login\./i)).toBeNull();
  });

  it("shows no notice for a clean migration (stillLocked === 0, verificationFailed false)", () => {
    renderWithResult({ totalDecrypted: 12, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    expect(screen.queryByTestId("notice-still-locked")).toBeNull();
    expect(screen.queryByTestId("button-open-restore-locked-data")).toBeNull();
    expect(screen.getByText(/All records were successfully migrated\./i)).toBeTruthy();
  });

  it("shows no still-locked notice on an unexpected error even if stillLocked is set", () => {
    renderWithResult({ totalDecrypted: 0, totalFailed: 0, unexpectedError: true, stillLocked: 4 });

    expect(screen.queryByTestId("notice-still-locked")).toBeNull();
    expect(
      screen.getByText(/Migration encountered an unexpected error\./i),
    ).toBeTruthy();
  });

  it("hides the overlay when the Continue button is clicked", () => {
    renderWithResult({ totalDecrypted: 12, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    expect(screen.getByTestId("legacy-migration-overlay")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-dismiss-migration"));

    expect(screen.queryByTestId("legacy-migration-overlay")).toBeNull();
  });
});

describe("LegacyMigrationOverlay empty state", () => {
  it("renders nothing when no progress, result or file-decrypt state is present", () => {
    const { container } = render(<LegacyMigrationOverlay />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("legacy-migration-overlay")).toBeNull();
    expect(screen.queryByTestId("file-decrypt-overlay")).toBeNull();
  });

  it("renders nothing after the result overlay is dismissed even while state persists", () => {
    renderWithResult({ totalDecrypted: 12, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    expect(screen.getByTestId("legacy-migration-overlay")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-dismiss-migration"));

    expect(screen.queryByTestId("legacy-migration-overlay")).toBeNull();
    expect(screen.queryByTestId("file-decrypt-overlay")).toBeNull();
  });
});

describe("LegacyMigrationOverlay summary counts", () => {
  it("shows the restored-count line when totalDecrypted > 0", () => {
    renderWithResult({ totalDecrypted: 42, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    expect(screen.getByText(/Successfully restored 42 records\./i)).toBeTruthy();
  });

  it("omits the restored-count line when totalDecrypted === 0", () => {
    renderWithResult({ totalDecrypted: 0, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    expect(screen.queryByText(/Successfully restored/i)).toBeNull();
  });

  it("shows the failed-count line when totalFailed > 0", () => {
    renderWithResult({ totalDecrypted: 0, totalFailed: 7, stillLocked: 0, verificationFailed: false });

    expect(
      screen.getByText(/7 records could not be decrypted and were left unchanged\./i),
    ).toBeTruthy();
  });

  it("omits the failed-count line when totalFailed === 0", () => {
    renderWithResult({ totalDecrypted: 10, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    expect(screen.queryByText(/could not be decrypted and were left unchanged/i)).toBeNull();
  });

  it("shows a 'nothing to restore' fallback when nothing was decrypted or failed", () => {
    renderWithResult({ totalDecrypted: 0, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    // None of the count-gated summary lines apply in this edge case...
    expect(screen.queryByText(/Successfully restored/i)).toBeNull();
    expect(screen.queryByText(/could not be decrypted and were left unchanged/i)).toBeNull();
    expect(screen.queryByText(/All records were successfully migrated\./i)).toBeNull();
    // ...so the fallback message must keep the result screen from being empty.
    expect(screen.getByTestId("text-nothing-to-restore")).toBeTruthy();
    expect(
      screen.getByText(/No records needed restoring — your data is already up to date\./i),
    ).toBeTruthy();
  });

  it("hides the 'nothing to restore' fallback when records still remain locked", () => {
    renderWithResult({ totalDecrypted: 0, totalFailed: 0, stillLocked: 2 });

    expect(screen.queryByTestId("text-nothing-to-restore")).toBeNull();
    expect(screen.getByTestId("notice-still-locked")).toBeTruthy();
  });

  it("hides the 'nothing to restore' fallback once any records were restored", () => {
    renderWithResult({ totalDecrypted: 5, totalFailed: 0, stillLocked: 0, verificationFailed: false });

    expect(screen.queryByTestId("text-nothing-to-restore")).toBeNull();
  });

  it("shows both the restored and failed lines together on a partial success", () => {
    renderWithResult({ totalDecrypted: 15, totalFailed: 4, stillLocked: 0, verificationFailed: false });

    expect(screen.getByText(/Successfully restored 15 records\./i)).toBeTruthy();
    expect(
      screen.getByText(/4 records could not be decrypted and were left unchanged\./i),
    ).toBeTruthy();
    // The "all records migrated" line must not appear when some failed.
    expect(screen.queryByText(/All records were successfully migrated\./i)).toBeNull();
  });
});

describe("LegacyMigrationOverlay migration-progress screen", () => {
  it("shows percent, record counts and table count for a determinate migration", () => {
    renderWithProgress({
      tableName: "records",
      tableIndex: 2,
      tableCount: 5,
      current: 50,
      total: 200,
      failed: 0,
    });

    expect(screen.getByTestId("legacy-migration-overlay")).toBeTruthy();
    expect(screen.getByText(/Migrating Encrypted Data/i)).toBeTruthy();
    expect(screen.getByText(/Restoring plaintext for: records/i)).toBeTruthy();
    // 50 / 200 = 25%
    expect(screen.getByText(/50 \/ 200 records \(25%\)/i)).toBeTruthy();
    // tableIndex + 1 of tableCount
    expect(screen.getByText(/Table 3 of 5/i)).toBeTruthy();
  });

  it("shows the resume-from-previous-session wording when resuming", () => {
    renderWithProgress({
      tableName: "Preparing",
      tableIndex: 3,
      tableCount: 8,
      current: 0,
      total: 0,
      failed: 0,
    });

    expect(
      screen.getByText(/Resuming from previous session \(3 of 8 tables already done\)/i),
    ).toBeTruthy();
  });

  it("does not show resume wording during normal (non-preparing) progress", () => {
    renderWithProgress({
      tableName: "records",
      tableIndex: 3,
      tableCount: 8,
      current: 10,
      total: 100,
      failed: 0,
    });

    expect(screen.queryByText(/Resuming from previous session/i)).toBeNull();
  });

  it("uses the indeterminate 'records processed' wording when total is 0", () => {
    renderWithProgress({
      tableName: "records",
      tableIndex: 0,
      tableCount: 4,
      current: 42,
      total: 0,
      failed: 0,
    });

    expect(screen.getByText(/42 records processed/i)).toBeTruthy();
    expect(screen.queryByText(/records \(\d+%\)/i)).toBeNull();
  });

  it("appends the failed-record count when failures occur", () => {
    renderWithProgress({
      tableName: "records",
      tableIndex: 1,
      tableCount: 4,
      current: 80,
      total: 100,
      failed: 5,
    });

    expect(screen.getByText(/80 \/ 100 records \(80%\) — 5 failed/i)).toBeTruthy();
  });
});

describe("LegacyMigrationOverlay file-decrypt screen", () => {
  it("shows file counts and percent for a determinate file decrypt", () => {
    renderWithFileDecrypt({
      current: 3,
      total: 10,
      decrypted: 3,
      failed: 0,
      skipped: 0,
    });

    expect(screen.getByTestId("file-decrypt-overlay")).toBeTruthy();
    expect(screen.getByText(/Decrypting Attachment Files/i)).toBeTruthy();
    // 3 / 10 = 30%
    expect(screen.getByText(/3 \/ 10 files \(30%\)/i)).toBeTruthy();
  });

  it("shows the decrypted/skipped line and the failed count when failures occur", () => {
    renderWithFileDecrypt({
      current: 10,
      total: 10,
      decrypted: 7,
      failed: 2,
      skipped: 1,
    });

    expect(
      screen.getByText(/7 decrypted, 1 already plain, 2 failed/i),
    ).toBeTruthy();
  });

  it("omits the failed count when no files failed", () => {
    renderWithFileDecrypt({
      current: 10,
      total: 10,
      decrypted: 8,
      failed: 0,
      skipped: 2,
    });

    expect(screen.getByText(/8 decrypted, 2 already plain/i)).toBeTruthy();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it("shows the indeterminate phase wording when total is 0", () => {
    renderWithFileDecrypt({
      current: 0,
      total: 0,
      decrypted: 0,
      failed: 0,
      skipped: 0,
      phase: "Scanning attachments",
    });

    expect(screen.getByTestId("file-decrypt-overlay")).toBeTruthy();
    expect(screen.getByText(/Scanning attachments/i)).toBeTruthy();
    // No determinate "files (NN%)" line in the indeterminate state.
    expect(screen.queryByText(/files \(\d+%\)/i)).toBeNull();
    // The decrypted/skipped line is hidden while nothing has been decrypted yet.
    expect(screen.queryByText(/already plain/i)).toBeNull();
  });

  it("falls back to 'Preparing' wording when total is 0 and no phase is set", () => {
    renderWithFileDecrypt({
      current: 0,
      total: 0,
      decrypted: 0,
      failed: 0,
      skipped: 0,
    });

    expect(screen.getByText(/Preparing/i)).toBeTruthy();
  });
});

describe("LegacyMigrationOverlay preset locked list (stillLocked path)", () => {
  const presetLocked: LockedRecordRef[] = [
    { tableName: "Records", id: 1 },
    { tableName: "Records", id: 5 },
    { tableName: "Tags", id: 3 },
  ];

  it("offers inline list/download controls when lockedRecords are preset", () => {
    renderWithResult({
      totalDecrypted: 10,
      totalFailed: 0,
      stillLocked: 3,
      lockedRecords: presetLocked,
    });

    expect(screen.getByTestId("button-toggle-locked-list")).toBeTruthy();
    expect(screen.getByTestId("button-download-locked-list")).toBeTruthy();
    // The on-demand scan button only appears when there is no preset list.
    expect(screen.queryByTestId("button-scan-locked-list")).toBeNull();
    // The list itself is collapsed until toggled.
    expect(screen.queryByTestId("list-locked-records")).toBeNull();
  });

  it("renders the grouped list (per table, with ids) after toggling it open", async () => {
    renderWithResult({
      totalDecrypted: 10,
      totalFailed: 0,
      stillLocked: 3,
      lockedRecords: presetLocked,
    });

    fireEvent.click(screen.getByTestId("button-toggle-locked-list"));

    expect(screen.getByTestId("list-locked-records")).toBeTruthy();

    const recordsGroup = screen.getByTestId("group-locked-Records");
    expect(recordsGroup.textContent).toContain("Records (2)");
    // Records is the navigable table, so its ids render as clickable navigation
    // buttons (one per id) rather than a comma-joined string.
    expect(screen.getByTestId("button-open-locked-record-1")).toBeTruthy();
    expect(screen.getByTestId("button-open-locked-record-5")).toBeTruthy();

    const tagsGroup = screen.getByTestId("group-locked-Tags");
    expect(tagsGroup.textContent).toContain("Tags (1)");
    expect(tagsGroup.textContent).toContain("#3");
  });

  it("shows the truncation note only when the preset list is flagged truncated", async () => {
    renderWithResult({
      totalDecrypted: 10,
      totalFailed: 0,
      stillLocked: 3,
      lockedRecords: presetLocked,
      lockedRecordsTruncated: true,
    });

    fireEvent.click(screen.getByTestId("button-toggle-locked-list"));

    expect(screen.getByTestId("text-locked-truncated")).toBeTruthy();
  });

  it("omits the truncation note when the preset list is complete", async () => {
    renderWithResult({
      totalDecrypted: 10,
      totalFailed: 0,
      stillLocked: 3,
      lockedRecords: presetLocked,
      lockedRecordsTruncated: false,
    });

    fireEvent.click(screen.getByTestId("button-toggle-locked-list"));

    expect(screen.queryByTestId("text-locked-truncated")).toBeNull();
  });
});

describe("LegacyMigrationOverlay on-demand scan (verificationFailed path)", () => {
  it("offers the scan button (not inline controls) when no list was preset", () => {
    renderWithResult({ totalDecrypted: 8, totalFailed: 0, verificationFailed: true });

    expect(screen.getByTestId("button-scan-locked-list")).toBeTruthy();
    expect(screen.queryByTestId("button-toggle-locked-list")).toBeNull();
    expect(screen.queryByTestId("button-download-locked-list")).toBeNull();
  });

  it("runs the scan, then renders the grouped list it returns", async () => {
    countUnrecoveredLegacyRowsSpy.mockResolvedValue({
      totalUnrecovered: 2,
      perTable: [],
      lockedRecords: [
        { tableName: "Owners", id: 4 },
        { tableName: "Owners", id: 9 },
      ],
      lockedRecordsTruncated: false,
    });

    renderWithResult({ totalDecrypted: 8, totalFailed: 0, verificationFailed: true });

    fireEvent.click(screen.getByTestId("button-scan-locked-list"));

    await waitFor(() => {
      expect(screen.getByTestId("list-locked-records")).toBeTruthy();
    });
    expect(countUnrecoveredLegacyRowsSpy).toHaveBeenCalledTimes(1);

    const ownersGroup = screen.getByTestId("group-locked-Owners");
    expect(ownersGroup.textContent).toContain("Owners (2)");
    expect(ownersGroup.textContent).toContain("#4, #9");

    // After a successful scan, download becomes available.
    expect(screen.getByTestId("button-download-locked-list")).toBeTruthy();
  });

  it("surfaces the empty-scan message when the re-scan finds nothing", async () => {
    countUnrecoveredLegacyRowsSpy.mockResolvedValue({
      totalUnrecovered: 0,
      perTable: [],
      lockedRecords: [],
      lockedRecordsTruncated: false,
    });

    renderWithResult({ totalDecrypted: 8, totalFailed: 0, verificationFailed: true });

    fireEvent.click(screen.getByTestId("button-scan-locked-list"));

    await waitFor(() => {
      expect(screen.getByTestId("text-scan-empty")).toBeTruthy();
    });
    expect(screen.queryByTestId("list-locked-records")).toBeNull();
  });

  it("surfaces the scan-failed message when the re-scan throws", async () => {
    countUnrecoveredLegacyRowsSpy.mockRejectedValue(new Error("scan-boom"));

    renderWithResult({ totalDecrypted: 8, totalFailed: 0, verificationFailed: true });

    fireEvent.click(screen.getByTestId("button-scan-locked-list"));

    await waitFor(() => {
      expect(screen.getByTestId("text-scan-failed")).toBeTruthy();
    });
    expect(screen.queryByTestId("list-locked-records")).toBeNull();
  });
});

describe("LegacyMigrationOverlay download", () => {
  it("builds the expected tab-separated text content and triggers a download", async () => {

    // Capture the Blob handed to URL.createObjectURL so we can read its text.
    let capturedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock-url";
    });
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      renderWithResult({
        totalDecrypted: 10,
        totalFailed: 0,
        stillLocked: 3,
        lockedRecords: [
          { tableName: "Records", id: 1 },
          { tableName: "Records", id: 5 },
          { tableName: "Tags", id: 3 },
        ],
      });

      fireEvent.click(screen.getByTestId("button-download-locked-list"));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
      expect(capturedBlob).not.toBeNull();
      expect(capturedBlob!.type).toBe("text/plain");

      const text = await capturedBlob!.text();
      const lines = text.split("\n");
      expect(lines[0]).toBe("KYUTXO — Records still locked after migration");
      expect(lines[1]).toMatch(/^Generated: /);
      expect(lines[2]).toBe("Total listed: 3");
      expect(lines[3]).toBe("");
      expect(lines[4]).toBe("Table\tRecord ID");
      expect(lines.slice(5)).toEqual([
        "Records\t1",
        "Records\t5",
        "Tags\t3",
      ]);
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("notes truncation in the download header when the list is truncated", async () => {

    let capturedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock-url";
    });
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      renderWithResult({
        totalDecrypted: 10,
        totalFailed: 0,
        stillLocked: 3,
        lockedRecords: [{ tableName: "Records", id: 1 }],
        lockedRecordsTruncated: true,
      });

      fireEvent.click(screen.getByTestId("button-download-locked-list"));

      const text = await capturedBlob!.text();
      expect(text.split("\n")[2]).toBe(
        "Total listed: 1 (list truncated; more records are locked than shown)",
      );
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
