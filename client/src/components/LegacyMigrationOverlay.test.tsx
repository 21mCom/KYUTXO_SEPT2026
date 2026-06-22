// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LegacyMigrationOverlay } from "./LegacyMigrationOverlay";

// ---------------------------------------------------------------------------
// LegacyMigrationOverlay only depends on the auth context (for the migration
// result/progress) and the router hook (for navigating to the recovery panel).
// We mock both so we can drive the overlay purely from synthetic auth state and
// assert on the "still locked" warning UI, the live migration-progress screen,
// and the file-decryption screen.
// ---------------------------------------------------------------------------

type LegacyMigrationResult = {
  totalDecrypted: number;
  totalFailed: number;
  unexpectedError?: boolean;
  stillLocked?: number;
  verificationFailed?: boolean;
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
