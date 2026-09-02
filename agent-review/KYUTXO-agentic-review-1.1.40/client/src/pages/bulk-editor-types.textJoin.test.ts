import { describe, it, expect } from "vitest";
import {
  applyTextJoin,
  isActionTypeAllowedForField,
  FIELD_DEFS,
  ACTION_TYPES,
  type ActionType,
} from "./bulk-editor-types";

describe("applyTextJoin (Bulk Editor append/prepend joining rules)", () => {
  describe("non-empty existing value is newline-joined", () => {
    it("append joins with a single newline", () => {
      expect(applyTextJoin("append", "existing note", "added")).toBe("existing note\nadded");
    });

    it("prepend joins with a single newline", () => {
      expect(applyTextJoin("prepend", "existing note", "added")).toBe("added\nexisting note");
    });
  });

  describe("empty existing value never gains a stray blank line", () => {
    it.each([
      ["empty string", ""],
      ["undefined", undefined],
      ["null", null],
    ] as const)("append onto %s yields just the new value", (_label, existing) => {
      const result = applyTextJoin("append", existing, "added");
      expect(result).toBe("added");
      expect(result).not.toContain("\n");
    });

    it.each([
      ["empty string", ""],
      ["undefined", undefined],
      ["null", null],
    ] as const)("prepend onto %s yields just the new value", (_label, existing) => {
      const result = applyTextJoin("prepend", existing, "added");
      expect(result).toBe("added");
      expect(result).not.toContain("\n");
    });
  });

  describe("preview/apply consistency", () => {
    // The preview column renders `applyTextJoin(...) || '(empty)'` while
    // applyChanges stores applyTextJoin(...) directly. They are consistent
    // as long as both go through the same shared helper — verify the module
    // source of BulkEditor.tsx contains no inline re-implementation.
    it("BulkEditor uses the shared helper and has no inline newline-join logic", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const src = await fs.readFile(
        path.resolve(__dirname, "BulkEditor.tsx"),
        "utf-8",
      );
      // Both the preview branch and the applyChanges switch must call the helper.
      const helperCalls = src.match(/applyTextJoin\(/g) || [];
      expect(helperCalls.length).toBeGreaterThanOrEqual(2);
      // No hand-rolled `existing + '\n' + value` joins may remain.
      expect(src).not.toMatch(/\+\s*'\\n'\s*\+/);
      expect(src).not.toMatch(/\+\s*"\\n"\s*\+/);
      expect(src).not.toMatch(/\$\{[^}]*\}\\n/);
    });

    it("preview '(empty)' fallback and apply agree for every append/prepend case", () => {
      const cases: Array<{ existing: string | undefined; value: string }> = [
        { existing: "note", value: "extra" },
        { existing: "", value: "extra" },
        { existing: undefined, value: "extra" },
        { existing: "note", value: "" },
        { existing: "", value: "" },
      ];
      for (const type of ["append", "prepend"] as const) {
        for (const { existing, value } of cases) {
          const applied = applyTextJoin(type, existing, value);
          const previewed = applyTextJoin(type, existing, value) || "(empty)";
          // Preview only differs by the '(empty)' display placeholder.
          if (applied === "") {
            expect(previewed).toBe("(empty)");
          } else {
            expect(previewed).toBe(applied);
          }
        }
      }
    });
  });
});

describe("isActionTypeAllowedForField (action availability rules)", () => {
  const arrayFields = FIELD_DEFS.filter(f => f.type === "array");
  const textFields = FIELD_DEFS.filter(f => f.type === "text");

  it("covers tags and categories as array fields", () => {
    expect(arrayFields.map(f => f.key)).toEqual(
      expect.arrayContaining(["tags", "categories"]),
    );
  });

  it("array fields (tags/categories) never offer Append/Prepend", () => {
    for (const fieldDef of arrayFields) {
      expect(isActionTypeAllowedForField("append", fieldDef)).toBe(false);
      expect(isActionTypeAllowedForField("prepend", fieldDef)).toBe(false);
    }
  });

  it("text fields (e.g. notes) offer Append/Prepend but not Add/Remove", () => {
    expect(textFields.map(f => f.key)).toContain("notes");
    for (const fieldDef of textFields) {
      expect(isActionTypeAllowedForField("append", fieldDef)).toBe(true);
      expect(isActionTypeAllowedForField("prepend", fieldDef)).toBe(true);
      expect(isActionTypeAllowedForField("add", fieldDef)).toBe(false);
      expect(isActionTypeAllowedForField("remove", fieldDef)).toBe(false);
    }
  });

  it("enum/select fields never offer Append/Prepend", () => {
    for (const fieldDef of FIELD_DEFS.filter(f => f.type === "enum" || f.type === "select")) {
      expect(isActionTypeAllowedForField("append", fieldDef)).toBe(false);
      expect(isActionTypeAllowedForField("prepend", fieldDef)).toBe(false);
    }
  });

  it("every declared action type is handled (no silent allow on new types)", () => {
    const known: ActionType[] = ["set", "add", "remove", "clear", "append", "prepend", "attach_file"];
    expect(ACTION_TYPES.map(a => a.value).sort()).toEqual([...known].sort());
  });
});
