// Regression tests for the Bulk Editor Undo staleness guard (task: prevent
// Undo from silently overwriting edits made after a bulk apply).
//
// partitionUndoSnapshots splits the apply-time snapshots into records still
// safe to restore (their fields still hold exactly what the bulk apply wrote)
// vs records edited or deleted since the apply. BulkEditor.undoChanges only
// writes back the restorable set and surfaces a skip notice for the rest.
import { describe, it, expect } from "vitest";
import type { Record } from "@/lib/database";
import {
  partitionUndoSnapshots,
  undoValuesEquivalent,
  type UndoRecordSnapshot,
} from "./bulk-editor-types";

function rec(id: number, fields: Partial<Record>): Record {
  return {
    id,
    type: "address",
    inputString: `bc1qtest${id}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  } as Record;
}

function mapOf(...records: Record[]): Map<number, Record> {
  return new Map(records.map((r) => [r.id!, r]));
}

describe("partitionUndoSnapshots", () => {
  const snapshots: UndoRecordSnapshot[] = [
    { id: 1, before: { counterpartyName: "Old Co" }, after: { counterpartyName: "New Co" } },
    { id: 2, before: { counterpartyName: "" }, after: { counterpartyName: "New Co" } },
  ];

  it("restores records that still hold exactly what the apply wrote", () => {
    const current = mapOf(
      rec(1, { counterpartyName: "New Co" }),
      rec(2, { counterpartyName: "New Co" }),
    );
    const result = partitionUndoSnapshots(snapshots, current);
    expect(result.restorable.map((s) => s.id)).toEqual([1, 2]);
    expect(result.stale).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("skips a record edited between apply and undo, keeping the rest restorable", () => {
    // Record 2 was manually edited after the bulk apply — Undo must NOT
    // clobber "Manual Edit Co" back to "".
    const current = mapOf(
      rec(1, { counterpartyName: "New Co" }),
      rec(2, { counterpartyName: "Manual Edit Co" }),
    );
    const result = partitionUndoSnapshots(snapshots, current);
    expect(result.restorable.map((s) => s.id)).toEqual([1]);
    expect(result.stale).toEqual([{ id: 2, changedFields: ["counterpartyName"] }]);
    expect(result.missing).toEqual([]);
  });

  it("reports records deleted since the apply as missing", () => {
    const current = mapOf(rec(1, { counterpartyName: "New Co" }));
    const result = partitionUndoSnapshots(snapshots, current);
    expect(result.restorable.map((s) => s.id)).toEqual([1]);
    expect(result.missing).toEqual([2]);
  });

  it("only compares fields the apply touched — unrelated edits stay restorable", () => {
    // The bulk apply only touched counterpartyName; a later label edit must
    // not block the undo of counterpartyName.
    const current = mapOf(
      rec(1, { counterpartyName: "New Co", label: "renamed later" }),
      rec(2, { counterpartyName: "New Co" }),
    );
    const result = partitionUndoSnapshots(snapshots, current);
    expect(result.restorable.map((s) => s.id)).toEqual([1, 2]);
    expect(result.stale).toEqual([]);
  });

  it("detects array-field edits (tags added after a bulk add)", () => {
    const snaps: UndoRecordSnapshot[] = [
      { id: 1, before: { tags: ["a"] }, after: { tags: ["a", "bulk"] } },
      { id: 2, before: { tags: [] }, after: { tags: ["bulk"] } },
    ];
    const current = mapOf(
      rec(1, { tags: ["a", "bulk"] }),
      rec(2, { tags: ["bulk", "user-added"] }),
    );
    const result = partitionUndoSnapshots(snaps, current);
    expect(result.restorable.map((s) => s.id)).toEqual([1]);
    expect(result.stale).toEqual([{ id: 2, changedFields: ["tags"] }]);
  });

  it("lists every changed field when multiple applied fields were edited", () => {
    const snaps: UndoRecordSnapshot[] = [
      {
        id: 1,
        before: { label: "old", notes: "old notes" },
        after: { label: "new", notes: "new notes" },
      },
    ];
    const current = mapOf(rec(1, { label: "edited", notes: "edited notes" }));
    const result = partitionUndoSnapshots(snaps, current);
    expect(result.stale).toEqual([{ id: 1, changedFields: ["label", "notes"] }]);
  });
});

describe("undoValuesEquivalent", () => {
  it("treats undefined, null, and '' as the same empty text value", () => {
    // Real vault rows created without optional fields store UNDEFINED while
    // a Clear action writes '' — those must not look like a user edit.
    expect(undoValuesEquivalent(undefined, "")).toBe(true);
    expect(undoValuesEquivalent(null, "")).toBe(true);
    expect(undoValuesEquivalent(undefined, null)).toBe(true);
    expect(undoValuesEquivalent("", "x")).toBe(false);
  });

  it("compares arrays element-wise and treats undefined as empty array", () => {
    expect(undoValuesEquivalent(["a", "b"], ["a", "b"])).toBe(true);
    expect(undoValuesEquivalent(["a", "b"], ["b", "a"])).toBe(false);
    expect(undoValuesEquivalent(undefined, [])).toBe(true);
    expect(undoValuesEquivalent([], [""])).toBe(false);
  });

  it("distinguishes genuinely different text values", () => {
    expect(undoValuesEquivalent("New Co", "New Co")).toBe(true);
    expect(undoValuesEquivalent("New Co", "Manual Edit Co")).toBe(false);
  });
});
