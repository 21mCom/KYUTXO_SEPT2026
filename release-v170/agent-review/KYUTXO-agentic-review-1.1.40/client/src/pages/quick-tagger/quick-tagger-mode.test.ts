// Unit coverage for the Quick Tagger single-mode helpers (Task: "Quick Tagger:
// single-mode input"): entry classification against the active mode, shared
// field visibility per mode, and that apply payloads never carry fields
// belonging to the other mode.

import { describe, it, expect } from "vitest";
import {
  classifyForMode,
  isSharedFieldVisible,
  buildUpdateData,
  buildCreateFields,
  TRANSACTION_HIDDEN_SHARED_FIELDS,
  type MetadataValues,
} from "./quick-tagger-mode";

const FULL_VALUES: MetadataValues = {
  selectedTags: ["t1"],
  selectedCategories: ["c1"],
  owner: "Alice",
  walletName: "Cold Wallet",
  seedName: "Seed A",
  walletSoftware: "Sparrow",
  privateKeyStatus: "has-private-key",
  label: "my label",
  notes: "my notes",
  addressImportance: "high",
  counterpartyType: "exchange",
  flowType: "inflow",
  acquisitionMethod: "purchase",
  dispositionType: "sale",
  costBasisUsd: "123.45",
};

describe("classifyForMode", () => {
  it("matches entries of the active mode's type", () => {
    expect(classifyForMode("address", "address")).toBe("match");
    expect(classifyForMode("transaction", "transaction")).toBe("match");
  });

  it("flags entries of the other type as mismatch, not invalid", () => {
    expect(classifyForMode("transaction", "address")).toBe("mismatch");
    expect(classifyForMode("address", "transaction")).toBe("mismatch");
  });

  it("keeps truly invalid input distinct from mismatches", () => {
    expect(classifyForMode("invalid", "address")).toBe("invalid");
    expect(classifyForMode("invalid", "transaction")).toBe("invalid");
  });
});

describe("isSharedFieldVisible", () => {
  it("shows all shared fields in address mode", () => {
    for (const field of [
      "tags", "categories", "owner", "walletName", "seedName",
      "walletSoftware", "privateKeyStatus", "label", "notes",
    ] as const) {
      expect(isSharedFieldVisible(field, "address")).toBe(true);
    }
  });

  it("hides address-centric shared fields in transaction mode", () => {
    for (const field of TRANSACTION_HIDDEN_SHARED_FIELDS) {
      expect(isSharedFieldVisible(field, "transaction")).toBe(false);
    }
  });

  it("keeps transaction-applicable shared fields visible in transaction mode", () => {
    for (const field of ["tags", "categories", "owner", "label", "notes"] as const) {
      expect(isSharedFieldVisible(field, "transaction")).toBe(true);
    }
  });
});

describe("buildUpdateData", () => {
  it("address mode: includes address fields, never transaction fields", () => {
    const data = buildUpdateData("address", FULL_VALUES);
    expect(data).toMatchObject({
      tags: ["t1"],
      categories: ["c1"],
      owner: "Alice",
      walletName: "Cold Wallet",
      seedName: "Seed A",
      walletSoftware: "Sparrow",
      privateKeyStatus: "has-private-key",
      label: "my label",
      notes: "my notes",
      addressImportance: "high",
      counterpartyType: "exchange",
    });
    expect(data).not.toHaveProperty("flowType");
    expect(data).not.toHaveProperty("acquisitionMethod");
    expect(data).not.toHaveProperty("dispositionType");
    expect(data).not.toHaveProperty("costBasisUsd");
  });

  it("transaction mode: includes transaction fields, never address or address-centric shared fields", () => {
    const data = buildUpdateData("transaction", FULL_VALUES);
    expect(data).toMatchObject({
      tags: ["t1"],
      categories: ["c1"],
      owner: "Alice",
      label: "my label",
      notes: "my notes",
      flowType: "inflow",
      acquisitionMethod: "purchase",
      dispositionType: "sale",
      costBasisUsd: 123.45,
    });
    expect(data).not.toHaveProperty("addressImportance");
    expect(data).not.toHaveProperty("counterpartyType");
    expect(data).not.toHaveProperty("walletName");
    expect(data).not.toHaveProperty("seedName");
    expect(data).not.toHaveProperty("walletSoftware");
    expect(data).not.toHaveProperty("privateKeyStatus");
  });

  it("omits unset fields entirely", () => {
    const empty: MetadataValues = {
      ...FULL_VALUES,
      selectedTags: [],
      selectedCategories: [],
      owner: "",
      label: "",
      notes: "",
      flowType: "",
      acquisitionMethod: "",
      dispositionType: "",
      costBasisUsd: "",
    };
    expect(buildUpdateData("transaction", empty)).toEqual({});
  });
});

describe("buildCreateFields", () => {
  it("address mode: type is address, transaction fields are undefined", () => {
    const fields = buildCreateFields("address", FULL_VALUES);
    expect(fields.type).toBe("address");
    expect(fields.addressImportance).toBe("high");
    expect(fields.counterpartyType).toBe("exchange");
    expect(fields.walletName).toBe("Cold Wallet");
    expect(fields.flowType).toBeUndefined();
    expect(fields.acquisitionMethod).toBeUndefined();
    expect(fields.dispositionType).toBeUndefined();
    expect(fields.costBasisUsd).toBeUndefined();
  });

  it("address mode: defaults addressImportance to manual when unset", () => {
    const fields = buildCreateFields("address", { ...FULL_VALUES, addressImportance: "" });
    expect(fields.addressImportance).toBe("manual");
  });

  it("transaction mode: type is transaction, address + address-centric fields are undefined", () => {
    const fields = buildCreateFields("transaction", FULL_VALUES);
    expect(fields.type).toBe("transaction");
    expect(fields.flowType).toBe("inflow");
    expect(fields.costBasisUsd).toBe(123.45);
    expect(fields.addressImportance).toBeUndefined();
    expect(fields.counterpartyType).toBeUndefined();
    expect(fields.walletName).toBeUndefined();
    expect(fields.seedName).toBeUndefined();
    expect(fields.walletSoftware).toBeUndefined();
    expect(fields.privateKeyStatus).toBeUndefined();
  });
});
