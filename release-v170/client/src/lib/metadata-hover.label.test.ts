// @vitest-environment node
//
// The hover tooltip recently grew a "Label" row at the top (getHoverLabel),
// and that same change taught hasHoverMetadata to treat a non-blank, non
// "Unlabeled" label as real metadata. That branch drives the orange FileText
// indicator next to addresses/txids, so a label-only record must now flag the
// indicator — but ONLY while the "Label" hover toggle is on. These unit tests
// pin the label/no-label decision across the four states that matter:
//   - a real label set            -> label returned, counts as metadata
//   - label === "Unlabeled"       -> treated as blank (no label, no metadata)
//   - label blank/undefined       -> no label, no metadata
//   - showLabel toggle off        -> label suppressed even when set
import { describe, it, expect } from "vitest";
import { getHoverLabel, hasHoverMetadata } from "./metadata-hover";
import type { Record as DbRecord } from "./database";

// Build a bare record with no metadata except whatever is overridden. The
// hover helpers only read a handful of fields, so the cast is safe here.
function makeRecord(overrides: Partial<DbRecord> = {}): DbRecord {
  return {
    type: "address",
    inputString: "bc1qexampleexampleexampleexampleexampleex",
    inputStringLower: "bc1qexampleexampleexampleexampleexampleex",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as DbRecord;
}

describe("getHoverLabel", () => {
  it("returns the label when it is a real, non-blank value", () => {
    const record = makeRecord({ label: "Cold Storage" });
    expect(getHoverLabel(record)).toBe("Cold Storage");
  });

  it('treats the placeholder "Unlabeled" label as blank', () => {
    const record = makeRecord({ label: "Unlabeled" });
    expect(getHoverLabel(record)).toBeNull();
  });

  it("returns null when the label is blank or undefined", () => {
    expect(getHoverLabel(makeRecord({ label: "" }))).toBeNull();
    expect(getHoverLabel(makeRecord({ label: undefined }))).toBeNull();
  });

  it("returns null when the Label toggle is off, even with a real label", () => {
    const record = makeRecord({ label: "Cold Storage" });
    expect(getHoverLabel(record, { showLabel: false })).toBeNull();
  });
});

describe("hasHoverMetadata for label-only records", () => {
  it("counts a label-only record as having metadata", () => {
    const record = makeRecord({ label: "Cold Storage" });
    expect(hasHoverMetadata(record)).toBe(true);
  });

  it('does not count an "Unlabeled" label-only record as metadata', () => {
    const record = makeRecord({ label: "Unlabeled" });
    expect(hasHoverMetadata(record)).toBe(false);
  });

  it("does not count a blank-label record with no other fields as metadata", () => {
    expect(hasHoverMetadata(makeRecord({ label: "" }))).toBe(false);
    expect(hasHoverMetadata(makeRecord({ label: undefined }))).toBe(false);
  });

  it("does not count a label-only record as metadata when the Label toggle is off", () => {
    const record = makeRecord({ label: "Cold Storage" });
    expect(hasHoverMetadata(record, { showLabel: false })).toBe(false);
  });

  it("still counts other metadata when the Label toggle is off", () => {
    const record = makeRecord({ label: "Cold Storage", walletName: "Trezor" });
    expect(hasHoverMetadata(record, { showLabel: false })).toBe(true);
  });
});
