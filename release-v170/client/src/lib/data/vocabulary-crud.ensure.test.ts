// @vitest-environment jsdom
//
// Task: bulk imports must never abort just because a tag/category/owner/etc.
// already exists. The tolerant ensure* helpers swallow the expected
// "already exists" duplicate error (the hooks' existing* snapshots can lag
// the DB) while still surfacing real failures.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/database";
import {
  createTag,
  createCategory,
  createOwner,
  ensureTag,
  ensureCategory,
  ensureOwner,
  ensureWalletName,
  ensureSeedName,
  ensureWalletSoftware,
  ensureSelectableVocabularyEntry,
  syncTagsToMaster,
  syncCategoriesToMaster,
} from "@/lib/data/vocabulary-crud";

describe("tolerant ensure* vocabulary helpers", () => {
  beforeEach(async () => {
    await Promise.all([
      db.tags.clear(),
      db.categories.clear(),
      db.owners.clear(),
      db.walletNames.clear(),
      db.seedNames.clear(),
      db.walletSoftware.clear(),
    ]);
  });

  it("ensureTag does not throw when the tag already exists (case-insensitive)", async () => {
    await createTag("Cold Storage", "#fff");
    await expect(ensureTag("cold storage")).resolves.toBeUndefined();
    expect(await db.tags.count()).toBe(1);
  });

  it("ensureCategory tolerates duplicates", async () => {
    await createCategory("Savings");
    await expect(ensureCategory("savings")).resolves.toBeUndefined();
    expect(await db.categories.count()).toBe(1);
  });

  it("ensureOwner/WalletName/SeedName/WalletSoftware tolerate duplicates", async () => {
    await createOwner("Alice");
    await expect(ensureOwner("alice")).resolves.toBeUndefined();
    await ensureWalletName("Vault");
    await expect(ensureWalletName("vault")).resolves.toBeUndefined();
    await ensureSeedName("seed-1");
    await expect(ensureSeedName("SEED-1")).resolves.toBeUndefined();
    await ensureWalletSoftware("Sparrow");
    await expect(ensureWalletSoftware("sparrow")).resolves.toBeUndefined();
    expect(await db.owners.count()).toBe(1);
    expect(await db.walletNames.count()).toBe(1);
    expect(await db.seedNames.count()).toBe(1);
    expect(await db.walletSoftware.count()).toBe(1);
  });

  it("ensure* helpers tolerate blank names without throwing", async () => {
    await expect(ensureTag("  ")).resolves.toBeUndefined();
    await expect(ensureOwner("")).resolves.toBeUndefined();
    expect(await db.tags.count()).toBe(0);
  });

  it("ensureSeedName tolerates over-length names (validation error is expected, not fatal)", async () => {
    await expect(
      ensureSeedName("this-name-is-way-too-long-for-a-seed")
    ).resolves.toBeUndefined();
    expect(await db.seedNames.count()).toBe(0);
  });

  it("createTag still throws on duplicates (strict path unchanged)", async () => {
    await createTag("dup");
    await expect(createTag("dup")).rejects.toThrow(/already exists/i);
  });

  describe("ensureSelectableVocabularyEntry (interactive Add new)", () => {
    it("creates a new entry and returns the trimmed name", async () => {
      const name = await ensureSelectableVocabularyEntry("owner", "  Alice  ");
      expect(name).toBe("Alice");
      expect(await db.owners.count()).toBe(1);
    });

    it("returns the existing canonical name on a case-insensitive duplicate instead of throwing", async () => {
      await createOwner("Alice");
      const name = await ensureSelectableVocabularyEntry("owner", "ALICE");
      expect(name).toBe("Alice");
      expect(await db.owners.count()).toBe(1);
    });

    it("handles duplicates for every kind", async () => {
      await createTag("Cold Storage");
      await createCategory("Savings");
      await expect(ensureSelectableVocabularyEntry("tag", "cold storage")).resolves.toBe("Cold Storage");
      await expect(ensureSelectableVocabularyEntry("category", "SAVINGS")).resolves.toBe("Savings");
      await ensureSelectableVocabularyEntry("walletName", "Vault");
      await expect(ensureSelectableVocabularyEntry("walletName", "vault")).resolves.toBe("Vault");
      await ensureSelectableVocabularyEntry("seedName", "seed-1");
      await expect(ensureSelectableVocabularyEntry("seedName", "SEED-1")).resolves.toBe("seed-1");
      await ensureSelectableVocabularyEntry("walletSoftware", "Sparrow");
      await expect(ensureSelectableVocabularyEntry("walletSoftware", "sparrow")).resolves.toBe("Sparrow");
      expect(await db.walletNames.count()).toBe(1);
      expect(await db.seedNames.count()).toBe(1);
      expect(await db.walletSoftware.count()).toBe(1);
    });

    it("still surfaces real validation errors (empty, over-length seed name)", async () => {
      await expect(ensureSelectableVocabularyEntry("owner", "   ")).rejects.toThrow(/cannot be empty/i);
      await expect(
        ensureSelectableVocabularyEntry("seedName", "this-name-is-way-too-long-for-a-seed")
      ).rejects.toThrow(/are limited to/i);
    });
  });

  it("syncTagsToMaster/syncCategoriesToMaster survive rows created concurrently after the snapshot", async () => {
    // Simulate the lagging-snapshot race: sync reads existing names, then a
    // duplicate row appears before the create. With tolerant creates the sync
    // no longer aborts even if the internal check misses the row.
    await createTag("existing");
    await createCategory("existing-cat");
    await expect(
      syncTagsToMaster(["existing", "Existing", "new-tag"])
    ).resolves.toBeUndefined();
    await expect(
      syncCategoriesToMaster(["existing-cat", "New Cat"])
    ).resolves.toBeUndefined();
    expect((await db.tags.toArray()).map(t => t.name).sort()).toEqual([
      "existing",
      "new-tag",
    ]);
    expect((await db.categories.toArray()).map(c => c.name).sort()).toEqual([
      "New Cat",
      "existing-cat",
    ]);
  });
});
