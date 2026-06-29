// Contract test for `toPanelRecord` (client/src/lib/recordToPanel.ts).
//
// The detail panel, the records list, and ClickableAddress all derive their
// data from this one shared converter. It deliberately uses a spread so any
// NEW field added to the DB `Record` type flows through automatically — this is
// what fixed the "Synced — No Activity" badge bug, where hand-copied field
// lists silently dropped newly added fields.
//
// These tests guard that contract so a future refactor that reintroduces
// per-field copying fails loudly instead of silently dropping a field:
//   - `fullRecord` is typed `Required<DbRecord>`, so adding a new field to the
//     `Record` schema without populating it here is a COMPILE error — an early
//     warning at the point of change.
//   - The runtime assertions then prove every key on that representative full
//     record survives the conversion (key-set comparison), values are
//     preserved, `id` is stringified, and the required display fields fall back
//     to their defaults.

import { describe, it, expect } from "vitest";
import type { Record as DbRecord } from "@/lib/database";
import { toPanelRecord } from "@/lib/recordToPanel";
import { fullRecord } from "@/test/fullRecordFixture";

// `fullRecord` is the shared `Required<DbRecord>` fixture (see
// client/src/test/fullRecordFixture.ts). Reusing it here keeps the converter
// contract and the per-consumer wiring tests in lockstep: a newly added schema
// field has to be populated in one place to satisfy all of them.

describe("toPanelRecord", () => {
  it("carries through every field on a full DB record (no silent drops)", () => {
    const panel = toPanelRecord(fullRecord);

    // The panel shape is the DB record with `id` stringified — so the key set
    // must match exactly. If a refactor reintroduces per-field copying and
    // forgets a field, this comparison fails. (Combined with the `Required`
    // type on `fullRecord`, newly added schema fields are also covered.)
    expect(new Set(Object.keys(panel))).toEqual(new Set(Object.keys(fullRecord)));
  });

  it("preserves the value of every non-display field unchanged", () => {
    const panel = toPanelRecord(fullRecord);

    // Every key except the four normalized display fields (and `id`, which is
    // stringified) must be carried through with its original value.
    const normalized = new Set(["id", "inputString", "label", "tags", "categories"]);
    for (const key of Object.keys(fullRecord) as (keyof DbRecord)[]) {
      if (normalized.has(key)) continue;
      expect(panel[key]).toEqual(fullRecord[key]);
    }
  });

  it("stringifies the id", () => {
    const panel = toPanelRecord(fullRecord);
    expect(panel.id).toBe("42");
    expect(typeof panel.id).toBe("string");
  });

  it("passes through the populated display fields untouched", () => {
    const panel = toPanelRecord(fullRecord);
    expect(panel.inputString).toBe(fullRecord.inputString);
    expect(panel.label).toBe(fullRecord.label);
    expect(panel.tags).toEqual(fullRecord.tags);
    expect(panel.categories).toEqual(fullRecord.categories);
  });

  it("applies defaults for the required display fields when missing/empty", () => {
    // A minimal record with the display fields blank/undefined — exercises the
    // fallback branch so the UI never sees null/undefined there.
    const minimal: DbRecord = {
      type: "transaction",
      inputString: "",
      label: "",
      tags: [],
      categories: [],
      createdAt: 1736800000000,
      updatedAt: 1736800000000,
    };

    const panel = toPanelRecord(minimal);
    expect(panel.inputString).toBe("");
    expect(panel.label).toBe("Unlabeled");
    expect(panel.tags).toEqual([]);
    expect(panel.categories).toEqual([]);
  });

  it("defaults tags/categories to arrays when undefined", () => {
    // Force-cast: simulate an older/partial row missing the array fields
    // entirely, proving the `|| []` fallbacks fire rather than passing through
    // undefined.
    const partial = {
      id: 9,
      type: "address",
      inputString: "bc1qpartial",
      label: undefined,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as DbRecord;

    const panel = toPanelRecord(partial);
    expect(panel.label).toBe("Unlabeled");
    expect(panel.tags).toEqual([]);
    expect(panel.categories).toEqual([]);
    expect(panel.id).toBe("9");
  });
});
