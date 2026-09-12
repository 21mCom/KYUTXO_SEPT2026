// Unit tests for the conflict-detection semantics (Task #1722).
//
// The old heuristic treated a conflict as "resolved" whenever the record's
// active value matched ANY origin value. Every merge keeps either the
// existing or the incoming value active, so genuine disagreements between
// two sources were auto-hidden. The new semantics: a singular field is in
// conflict whenever >=2 origins carry distinct non-empty values AND no
// explicit resolution covers it; a newer origin with a different value
// re-opens a resolved conflict.

import { describe, it, expect } from "vitest";
import {
  detectSingularFieldConflicts,
  hasAnyConflicts,
  getConflictCount,
  withFieldResolution,
  type ConflictRecordFields,
} from "./conflict-detection";
import type { RecordOrigin } from "./database";

let nextOriginId = 1;

function origin(
  fields: Partial<RecordOrigin> & { createdAt: number }
): RecordOrigin {
  return {
    id: nextOriginId++,
    recordId: 1,
    originType: "manual",
    ...fields,
  } as RecordOrigin;
}

const T0 = 1_000_000;
const T1 = 2_000_000;
const T2 = 3_000_000;

describe("detectSingularFieldConflicts — merge outcomes surface", () => {
  it("flags a conflict even when the active value matches one origin (kept-value merge)", () => {
    // Baseline says Alice, a later import said Bob, merge kept Alice active.
    // The old heuristic hid this; it must now surface.
    const record: ConflictRecordFields = { owner: "Alice" };
    const origins = [
      origin({ owner: "Alice", createdAt: T0 }),
      origin({ owner: "Bob", originType: "xpub-derived", createdAt: T1 }),
    ];

    const conflicts = detectSingularFieldConflicts(record, origins);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field.key).toBe("owner");
    expect(conflicts[0].activeValue).toBe("Alice");
    expect(conflicts[0].originValues.map((ov) => ov.value)).toEqual([
      "Bob",
      "Alice",
    ]);
  });

  it("flags a conflict when the merge kept the INCOMING value active too", () => {
    const record: ConflictRecordFields = { owner: "Bob" };
    const origins = [
      origin({ owner: "Alice", createdAt: T0 }),
      origin({ owner: "Bob", createdAt: T1 }),
    ];
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(1);
  });

  it("does not flag when all origins agree", () => {
    const record: ConflictRecordFields = { owner: "Alice" };
    const origins = [
      origin({ owner: "Alice", createdAt: T0 }),
      origin({ owner: "Alice", createdAt: T1 }),
    ];
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(0);
  });

  it("ignores empty and whitespace-only origin values", () => {
    const record: ConflictRecordFields = { owner: "Alice" };
    const origins = [
      origin({ owner: "Alice", createdAt: T0 }),
      origin({ owner: "   ", createdAt: T1 }),
      origin({ createdAt: T1 }),
    ];
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(0);
  });

  it("treats values equal after trimming as the same value", () => {
    const record: ConflictRecordFields = { owner: "Alice" };
    const origins = [
      origin({ owner: "Alice", createdAt: T0 }),
      origin({ owner: "  Alice  ", createdAt: T1 }),
    ];
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(0);
  });

  it("detects conflicts independently per field", () => {
    const record: ConflictRecordFields = { owner: "Alice", walletName: "Vault" };
    const origins = [
      origin({ owner: "Alice", walletName: "Vault", createdAt: T0 }),
      origin({ owner: "Bob", walletName: "Vault", createdAt: T1 }),
    ];
    const conflicts = detectSingularFieldConflicts(record, origins);
    expect(conflicts.map((c) => c.field.key)).toEqual(["owner"]);
  });

  it("counts one conflict per differing field across all six singular fields", () => {
    const record: ConflictRecordFields = {};
    const origins = [
      origin({
        label: "A",
        owner: "A",
        seedName: "A",
        walletName: "A",
        walletSoftware: "A",
        privateKeyStatus: "secured",
        createdAt: T0,
      }),
      origin({
        label: "B",
        owner: "B",
        seedName: "B",
        walletName: "B",
        walletSoftware: "B",
        privateKeyStatus: "unknown",
        createdAt: T1,
      }),
    ];
    expect(getConflictCount(record, origins)).toBe(6);
    expect(hasAnyConflicts(record, origins)).toBe(true);
  });

  it("returns nothing for a single origin", () => {
    const record: ConflictRecordFields = { owner: "Alice" };
    expect(
      detectSingularFieldConflicts(record, [origin({ owner: "Bob", createdAt: T0 })])
    ).toHaveLength(0);
  });
});

describe("detectSingularFieldConflicts — explicit resolutions", () => {
  const disagreeingOrigins = () => [
    origin({ owner: "Alice", createdAt: T0 }),
    origin({ owner: "Bob", createdAt: T1 }),
  ];

  it("hides a conflict once a resolution is recorded (picked value)", () => {
    const record: ConflictRecordFields = {
      owner: "Bob",
      conflictResolutions: { owner: { value: "Bob", resolvedAt: T1 + 1 } },
    };
    expect(detectSingularFieldConflicts(record, disagreeingOrigins())).toHaveLength(0);
  });

  it("hides a conflict resolved by keeping the current value", () => {
    const record: ConflictRecordFields = {
      owner: "Alice",
      conflictResolutions: { owner: { value: "Alice", resolvedAt: T1 + 1 } },
    };
    expect(detectSingularFieldConflicts(record, disagreeingOrigins())).toHaveLength(0);
  });

  it("hides a conflict resolved with a custom third value", () => {
    const record: ConflictRecordFields = {
      owner: "Carol",
      conflictResolutions: { owner: { value: "Carol", resolvedAt: T1 + 1 } },
    };
    expect(detectSingularFieldConflicts(record, disagreeingOrigins())).toHaveLength(0);
  });

  it("re-opens when a NEWER origin introduces a different value after the resolution", () => {
    const record: ConflictRecordFields = {
      owner: "Bob",
      conflictResolutions: { owner: { value: "Bob", resolvedAt: T1 + 1 } },
    };
    const origins = [
      ...disagreeingOrigins(),
      origin({ owner: "Carol", createdAt: T2 }),
    ];
    const conflicts = detectSingularFieldConflicts(record, origins);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].originValues.map((ov) => ov.value)).toEqual([
      "Carol",
      "Bob",
      "Alice",
    ]);
  });

  it("stays hidden when a newer origin re-asserts the resolved value", () => {
    const record: ConflictRecordFields = {
      owner: "Bob",
      conflictResolutions: { owner: { value: "Bob", resolvedAt: T1 + 1 } },
    };
    const origins = [
      ...disagreeingOrigins(),
      origin({ owner: "Bob", createdAt: T2 }),
    ];
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(0);
  });

  it("stays hidden when a newer origin carries no value for the field", () => {
    const record: ConflictRecordFields = {
      owner: "Bob",
      conflictResolutions: { owner: { value: "Bob", resolvedAt: T1 + 1 } },
    };
    const origins = [
      ...disagreeingOrigins(),
      origin({ label: "unrelated", createdAt: T2 }),
    ];
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(0);
  });

  it("ignores origins created BEFORE the resolution even if they differ", () => {
    // Resolving covers everything known at resolve time.
    const record: ConflictRecordFields = {
      owner: "Carol",
      conflictResolutions: { owner: { value: "Carol", resolvedAt: T2 } },
    };
    const origins = [
      ...disagreeingOrigins(),
      origin({ owner: "Dave", createdAt: T1 + 1 }),
    ];
    expect(detectSingularFieldConflicts(record, origins)).toHaveLength(0);
  });

  it("a resolution for one field does not hide another field's conflict", () => {
    const record: ConflictRecordFields = {
      owner: "Bob",
      walletName: "Vault",
      conflictResolutions: { owner: { value: "Bob", resolvedAt: T1 + 1 } },
    };
    const origins = [
      origin({ owner: "Alice", walletName: "Vault", createdAt: T0 }),
      origin({ owner: "Bob", walletName: "Other", createdAt: T1 }),
    ];
    const conflicts = detectSingularFieldConflicts(record, origins);
    expect(conflicts.map((c) => c.field.key)).toEqual(["walletName"]);
  });

  it("an empty-string resolution (kept-empty) is honored and re-opened by a differing newer origin", () => {
    const record: ConflictRecordFields = {
      conflictResolutions: { owner: { value: "", resolvedAt: T1 + 1 } },
    };
    const resolved = [
      origin({ owner: "Alice", createdAt: T0 }),
      origin({ owner: "Bob", createdAt: T1 }),
    ];
    expect(detectSingularFieldConflicts(record, resolved)).toHaveLength(0);

    const reopened = [...resolved, origin({ owner: "Carol", createdAt: T2 })];
    expect(detectSingularFieldConflicts(record, reopened)).toHaveLength(1);
  });
});

describe("withFieldResolution", () => {
  it("adds a trimmed resolution without mutating the existing map", () => {
    const existing = { owner: { value: "Bob", resolvedAt: T0 } };
    const next = withFieldResolution(existing, "walletName", "  Vault  ", T1);
    expect(next.walletName).toEqual({ value: "Vault", resolvedAt: T1 });
    expect(next.owner).toEqual(existing.owner);
    expect(existing).toEqual({ owner: { value: "Bob", resolvedAt: T0 } });
  });

  it("overwrites a prior resolution for the same field and handles undefined maps", () => {
    const first = withFieldResolution(undefined, "owner", "Alice", T0);
    const second = withFieldResolution(first, "owner", "Bob", T1);
    expect(second.owner).toEqual({ value: "Bob", resolvedAt: T1 });
  });
});
