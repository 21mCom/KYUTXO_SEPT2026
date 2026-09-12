// @vitest-environment node
//
// The label-only branch of the hover helpers is already pinned by
// metadata-hover.label.test.ts. This file covers the rest of
// getHoverMetadataFields — every non-label row (Wallet, Owner, Seed,
// Software, Category, Tags, Key Status, Notes) plus the per-field toggles in
// HoverTooltipPrefs. The tooltip silently drops a field if any of these
// branches regress, so each field is pinned across:
//   - populated -> the row is emitted with the expected value
//   - blank/undefined -> no row is emitted
//   - its toggle off -> the row is suppressed even when populated
// On top of that:
//   - "Pending Review"/"Unknown" owner is treated as blank
//   - system tags (containing ":") are excluded unless includeSystemTags is on
//   - the ">5 tags" truncation summary renders ("+N more")
import { describe, it, expect } from "vitest";
import {
  getHoverMetadataFields,
  isSystemTag,
  type HoverMetadataField,
} from "./metadata-hover";
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

// Convenience: pull the value of a named field row, or undefined if absent.
function fieldValue(fields: HoverMetadataField[], label: string): string | undefined {
  return fields.find((f) => f.label === label)?.value;
}

describe("getHoverMetadataFields - Wallet", () => {
  it("emits the Wallet row when walletName is set", () => {
    const fields = getHoverMetadataFields(makeRecord({ walletName: "Trezor" }));
    expect(fieldValue(fields, "Wallet")).toBe("Trezor");
  });

  it("omits the Wallet row when walletName is blank or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ walletName: "" })), "Wallet")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ walletName: undefined })), "Wallet")).toBeUndefined();
  });

  it("suppresses the Wallet row when showWalletName is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ walletName: "Trezor" }), { showWalletName: false });
    expect(fieldValue(fields, "Wallet")).toBeUndefined();
  });
});

describe("getHoverMetadataFields - Owner", () => {
  it("emits the Owner row when owner is a real value", () => {
    const fields = getHoverMetadataFields(makeRecord({ owner: "Alice" }));
    expect(fieldValue(fields, "Owner")).toBe("Alice");
  });

  it('treats "Pending Review" owner as blank', () => {
    const fields = getHoverMetadataFields(makeRecord({ owner: "Pending Review" }));
    expect(fieldValue(fields, "Owner")).toBeUndefined();
  });

  it('treats "Unknown" owner as blank', () => {
    const fields = getHoverMetadataFields(makeRecord({ owner: "Unknown" }));
    expect(fieldValue(fields, "Owner")).toBeUndefined();
  });

  it("omits the Owner row when owner is blank or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ owner: "" })), "Owner")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ owner: undefined })), "Owner")).toBeUndefined();
  });

  it("suppresses the Owner row when showOwner is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ owner: "Alice" }), { showOwner: false });
    expect(fieldValue(fields, "Owner")).toBeUndefined();
  });
});

describe("getHoverMetadataFields - Seed", () => {
  it("emits the Seed row when seedName is set", () => {
    const fields = getHoverMetadataFields(makeRecord({ seedName: "Vault Seed" }));
    expect(fieldValue(fields, "Seed")).toBe("Vault Seed");
  });

  it("omits the Seed row when seedName is blank or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ seedName: "" })), "Seed")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ seedName: undefined })), "Seed")).toBeUndefined();
  });

  it("suppresses the Seed row when showSeedName is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ seedName: "Vault Seed" }), { showSeedName: false });
    expect(fieldValue(fields, "Seed")).toBeUndefined();
  });
});

describe("getHoverMetadataFields - Software", () => {
  it("emits the Software row when walletSoftware is set", () => {
    const fields = getHoverMetadataFields(makeRecord({ walletSoftware: "Sparrow" }));
    expect(fieldValue(fields, "Software")).toBe("Sparrow");
  });

  it("omits the Software row when walletSoftware is blank or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ walletSoftware: "" })), "Software")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ walletSoftware: undefined })), "Software")).toBeUndefined();
  });

  it("suppresses the Software row when showSoftware is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ walletSoftware: "Sparrow" }), { showSoftware: false });
    expect(fieldValue(fields, "Software")).toBeUndefined();
  });
});

describe("getHoverMetadataFields - Category", () => {
  it("emits the Category row joined by comma when categories are set", () => {
    const fields = getHoverMetadataFields(makeRecord({ categories: ["Exchange", "Hot Wallet"] }));
    expect(fieldValue(fields, "Category")).toBe("Exchange, Hot Wallet");
  });

  it("omits the Category row when categories is empty or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ categories: [] })), "Category")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ categories: undefined })), "Category")).toBeUndefined();
  });

  it("suppresses the Category row when showCategory is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ categories: ["Exchange"] }), { showCategory: false });
    expect(fieldValue(fields, "Category")).toBeUndefined();
  });
});

describe("getHoverMetadataFields - Tags", () => {
  it("emits the Tags row joined by comma for user tags", () => {
    const fields = getHoverMetadataFields(makeRecord({ tags: ["kyc", "donation"] }));
    expect(fieldValue(fields, "Tags")).toBe("kyc, donation");
  });

  it("omits the Tags row when tags is empty or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ tags: [] })), "Tags")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ tags: undefined })), "Tags")).toBeUndefined();
  });

  it("suppresses the Tags row when showTags is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ tags: ["kyc"] }), { showTags: false });
    expect(fieldValue(fields, "Tags")).toBeUndefined();
  });

  it("excludes system tags (containing ':') by default", () => {
    const fields = getHoverMetadataFields(makeRecord({ tags: ["kyc", "source:blockchain", "donation"] }));
    expect(fieldValue(fields, "Tags")).toBe("kyc, donation");
  });

  it("omits the Tags row entirely when only system tags are present", () => {
    const fields = getHoverMetadataFields(makeRecord({ tags: ["source:blockchain", "origin:sync"] }));
    expect(fieldValue(fields, "Tags")).toBeUndefined();
  });

  it("includes system tags when includeSystemTags is on", () => {
    const fields = getHoverMetadataFields(
      makeRecord({ tags: ["kyc", "source:blockchain"] }),
      { includeSystemTags: true }
    );
    expect(fieldValue(fields, "Tags")).toBe("kyc, source:blockchain");
  });

  it("truncates to 5 tags with a '+N more' summary when over 5", () => {
    const fields = getHoverMetadataFields(
      makeRecord({ tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7"] })
    );
    expect(fieldValue(fields, "Tags")).toBe("t1, t2, t3, t4, t5 +2 more");
  });

  it("does not truncate when exactly 5 user tags are present", () => {
    const fields = getHoverMetadataFields(
      makeRecord({ tags: ["t1", "t2", "t3", "t4", "t5"] })
    );
    expect(fieldValue(fields, "Tags")).toBe("t1, t2, t3, t4, t5");
  });

  it("counts only user tags toward the truncation when system tags are filtered out", () => {
    const fields = getHoverMetadataFields(
      makeRecord({ tags: ["t1", "t2", "t3", "t4", "t5", "sys:a", "sys:b"] })
    );
    expect(fieldValue(fields, "Tags")).toBe("t1, t2, t3, t4, t5");
  });
});

describe("getHoverMetadataFields - Key Status", () => {
  it("emits the Key Status row when privateKeyStatus is set", () => {
    const fields = getHoverMetadataFields(makeRecord({ privateKeyStatus: "Held" }));
    expect(fieldValue(fields, "Key Status")).toBe("Held");
  });

  it("omits the Key Status row when privateKeyStatus is blank or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ privateKeyStatus: "" })), "Key Status")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ privateKeyStatus: undefined })), "Key Status")).toBeUndefined();
  });

  it("suppresses the Key Status row when showPrivateKeyStatus is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ privateKeyStatus: "Held" }), { showPrivateKeyStatus: false });
    expect(fieldValue(fields, "Key Status")).toBeUndefined();
  });
});

describe("getHoverMetadataFields - Notes", () => {
  it("emits the Notes row when notes is set", () => {
    const fields = getHoverMetadataFields(makeRecord({ notes: "Cold storage backup" }));
    expect(fieldValue(fields, "Notes")).toBe("Cold storage backup");
  });

  it("omits the Notes row when notes is blank or undefined", () => {
    expect(fieldValue(getHoverMetadataFields(makeRecord({ notes: "" })), "Notes")).toBeUndefined();
    expect(fieldValue(getHoverMetadataFields(makeRecord({ notes: undefined })), "Notes")).toBeUndefined();
  });

  it("suppresses the Notes row when showNotes is off", () => {
    const fields = getHoverMetadataFields(makeRecord({ notes: "Cold storage backup" }), { showNotes: false });
    expect(fieldValue(fields, "Notes")).toBeUndefined();
  });

  it("clips notes longer than 120 chars with an ellipsis", () => {
    const longNote = "a".repeat(200);
    const value = fieldValue(getHoverMetadataFields(makeRecord({ notes: longNote })), "Notes");
    expect(value).toBe("a".repeat(120) + "\u2026");
  });

  it("leaves notes of exactly 120 chars unclipped", () => {
    const note = "a".repeat(120);
    const value = fieldValue(getHoverMetadataFields(makeRecord({ notes: note })), "Notes");
    expect(value).toBe(note);
  });
});

describe("getHoverMetadataFields - field ordering and combinations", () => {
  it("emits every field in the documented order when all are populated", () => {
    const fields = getHoverMetadataFields(
      makeRecord({
        walletName: "Trezor",
        owner: "Alice",
        seedName: "Vault Seed",
        walletSoftware: "Sparrow",
        categories: ["Exchange"],
        tags: ["kyc"],
        privateKeyStatus: "Held",
        notes: "note",
      })
    );
    expect(fields.map((f) => f.label)).toEqual([
      "Wallet",
      "Owner",
      "Seed",
      "Software",
      "Category",
      "Tags",
      "Key Status",
      "Notes",
    ]);
  });

  it("returns an empty list for a record with no metadata", () => {
    expect(getHoverMetadataFields(makeRecord())).toEqual([]);
  });

  it("turning one toggle off does not drop the other rows", () => {
    const record = makeRecord({ walletName: "Trezor", owner: "Alice", seedName: "Vault Seed" });
    const fields = getHoverMetadataFields(record, { showOwner: false });
    expect(fields.map((f) => f.label)).toEqual(["Wallet", "Seed"]);
  });
});

describe("isSystemTag", () => {
  it("flags tags containing a colon as system tags", () => {
    expect(isSystemTag("source:blockchain")).toBe(true);
  });

  it("treats plain tags as user tags", () => {
    expect(isSystemTag("donation")).toBe(false);
  });
});
