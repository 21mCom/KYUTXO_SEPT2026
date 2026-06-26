import { describe, it, expect } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { ENTITY_LIST, type EntityCategory } from "./privacy-entity-list";

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
});
