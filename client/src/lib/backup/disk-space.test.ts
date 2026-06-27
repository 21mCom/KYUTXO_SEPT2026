// @vitest-environment node
//
// Tests for the pre-flight disk-space check that runs BEFORE a restore's
// destructive clear. The point is to let a user free space without losing their
// current vault, instead of discovering a disk-full failure only after the vault
// has already been wiped. The estimate is the v3 manifest's recorded
// `totalAttachmentBytes` (the exact bytes a restore writes, since attachment
// files are stored uncompressed), falling back to the backup file's own size for
// older backups that lack the field (a safe upper bound). evaluateDiskSpace
// itself is estimate-source-agnostic: it just pads and compares the given bytes.

import { describe, it, expect } from "vitest";
import { evaluateDiskSpace } from "./restore";

describe("evaluateDiskSpace", () => {
  it("is sufficient when free space exceeds the padded estimate", () => {
    const r = evaluateDiskSpace(1000, 2000);
    expect(r.estimatedBytes).toBe(1000);
    expect(r.requiredBytes).toBe(1100); // 1000 * 1.1
    expect(r.freeBytes).toBe(2000);
    expect(r.sufficient).toBe(true);
  });

  it("is insufficient when free space is below the padded estimate", () => {
    const r = evaluateDiskSpace(1000, 1050);
    expect(r.requiredBytes).toBe(1100);
    expect(r.sufficient).toBe(false);
  });

  it("applies the safety factor so a bare-fit backup is still rejected", () => {
    // Exactly enough for the raw estimate, but not for the padded requirement.
    const r = evaluateDiskSpace(1000, 1000);
    expect(r.sufficient).toBe(false);
  });

  it("passes when free space exactly meets the padded requirement", () => {
    const r = evaluateDiskSpace(1000, 1100);
    expect(r.sufficient).toBe(true);
  });

  it("honors a custom safety factor", () => {
    const r = evaluateDiskSpace(1000, 1200, 1.25);
    expect(r.requiredBytes).toBe(1250);
    expect(r.sufficient).toBe(false);
  });

  it("treats a negative or NaN estimate as zero (never blocks spuriously)", () => {
    expect(evaluateDiskSpace(-500, 0).sufficient).toBe(true);
    expect(evaluateDiskSpace(Number.NaN, 0).estimatedBytes).toBe(0);
  });

  it("rounds fractional byte estimates up", () => {
    const r = evaluateDiskSpace(999.4, 0);
    expect(r.estimatedBytes).toBe(1000);
  });
});
