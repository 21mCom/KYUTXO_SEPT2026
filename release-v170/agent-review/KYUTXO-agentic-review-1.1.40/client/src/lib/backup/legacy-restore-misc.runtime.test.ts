// @vitest-environment jsdom
//
// Regression guard for the LEGACY (pre-v3) backup restore path's LOWER-RISK
// inline branches: vocabulary (tags/categories/owners/walletNames/seedNames/
// walletSoftware), custom fields, derivation templates, and evidence (+ evidence
// attachments). This logic used to live inline inside SettingsPage's ~1000-line
// `handleRestore` and was exercised by no automated test, so a regression in the
// merge-vs-replace de-duplication or id handling would have gone unnoticed.
//
// The inline branches are now shared helpers in `./legacy-restore-misc`. These
// tests drive those helpers over the REAL `@/lib/database` schema through
// fake-indexeddb (mirroring `./legacy-restore.runtime.test.ts`) and assert the
// invariants the legacy path depended on:
//   - vocabulary: merge skips names that already exist (case-sensitive); replace
//     adds every entry; tags/categories counted separately from the other four.
//   - custom fields: merge de-dups by `slug`; replace adds every field; fresh
//     autoincrement ids (backup id stripped).
//   - derivation templates: merge de-dups by `fingerprint:scriptType`; replace
//     adds every template.
//   - evidence: replace mode adds every row; merge mode skips an evidence row
//     whose identity (title + documentType + originalDate) already exists and any
//     attachment belonging to a skipped row, so merging the same/overlapping
//     backup more than once doesn't accumulate duplicate documents or orphaned
//     attachments. Evidence rows get fresh autoincrement ids on restore, so each
//     backup evidence id is mapped to its new live id and every attachment's
//     `evidenceId` is remapped through that map (without this an old backup would
//     orphan/mislink every evidence file).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  restoreLegacyVocabulary,
  restoreLegacyCustomFields,
  restoreLegacyDerivationTemplates,
  restoreLegacyEvidence,
} from "./legacy-restore-misc";
import { db } from "@/lib/database";
import {
  getTags,
  getCategories,
  getOwners,
  getWalletNames,
  getSeedNames,
  getWalletSoftware,
  restoreTag,
} from "@/lib/data/vocabulary-crud";
import {
  addCustomField,
  getAllCustomFields,
  clearCustomFields,
} from "@/lib/data/custom-fields-crud";
import {
  addDerivationTemplate,
  getAllDerivationTemplates,
  clearDerivationTemplates,
} from "@/lib/data/derivation-templates-crud";
import {
  getAllEvidence,
  getAllEvidenceAttachments,
  bulkAddEvidence,
  clearEvidence,
  clearEvidenceAttachments,
} from "@/lib/data/evidence-crud";

async function clearEverything(): Promise<void> {
  await db.tags.clear();
  await db.categories.clear();
  await db.owners.clear();
  await db.walletNames.clear();
  await db.seedNames.clear();
  await db.walletSoftware.clear();
  await clearCustomFields({ skipNotification: true });
  await clearDerivationTemplates({ skipNotification: true });
  await clearEvidence({ skipNotification: true });
  await clearEvidenceAttachments({ skipNotification: true });
}

beforeEach(async () => {
  await clearEverything();
});

describe("legacy restore: vocabulary", () => {
  it("replace mode adds every entry and counts tags/categories separately from the rest", async () => {
    const { tagsAdded, categoriesAdded, vocabularyAdded } =
      await restoreLegacyVocabulary(
        {
          tags: [
            { id: 1, name: "cold", color: "#fff" },
            { id: 2, name: "hot" },
          ],
          categories: [{ id: 1, name: "exchange" }],
          owners: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
          walletNames: [{ id: 1, name: "Sparrow" }],
          seedNames: [{ id: 1, name: "main" }],
          walletSoftware: [{ id: 1, name: "Electrum" }],
        },
        "replace",
      );

    expect(tagsAdded).toBe(2);
    expect(categoriesAdded).toBe(1);
    // owners(2) + walletNames(1) + seedNames(1) + walletSoftware(1)
    expect(vocabularyAdded).toBe(5);

    expect(await getTags()).toHaveLength(2);
    expect(await getCategories()).toHaveLength(1);
    expect(await getOwners()).toHaveLength(2);
    expect(await getWalletNames()).toHaveLength(1);
    expect(await getSeedNames()).toHaveLength(1);
    expect(await getWalletSoftware()).toHaveLength(1);

    // Missing color falls back to the default; backup id is not preserved.
    const tags = await getTags();
    expect(tags.find((t) => t.name === "hot")!.color).toBe("#888888");
    expect(tags.every((t) => typeof t.id === "number")).toBe(true);
  });

  it("merge mode skips entries whose name already exists and adds the new ones", async () => {
    // Seed existing vocabulary so the incoming backup collides on names.
    await restoreTag({ name: "cold", color: "#000", createdAt: 1 });
    await db.owners.add({ name: "Alice", createdAt: 1 });

    const { tagsAdded, categoriesAdded, vocabularyAdded } =
      await restoreLegacyVocabulary(
        {
          tags: [
            { id: 9, name: "cold" }, // collides -> skipped
            { id: 10, name: "warm" }, // new -> added
          ],
          owners: [
            { id: 9, name: "Alice" }, // collides -> skipped
            { id: 10, name: "Carol" }, // new -> added
          ],
        },
        "merge",
      );

    expect(tagsAdded).toBe(1);
    expect(categoriesAdded).toBe(0);
    expect(vocabularyAdded).toBe(1);

    const tags = await getTags();
    expect(tags).toHaveLength(2);
    expect(tags.filter((t) => t.name === "cold")).toHaveLength(1); // not duplicated
    expect(tags.some((t) => t.name === "warm")).toBe(true);

    const owners = await getOwners();
    expect(owners).toHaveLength(2);
    expect(owners.filter((o) => o.name === "Alice")).toHaveLength(1);
    expect(owners.some((o) => o.name === "Carol")).toBe(true);
  });

  it("no-ops cleanly on empty input", async () => {
    await expect(restoreLegacyVocabulary({}, "replace")).resolves.toEqual({
      tagsAdded: 0,
      categoriesAdded: 0,
      vocabularyAdded: 0,
    });
    expect(await getTags()).toHaveLength(0);
  });
});

describe("legacy restore: custom fields", () => {
  function field(id: number, slug: string, label?: string) {
    return { id, slug, label: label ?? slug, fieldType: "text" };
  }

  it("replace mode adds every field with fresh ids", async () => {
    const added = await restoreLegacyCustomFields(
      [field(101, "purchase-price"), field(102, "exchange-ref")],
      "replace",
    );
    expect(added).toBe(2);

    const live = await getAllCustomFields();
    expect(live).toHaveLength(2);
    expect(new Set(live.map((f) => f.slug))).toEqual(
      new Set(["purchase-price", "exchange-ref"]),
    );
    // Backup id was stripped: ids are fresh autoincrement values.
    expect(live.every((f) => typeof f.id === "number")).toBe(true);
  });

  it("merge mode skips fields whose slug already exists", async () => {
    await addCustomField(
      { slug: "purchase-price", label: "Existing", fieldType: "text" } as any,
      { skipNotification: true },
    );

    const added = await restoreLegacyCustomFields(
      [
        field(201, "purchase-price"), // collides on slug -> skipped
        field(202, "tax-year"), // new -> added
      ],
      "merge",
    );
    expect(added).toBe(1);

    const live = await getAllCustomFields();
    expect(live).toHaveLength(2);
    expect(live.filter((f) => f.slug === "purchase-price")).toHaveLength(1);
    expect(live.some((f) => f.slug === "tax-year")).toBe(true);
  });

  it("no-ops cleanly on empty/undefined input", async () => {
    await expect(restoreLegacyCustomFields([], "replace")).resolves.toBe(0);
    await expect(restoreLegacyCustomFields(undefined, "merge")).resolves.toBe(0);
    expect(await getAllCustomFields()).toHaveLength(0);
  });
});

describe("legacy restore: derivation templates", () => {
  function template(id: number, fingerprint: string, scriptType = "P2WPKH") {
    return {
      id,
      fingerprint,
      scriptType,
      derivationPath: "m/84'/0'/0'",
      gapLimit: 20,
      network: "mainnet",
    };
  }

  it("replace mode adds every template with defaults applied", async () => {
    const added = await restoreLegacyDerivationTemplates(
      [
        template(101, "aabbccdd"),
        // missing fields -> defaults
        { id: 102, fingerprint: "11223344" },
      ],
      "replace",
    );
    expect(added).toBe(2);

    const live = await getAllDerivationTemplates();
    expect(live).toHaveLength(2);
    const defaulted = live.find((t) => t.fingerprint === "11223344")!;
    expect(defaulted.scriptType).toBe("P2WPKH");
    expect(defaulted.derivationPath).toBe("m/84'/0'/0'");
    expect(defaulted.gapLimit).toBe(20);
    expect(defaulted.network).toBe("mainnet");
  });

  it("merge mode de-dups by fingerprint:scriptType", async () => {
    await addDerivationTemplate(
      {
        fingerprint: "aabbccdd",
        scriptType: "P2WPKH",
        derivationPath: "m/84'/0'/0'",
        gapLimit: 20,
        network: "mainnet",
      } as any,
      { skipNotification: true },
    );

    const added = await restoreLegacyDerivationTemplates(
      [
        template(201, "aabbccdd", "P2WPKH"), // collides -> skipped
        template(202, "aabbccdd", "P2TR"), // same fp, different scriptType -> added
        template(203, "deadbeef", "P2WPKH"), // new -> added
      ],
      "merge",
    );
    expect(added).toBe(2);

    const live = await getAllDerivationTemplates();
    expect(live).toHaveLength(3);
    expect(
      live.filter((t) => t.fingerprint === "aabbccdd"),
    ).toHaveLength(2); // P2WPKH (existing) + P2TR (new)
  });

  it("no-ops cleanly on empty/undefined input", async () => {
    await expect(restoreLegacyDerivationTemplates([], "replace")).resolves.toBe(0);
    await expect(
      restoreLegacyDerivationTemplates(undefined, "merge"),
    ).resolves.toBe(0);
    expect(await getAllDerivationTemplates()).toHaveLength(0);
  });
});

describe("legacy restore: evidence", () => {
  function evidenceRow(id: number, title: string) {
    return { id, title, documentType: "receipt" };
  }
  function attachmentRow(id: number, evidenceId: number, filename: string) {
    return { id, evidenceId, filename, mimeType: "application/pdf", size: 10, objectStoragePath: `hash-${id}` };
  }

  it("adds every evidence row (no de-dup) with fresh ids and applies defaults", async () => {
    const { evidenceAdded, evidenceAttachmentsAdded } =
      await restoreLegacyEvidence(
        [
          evidenceRow(101, "Receipt A"),
          { id: 102 }, // missing fields -> defaults
        ],
        undefined,
      );
    expect(evidenceAdded).toBe(2);
    expect(evidenceAttachmentsAdded).toBe(0);

    const live = await getAllEvidence();
    expect(live).toHaveLength(2);
    const defaulted = live.find((e) => e.id !== live.find((x) => x.title === "Receipt A")!.id)!;
    expect(defaulted.title).toBe("Restored Evidence");
    expect(defaulted.documentType).toBe("other");
    expect(live.every((e) => typeof e.id === "number")).toBe(true);
  });

  it("remaps each attachment's evidenceId to the freshly-assigned evidence id so files link to the correct record", async () => {
    // Seed + clear evidence first so the restored rows get FRESH ids that differ
    // from the backup ids (clear() does NOT reset IndexedDB key generation) —
    // the exact condition that orphaned attachments before the remap fix.
    await bulkAddEvidence(
      [
        { title: "seed-1", documentType: "other", tags: [], partiesInvolved: [], createdAt: 1, updatedAt: 1 } as any,
        { title: "seed-2", documentType: "other", tags: [], partiesInvolved: [], createdAt: 1, updatedAt: 1 } as any,
      ],
      { skipNotification: true },
    );
    await clearEvidence({ skipNotification: true });

    const { evidenceAdded, evidenceAttachmentsAdded } =
      await restoreLegacyEvidence(
        [evidenceRow(101, "Receipt A"), evidenceRow(102, "Receipt B")],
        [
          attachmentRow(1, 101, "a.pdf"),
          attachmentRow(2, 101, "b.pdf"),
          attachmentRow(3, 102, "c.pdf"),
        ],
      );
    expect(evidenceAdded).toBe(2);
    expect(evidenceAttachmentsAdded).toBe(3);

    const liveEvidence = await getAllEvidence();
    const attachments = await getAllEvidenceAttachments();
    expect(liveEvidence).toHaveLength(2);
    expect(attachments).toHaveLength(3);

    const recA = liveEvidence.find((e) => e.title === "Receipt A")!;
    const recB = liveEvidence.find((e) => e.title === "Receipt B")!;
    // Backup ids 101/102 do not survive — the new live ids must differ.
    expect(recA.id).not.toBe(101);
    expect(recB.id).not.toBe(102);

    // Each attachment links to the LIVE evidence id of the record it originally
    // belonged to, not the stale backup id.
    expect(attachments.find((a) => a.filename === "a.pdf")!.evidenceId).toBe(recA.id);
    expect(attachments.find((a) => a.filename === "b.pdf")!.evidenceId).toBe(recA.id);
    expect(attachments.find((a) => a.filename === "c.pdf")!.evidenceId).toBe(recB.id);

    // No orphans: every attachment points at an evidence record that exists.
    const liveIds = new Set(liveEvidence.map((e) => e.id));
    expect(attachments.every((a) => liveIds.has(a.evidenceId))).toBe(true);
  });

  it("no-ops cleanly on empty/undefined input", async () => {
    await expect(restoreLegacyEvidence(undefined, undefined)).resolves.toEqual({
      evidenceAdded: 0,
      evidenceAttachmentsAdded: 0,
      insertedEvidenceIds: [],
      insertedEvidenceAttachmentIds: [],
    });
    expect(await getAllEvidence()).toHaveLength(0);
    expect(await getAllEvidenceAttachments()).toHaveLength(0);
  });

  it("merge mode skips evidence that already exists and drops its attachments (no doubling)", async () => {
    // Seed the vault with one document + attachment, as a prior restore would.
    await restoreLegacyEvidence(
      [{ id: 1, title: "Coinbase Receipt", documentType: "receipt", originalDate: 1700 }],
      [attachmentRow(11, 1, "coinbase.pdf")],
      "merge",
    );
    expect(await getAllEvidence()).toHaveLength(1);
    expect(await getAllEvidenceAttachments()).toHaveLength(1);

    // Merge the SAME backup again plus one genuinely new document. The duplicate
    // evidence (and its attachment) must be skipped; only the new one is added.
    const result = await restoreLegacyEvidence(
      [
        { id: 1, title: "Coinbase Receipt", documentType: "receipt", originalDate: 1700 }, // dup
        { id: 2, title: "Bank Statement", documentType: "statement", originalDate: 1800 }, // new
      ],
      [attachmentRow(12, 1, "coinbase.pdf"), attachmentRow(13, 2, "bank.pdf")],
      "merge",
    );
    expect(result.evidenceAdded).toBe(1);
    expect(result.evidenceAttachmentsAdded).toBe(1);

    const live = await getAllEvidence();
    expect(live).toHaveLength(2);
    expect(live.filter((e) => e.title === "Coinbase Receipt")).toHaveLength(1);

    const attachments = await getAllEvidenceAttachments();
    expect(attachments).toHaveLength(2);
    // The new attachment links to the LIVE id of the new document, never the
    // stale backup id; no orphaned duplicate attachment for the skipped doc.
    const bankDoc = live.find((e) => e.title === "Bank Statement")!;
    expect(attachments.find((a) => a.filename === "bank.pdf")!.evidenceId).toBe(bankDoc.id);
    const liveIds = new Set(live.map((e) => e.id));
    expect(attachments.every((a) => liveIds.has(a.evidenceId))).toBe(true);
  });

  it("merge mode de-dups documents that share an identity WITHIN one backup", async () => {
    // Two backup rows with the same title+documentType+originalDate collapse to
    // one on a merge, and only the kept row's attachments are added.
    const result = await restoreLegacyEvidence(
      [
        { id: 1, title: "Same Doc", documentType: "other", originalDate: 500 },
        { id: 2, title: "Same Doc", documentType: "other", originalDate: 500 },
        { id: 3, title: "Different Doc", documentType: "other", originalDate: 600 },
      ],
      [
        attachmentRow(10, 1, "first.pdf"),
        attachmentRow(20, 2, "second.pdf"),
        attachmentRow(30, 3, "third.pdf"),
      ],
      "merge",
    );
    expect(result.evidenceAdded).toBe(2);
    // The attachment of the de-duped second row (id 2) is dropped; the kept
    // row's (id 1) attachment and the distinct row's attachment remain.
    expect(result.evidenceAttachmentsAdded).toBe(2);

    expect(await getAllEvidence()).toHaveLength(2);
    const attachments = await getAllEvidenceAttachments();
    expect(attachments.map((a) => a.filename).sort()).toEqual(["first.pdf", "third.pdf"]);
  });

  it("merge mode distinguishes documents by originalDate and documentType, not just title", async () => {
    await restoreLegacyEvidence(
      [{ id: 1, title: "Doc", documentType: "receipt", originalDate: 100 }],
      undefined,
      "merge",
    );
    // Same title but a different documentType or originalDate is NOT a duplicate.
    const result = await restoreLegacyEvidence(
      [
        { id: 2, title: "Doc", documentType: "statement", originalDate: 100 }, // diff type
        { id: 3, title: "Doc", documentType: "receipt", originalDate: 200 }, // diff date
        { id: 4, title: "Doc", documentType: "receipt", originalDate: 100 }, // dup
      ],
      undefined,
      "merge",
    );
    expect(result.evidenceAdded).toBe(2);
    expect(await getAllEvidence()).toHaveLength(3);
  });

  it("replace mode still adds duplicate documents (no de-dup; table was cleared first)", async () => {
    const result = await restoreLegacyEvidence(
      [
        { id: 1, title: "Dup Doc", documentType: "other", originalDate: 1 },
        { id: 2, title: "Dup Doc", documentType: "other", originalDate: 1 },
      ],
      undefined,
      "replace",
    );
    expect(result.evidenceAdded).toBe(2);
    expect(await getAllEvidence()).toHaveLength(2);
  });
});
