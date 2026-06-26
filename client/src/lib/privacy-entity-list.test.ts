import { describe, it, expect } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import {
  ENTITY_LIST,
  getBundledEntityList,
  getBundledEntityCount,
  mergeWithBundled,
  type EntityCategory,
  type EntityEntry,
} from "./privacy-entity-list";
import { findMismatchedCitations } from "./data/entity-list-store";

const VALID_CATEGORIES: ReadonlySet<EntityCategory> = new Set<EntityCategory>([
  "exchange",
  "payment-service",
  "gambling",
  "scam",
  "darknet",
  "mining-pool",
  "mixer",
  "p2p-exchange",
]);

describe("privacy-entity-list dataset integrity", () => {
  it("has at least one entry", () => {
    expect(ENTITY_LIST.length).toBeGreaterThan(0);
  });

  it("every address is a valid mainnet Bitcoin address", () => {
    const invalid: string[] = [];
    for (const entry of ENTITY_LIST) {
      try {
        bitcoin.address.toOutputScript(entry.address, bitcoin.networks.bitcoin);
      } catch {
        invalid.push(`${entry.name}: ${entry.address}`);
      }
    }
    expect(invalid, `Invalid Bitcoin addresses:\n${invalid.join("\n")}`).toEqual([]);
  });

  it("has no duplicate addresses", () => {
    const seen = new Map<string, string[]>();
    for (const entry of ENTITY_LIST) {
      const list = seen.get(entry.address) ?? [];
      list.push(entry.name);
      seen.set(entry.address, list);
    }
    const duplicates = [...seen.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([address, names]) => `${address} (${names.join(", ")})`);
    expect(duplicates, `Duplicate addresses:\n${duplicates.join("\n")}`).toEqual([]);
  });

  it("every entry has a non-empty sourceNote", () => {
    const missing = ENTITY_LIST.filter(
      (entry) => !entry.sourceNote || entry.sourceNote.trim().length === 0,
    ).map((entry) => `${entry.name}: ${entry.address}`);
    expect(missing, `Entries missing sourceNote:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every entry has a non-empty name", () => {
    const missing = ENTITY_LIST.filter(
      (entry) => !entry.name || entry.name.trim().length === 0,
    ).map((entry) => entry.address);
    expect(missing, `Entries missing name:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every entry has a valid category", () => {
    const invalid = ENTITY_LIST.filter(
      (entry) => !VALID_CATEGORIES.has(entry.category),
    ).map((entry) => `${entry.name} (${entry.address}): ${entry.category}`);
    expect(invalid, `Entries with unknown category:\n${invalid.join("\n")}`).toEqual([]);
  });

  it("every sourceNote address citation matches the entry's own address", () => {
    // WalletExplorer-style citations embed the cited address in the URL path,
    // e.g. https://www.walletexplorer.com/address/<addr>. A row duplicated by
    // copy/paste but never re-pointed will cite a different address than its
    // own `address` field — catch that silent breakage here. Share the exact
    // extraction helper used by the import-time warning so both stay in lockstep
    // (and both capture bech32 citations in full, not truncated at the first 0).
    const mismatched: string[] = [];
    for (const entry of ENTITY_LIST) {
      if (!entry.sourceNote) continue;
      for (const cited of findMismatchedCitations(entry.sourceNote, entry.address)) {
        mismatched.push(
          `${entry.name} (${entry.address}) cites ${cited} in sourceNote`,
        );
      }
    }
    expect(
      mismatched,
      `sourceNote cites a different address than the entry:\n${mismatched.join("\n")}`,
    ).toEqual([]);
  });
});

describe("mergeWithBundled", () => {
  // A brand-new address not present in the bundled list.
  const NEW_ENTRY: EntityEntry = {
    address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    name: "New Sanctioned Market",
    category: "darknet",
    sourceNote: "test",
  };

  it("adds new entries on top of the bundled list", () => {
    const merged = mergeWithBundled([NEW_ENTRY]);
    expect(merged.length).toBe(getBundledEntityCount() + 1);
    expect(merged.find((e) => e.address === NEW_ENTRY.address)).toEqual(NEW_ENTRY);
  });

  it("lets the snapshot win on duplicate addresses", () => {
    const bundledFirst = getBundledEntityList()[0];
    const override: EntityEntry = {
      address: bundledFirst.address,
      name: "Overridden Name",
      category: "mixer",
      sourceNote: "override test",
    };
    const merged = mergeWithBundled([override]);
    // No net size change because the address already existed.
    expect(merged.length).toBe(getBundledEntityCount());
    const result = merged.find((e) => e.address === bundledFirst.address);
    expect(result).toEqual(override);
  });

  it("returns a copy equal to the bundled list when given no entries", () => {
    const merged = mergeWithBundled([]);
    expect(merged.length).toBe(getBundledEntityCount());
  });

  it("does not mutate the bundled list", () => {
    const before = getBundledEntityCount();
    mergeWithBundled([NEW_ENTRY]);
    expect(getBundledEntityCount()).toBe(before);
  });
});
