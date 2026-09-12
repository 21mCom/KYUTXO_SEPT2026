// @vitest-environment node
//
// Tests for the pre-flight export size estimate. An Electron streaming export
// writes the backup straight to disk, so if the disk fills up partway through it
// leaves a truncated, unusable archive. The estimate (attachment file sizes —
// stored uncompressed in the ZIP — plus a per-row allowance for the compressed
// tables) is compared against free space so the user can free space BEFORE any
// partial archive is written.

import { describe, it, expect } from "vitest";
import { estimateExportBytes, EXPORT_BYTES_PER_ROW } from "./export";

describe("estimateExportBytes", () => {
  it("sums attachment bytes and the per-row allowance", () => {
    const bytes = estimateExportBytes({ attachmentBytes: 1000, rowCount: 10 });
    expect(bytes).toBe(1000 + 10 * EXPORT_BYTES_PER_ROW);
  });

  it("is dominated by attachment bytes when there are few rows", () => {
    const bytes = estimateExportBytes({ attachmentBytes: 5_000_000, rowCount: 2 });
    expect(bytes).toBe(5_000_000 + 2 * EXPORT_BYTES_PER_ROW);
  });

  it("returns just the row allowance when there are no attachments", () => {
    const bytes = estimateExportBytes({ attachmentBytes: 0, rowCount: 100 });
    expect(bytes).toBe(100 * EXPORT_BYTES_PER_ROW);
  });

  it("honors a custom per-row allowance", () => {
    const bytes = estimateExportBytes({ attachmentBytes: 0, rowCount: 4, bytesPerRow: 1000 });
    expect(bytes).toBe(4000);
  });

  it("treats negative or NaN attachment bytes as zero", () => {
    expect(estimateExportBytes({ attachmentBytes: -500, rowCount: 0 })).toBe(0);
    expect(estimateExportBytes({ attachmentBytes: Number.NaN, rowCount: 0 })).toBe(0);
  });

  it("treats negative or NaN row counts as zero", () => {
    expect(estimateExportBytes({ attachmentBytes: 100, rowCount: -5 })).toBe(100);
    expect(estimateExportBytes({ attachmentBytes: 100, rowCount: Number.NaN })).toBe(100);
  });

  it("falls back to the default allowance when bytesPerRow is NaN", () => {
    const bytes = estimateExportBytes({ attachmentBytes: 0, rowCount: 3, bytesPerRow: Number.NaN });
    expect(bytes).toBe(3 * EXPORT_BYTES_PER_ROW);
  });

  it("rounds fractional totals up", () => {
    const bytes = estimateExportBytes({ attachmentBytes: 999.4, rowCount: 0 });
    expect(bytes).toBe(1000);
  });
});
