// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LegacyMigrationOverlay } from "./LegacyMigrationOverlay";

// ---------------------------------------------------------------------------
// LegacyMigrationOverlay only depends on the auth context (for the migration
// result/progress) and the router hook (for navigating to the recovery panel).
// We mock both so we can drive the overlay purely from a synthetic
// legacyMigrationResult and assert on the "still locked" warning UI.
// ---------------------------------------------------------------------------

type LegacyMigrationResult = {
  totalDecrypted: number;
  totalFailed: number;
  unexpectedError?: boolean;
  stillLocked?: number;
  verificationFailed?: boolean;
} | null;

let mockAuthValue: {
  legacyMigrationProgress: unknown;
  legacyMigrationResult: LegacyMigrationResult;
  fileDecryptProgress: unknown;
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
});
