import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  buildEvidencePackage,
  EVIDENCE_PACKAGE_MAX_ATTACHMENT_BYTES,
  EvidencePackageError,
  stableJson,
  type EvidencePackageSelection,
} from "./evidence-package-export";

const selection: EvidencePackageSelection = {
  evidence: [
    {
      id: 2,
      title: "Later document",
      documentType: "receipt",
      notes: "second note",
      tags: [],
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 1,
      title: "Original document",
      documentType: "contract",
      notes: "confidential note",
      source: "Private correspondence",
      partiesInvolved: ["Alice"],
      tags: ["proof"],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  records: [{
    id: 4,
    type: "address",
    inputString: "bc1qexampleevidenceaddress",
    inputStringLower: "bc1qexampleevidenceaddress",
    label: "Evidence wallet",
    notes: "record note",
    vault: {
      isVaultXpub: true,
      vaultName: "Private vault",
      vaultNotes: "private vault note",
    },
    tags: [],
    categories: [],
    createdAt: 1,
    updatedAt: 1,
  }],
  transactions: [],
  participants: [],
  utxoLineage: [],
  custodySegments: [],
  lineageSnapshots: [],
  evidenceAttachments: [{
    id: 8,
    evidenceId: 1,
    filename: "receipt.pdf",
    mimeType: "application/pdf",
    size: 3,
    objectStoragePath: "evidence/opaque-receipt.pdf",
    createdAt: 1,
  }],
  redaction: {
    redactAddresses: true,
    redactNotes: true,
    redactParties: true,
  },
};

describe("evidence package export", () => {
  it("creates a self-contained, redacted package with sorted sources and verified attachment metadata", async () => {
    const result = await buildEvidencePackage(selection, {
      read: async () => new Uint8Array([1, 2, 3]),
    }, { generatedAt: 1_700_000_000_000 });

    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    const evidence = JSON.parse(await zip.file("data/evidence.json")!.async("text"));
    const records = JSON.parse(await zip.file("data/records.json")!.async("text"));

    expect(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.name).sort()).toEqual([
      "attachments/evidence-1-attachment-8-receipt.pdf",
      "data/custody-segments.json",
      "data/evidence.json",
      "data/lineage-snapshots.json",
      "data/participants.json",
      "data/records.json",
      "data/transactions.json",
      "data/utxo-lineage.json",
      "manifest.json",
      "report.html",
    ]);
    expect(manifest.packageVersion).toBe(1);
    expect(manifest.generatedAt).toBe(1_700_000_000_000);
    expect(manifest.sourceIdentifiers.evidenceIds).toEqual([1, 2]);
    expect(manifest.attachments).toEqual([expect.objectContaining({
      packagePath: "attachments/evidence-1-attachment-8-receipt.pdf",
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    })]);
    expect(evidence.map((item: { id: number }) => item.id)).toEqual([1, 2]);
    expect(evidence[0]).toMatchObject({ notes: "[REDACTED]", source: "[REDACTED]", partiesInvolved: ["[REDACTED]"] });
    expect(records[0].inputString).toBe("[REDACTED ADDRESS]");
    expect(records[0].inputStringLower).toBe("[REDACTED ADDRESS]");
    expect(records[0].vault).toMatchObject({ vaultName: "[REDACTED]", vaultNotes: "[REDACTED]" });
    expect(result.reportHtml).not.toContain("bc1qexampleevidenceaddress");
    expect(result.reportHtml).not.toContain("Private vault");
    expect(result.reportHtml).not.toContain("private vault note");
    expect(result.reportHtml).not.toContain("confidential note");
    expect(result.reportHtml).toContain("[REDACTED]");
    expect(result.manifest.manifestSha256).toHaveLength(64);
  });

  it("does not change its manifest when equivalent selections arrive in a different order", async () => {
    const first = await buildEvidencePackage(selection, { read: async () => new Uint8Array([1, 2, 3]) }, { generatedAt: 55 });
    const second = await buildEvidencePackage({
      ...selection,
      evidence: [...selection.evidence].reverse(),
    }, { read: async () => new Uint8Array([1, 2, 3]) }, { generatedAt: 55 });
    expect(stableJson(first.manifest)).toBe(stableJson(second.manifest));
  });

  it("refuses unsafe paths, changed files, and oversized attachments before a package is produced", async () => {
    await expect(buildEvidencePackage({
      ...selection,
      evidenceAttachments: [{ ...selection.evidenceAttachments[0], objectStoragePath: "../private.pdf" }],
    }, { read: async () => new Uint8Array([1, 2, 3]) })).rejects.toThrow(EvidencePackageError);

    await expect(buildEvidencePackage(selection, {
      read: async () => new Uint8Array([1, 2]),
    })).rejects.toThrow(/missing or changed/);

    await expect(buildEvidencePackage({
      ...selection,
      evidenceAttachments: [{ ...selection.evidenceAttachments[0], size: EVIDENCE_PACKAGE_MAX_ATTACHMENT_BYTES + 1 }],
    }, { read: async () => new Uint8Array() })).rejects.toThrow(/too large/);
  });

  it("honors cancellation while assembling a package", async () => {
    let checks = 0;
    await expect(buildEvidencePackage(selection, {
      read: async () => new Uint8Array([1, 2, 3]),
    }, {
      shouldCancel: () => ++checks > 3,
    })).rejects.toThrow("Export cancelled.");
  });

  it("redacts address arrays in proof snapshots and settles cleanly when ZIP finalization is cancelled", async () => {
    let cancel = false;
    await expect(buildEvidencePackage({
      ...selection,
      lineageSnapshots: [{
        id: 9,
        snapshotId: "proof-9",
        targetType: "address",
        targetAddress: "bc1qproofaddress",
        segments: [],
        evidenceTxids: [],
        totalAmount: 1,
        earliestDate: 1,
        latestDate: 1,
        hopCount: 0,
        narrative: "private trail",
        redactedAddresses: ["bc1qhiddenone", "bc1qhiddentwo"],
        disclosureLevel: "full",
        generatedAt: 1,
      }],
    }, {
      read: async () => new Uint8Array([1, 2, 3]),
    }, {
      onProgress: (_phase, _current, total) => {
        // The pre-generation update uses the package-entry count; this flips
        // only inside JSZip's actual progress callback (total = 100).
        if (total === 100) cancel = true;
      },
      shouldCancel: () => cancel,
    })).rejects.toThrow("Export cancelled.");

    const result = await buildEvidencePackage({
      ...selection,
      lineageSnapshots: [{
        id: 9,
        snapshotId: "proof-9",
        targetType: "address",
        targetAddress: "bc1qproofaddress",
        segments: [],
        evidenceTxids: [],
        totalAmount: 1,
        earliestDate: 1,
        latestDate: 1,
        hopCount: 0,
        narrative: "private trail",
        redactedAddresses: ["bc1qhiddenone", "bc1qhiddentwo"],
        disclosureLevel: "full",
        generatedAt: 1,
      }],
    }, { read: async () => new Uint8Array([1, 2, 3]) });
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const snapshotData = await zip.file("data/lineage-snapshots.json")!.async("text");
    expect(snapshotData).not.toContain("bc1qhiddenone");
    expect(snapshotData).not.toContain("bc1qproofaddress");
    expect(result.reportHtml).not.toContain("bc1qhiddentwo");
  });
});