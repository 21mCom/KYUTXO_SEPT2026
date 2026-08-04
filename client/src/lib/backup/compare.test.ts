// Pure diff-engine unit tests for backup comparison (compare.ts).
//
// These run on SYNTHETIC snapshots (no ZIPs, no DB) and pin the classification
// contract: added/removed/changed per table, field-level deltas with
// machine-noise fields skipped, compact-export suppression, and the CSV
// rendering (including formula-injection sanitization). The full streaming
// pipeline (real zips, encryption, wrong-password failure) is covered by
// compare.runtime.test.ts.

import { describe, it, expect } from "vitest";
import {
  diffSnapshots,
  formatDiffValue,
  DIFF_CSV_HEADER,
  type BackupSnapshot,
} from "./compare";
import type { BackupManifest } from "./format";
import type { StreamedTable } from "./format";

function manifest(partial: Partial<BackupManifest> = {}): BackupManifest {
  return {
    formatVersion: 3,
    app: "KYUTXO",
    appVersion: "1.0.0",
    exportDate: "2026-01-01T00:00:00.000Z",
    encrypted: false,
    counts: {
      records: 0,
      blockchainTransactions: 0,
      transactionParticipants: 0,
      attachments: 0,
      addressSyncState: 0,
      utxoLineage: 0,
      custodySegments: 0,
      lineageSnapshots: 0,
      attachmentFiles: 0,
    },
    streamedTables: [],
    ...partial,
  };
}

interface SnapSpec {
  manifest?: Partial<BackupManifest>;
  streamed?: Partial<Record<StreamedTable, Array<[string, any]>>>;
  inline?: Partial<Record<string, Array<[string, any]>>>;
  keptRecordIdentities?: string[];
  keptAddresses?: string[];
  discoveryOnlyTxids?: string[];
}

function makeSnapshot(spec: SnapSpec): BackupSnapshot {
  const streamed = {} as Record<StreamedTable, Map<string, any>>;
  for (const t of [
    "records",
    "attachments",
    "transactionParticipants",
    "addressSyncState",
    "blockchainTransactions",
    "utxoLineage",
    "custodySegments",
    "lineageSnapshots",
  ] as const) {
    streamed[t] = new Map(spec.streamed?.[t] ?? []);
  }
  const inlineNames = [
    "tags",
    "categories",
    "owners",
    "walletNames",
    "seedNames",
    "walletSoftware",
    "customFields",
    "derivationTemplates",
    "recordOrigins",
    "evidence",
    "evidenceAttachments",
    "priceData",
    "settings",
    "nodeSettings",
    "dustFlags",
    "savedPsbts",
  ] as const;
  const inline = {} as Record<(typeof inlineNames)[number], Map<string, any>>;
  for (const t of inlineNames) inline[t] = new Map(spec.inline?.[t] ?? []);
  return {
    manifest: manifest(spec.manifest),
    recordIdentityByBackupId: new Map(),
    streamed,
    inline,
    keptRecordIdentities: new Set(spec.keptRecordIdentities ?? []),
    keptAddresses: new Set(spec.keptAddresses ?? []),
    discoveryOnlyTxids: new Set(spec.discoveryOnlyTxids ?? []),
  };
}

function table(result: ReturnType<typeof diffSnapshots>, name: string) {
  const t = result.tables.find((x) => x.table === name);
  if (!t) throw new Error(`missing table diff: ${name}`);
  return t;
}

// A bare blockchain-discovered record (prunable shape) and a curated record.
const prunableRecord = (inputString: string) => ({
  id: 99,
  type: "address",
  inputString,
  inputStringLower: inputString,
  label: "",
  tags: [],
  categories: [],
  owner: "Pending Review",
  source: "blockchain-sync",
  addressImportance: "blockchain-discovered",
  createdAt: 1,
  updatedAt: 1,
});
const curatedRecord = (inputString: string, label = "") => ({
  id: 1,
  type: "address",
  inputString,
  inputStringLower: inputString,
  label,
  tags: [],
  categories: [],
  source: "manual",
  addressImportance: "manual",
  createdAt: 1,
  updatedAt: 1,
});

describe("diffSnapshots — records", () => {
  it("classifies added / removed / changed and reports field-level deltas", () => {
    const older = makeSnapshot({
      streamed: {
        records: [
          ["bc1qkeep", curatedRecord("bc1qkeep", "Keep")],
          ["bc1qedit", curatedRecord("bc1qedit", "Before")],
          ["bc1qgone", curatedRecord("bc1qgone", "Gone")],
        ],
      },
    });
    const newer = makeSnapshot({
      streamed: {
        records: [
          ["bc1qkeep", curatedRecord("bc1qkeep", "Keep")],
          ["bc1qedit", { ...curatedRecord("bc1qedit", "After"), id: 2, updatedAt: 999 }],
          ["bc1qadded", curatedRecord("bc1qadded", "Added")],
        ],
      },
    });
    const result = diffSnapshots(older, newer);
    const records = table(result, "records");
    expect(records.added).toBe(1);
    expect(records.removed).toBe(1);
    expect(records.changed).toBe(1);
    const changed = records.entries.find((e) => e.change === "changed");
    expect(changed?.key).toBe("bc1qedit");
    // Only the label differs: id / updatedAt are machine noise and skipped.
    expect(changed?.deltas).toEqual([
      { field: "label", oldValue: "Before", newValue: "After" },
    ]);
    expect(records.entries.find((e) => e.change === "added")?.key).toBe("bc1qadded");
    expect(records.entries.find((e) => e.change === "removed")?.key).toBe("bc1qgone");
  });

  it("treats rows differing only in noise fields (id, updatedAt, _-prefixed, stats cache) as unchanged", () => {
    const a = curatedRecord("bc1qsame", "Same");
    const b = {
      ...a,
      id: 42,
      updatedAt: 123456,
      _legacyEncryptedPayload: "deadbeef",
      // Derived stats cache: recomputed from local data between the two
      // backups — not a user edit.
      cachedBalanceSats: 5000,
      cachedTxCount: 3,
      cachedLastActivityTime: 1_700_000_000,
      cachedUtxoCount: 1,
      statsComputedAt: 1_700_000_000_999,
    };
    const older = makeSnapshot({ streamed: { records: [["bc1qsame", a]] } });
    const newer = makeSnapshot({ streamed: { records: [["bc1qsame", b]] } });
    const records = table(diffSnapshots(older, newer), "records");
    expect(records.changed).toBe(0);
    expect(records.entries).toHaveLength(0);
  });

  it("flags records whose ONLY delta is a real field even when ids match", () => {
    const a = curatedRecord("bc1qtags", "");
    const b = { ...a, tags: ["cold-storage"] };
    const older = makeSnapshot({ streamed: { records: [["bc1qtags", a]] } });
    const newer = makeSnapshot({ streamed: { records: [["bc1qtags", b]] } });
    const records = table(diffSnapshots(older, newer), "records");
    expect(records.changed).toBe(1);
    expect(records.entries[0].deltas).toEqual([
      { field: "tags", oldValue: "", newValue: "cold-storage" },
    ]);
  });
});

describe("diffSnapshots — dependent tables skip remapped foreign keys", () => {
  it("attachment rows differing only in recordId/id compare unchanged; size delta is reported", () => {
    const base = {
      id: 1,
      recordId: 10,
      filename: "doc.pdf",
      mimeType: "application/pdf",
      size: 1024,
      objectStoragePath: "ab/cd/doc.pdf",
    };
    const older = makeSnapshot({
      streamed: { attachments: [["ab/cd/doc.pdf", base], ["ef/gh/x.png", { ...base, id: 2, objectStoragePath: "ef/gh/x.png", filename: "x.png", size: 5 }]] },
    });
    const newer = makeSnapshot({
      streamed: {
        attachments: [
          // Same file, different local record id space → unchanged.
          ["ab/cd/doc.pdf", { ...base, id: 7, recordId: 88 }],
          ["ef/gh/x.png", { ...base, id: 2, objectStoragePath: "ef/gh/x.png", filename: "x.png", size: 6 }],
        ],
      },
    });
    const atts = table(diffSnapshots(older, newer), "attachments");
    expect(atts.changed).toBe(1);
    expect(atts.entries[0].key).toBe("ef/gh/x.png");
    expect(atts.entries[0].deltas).toEqual([
      { field: "size", oldValue: "5", newValue: "6" },
    ]);
  });
});

describe("diffSnapshots — settings portable preferences", () => {
  it("reports portable-preference value changes as field deltas", () => {
    const older = makeSnapshot({
      inline: { settings: [["default", { disableOrphanCheck: "Off", privacyHistoryLimit: "10 runs" }]] },
    });
    const newer = makeSnapshot({
      inline: { settings: [["default", { disableOrphanCheck: "On", privacyHistoryLimit: "10 runs" }]] },
    });
    const settings = table(diffSnapshots(older, newer), "settings");
    expect(settings.changed).toBe(1);
    expect(settings.entries[0].deltas).toEqual([
      { field: "disableOrphanCheck", oldValue: "Off", newValue: "On" },
    ]);
  });
});

describe("diffSnapshots — compact suppression", () => {
  it("does not report prunable records missing from a compact newer backup as removed", () => {
    const disc = prunableRecord("bc1qdisc");
    const older = makeSnapshot({
      streamed: {
        records: [
          ["bc1qdisc", disc],
          ["bc1qmine", curatedRecord("bc1qmine", "Mine")],
        ],
      },
    });
    const newer = makeSnapshot({
      manifest: {
        compact: true,
        compactDropped: {
          records: 1,
          blockchainTransactions: 0,
          transactionParticipants: 0,
          addressSyncState: 0,
          utxoLineage: 0,
          custodySegments: 0,
        },
      },
      streamed: { records: [] },
    });
    const records = table(diffSnapshots(older, newer), "records");
    expect(records.removed).toBe(1); // the curated record IS a real removal
    expect(records.entries.map((e) => e.key)).toEqual(["bc1qmine"]);
    expect(records.suppressed).toBe(1); // the prunable one is not
  });

  it("suppresses discovery-only history (tx / participant / sync state) missing from a compact newer backup", () => {
    const txidDisc = "d".repeat(64);
    const older = makeSnapshot({
      streamed: {
        blockchainTransactions: [[txidDisc, { txid: txidDisc, blockHeight: 1 }]],
        transactionParticipants: [
          [`o|${txidDisc}|0`, { txid: txidDisc, role: "output", address: "bc1qdisc", vout: 0 }],
        ],
        addressSyncState: [["bc1qdisc", { address: "bc1qdisc", syncDepth: 2 }]],
        records: [["bc1qdisc", prunableRecord("bc1qdisc")]],
      },
      discoveryOnlyTxids: [txidDisc],
    });
    const newer = makeSnapshot({
      manifest: { compact: true },
      streamed: {},
    });
    const result = diffSnapshots(older, newer);
    expect(table(result, "blockchainTransactions").removed).toBe(0);
    expect(table(result, "blockchainTransactions").suppressed).toBe(1);
    expect(table(result, "transactionParticipants").suppressed).toBe(1);
    expect(table(result, "addressSyncState").suppressed).toBe(1);
    // Everything differing was suppressed (including the prunable record), so
    // the CSV carries no rows at all.
    expect(result.csv.rowCount).toBe(0);
  });

  it("does NOT suppress genuinely-removed rows against a compact newer backup", () => {
    const txidKeep = "e".repeat(64);
    const older = makeSnapshot({
      streamed: {
        blockchainTransactions: [[txidKeep, { txid: txidKeep, blockHeight: 1 }]],
        records: [["bc1qmine", curatedRecord("bc1qmine", "Mine")]],
      },
      keptRecordIdentities: ["bc1qmine"],
      keptAddresses: ["bc1qmine"],
      discoveryOnlyTxids: [], // txidKeep is anchored — not discovery-only
    });
    const newer = makeSnapshot({ manifest: { compact: true }, streamed: {} });
    const result = diffSnapshots(older, newer);
    expect(table(result, "blockchainTransactions").removed).toBe(1);
    expect(table(result, "blockchainTransactions").suppressed).toBe(0);
  });

  it("suppresses discovery-only rows appearing in the newer backup when the OLDER backup is compact", () => {
    const txidDisc = "f".repeat(64);
    const older = makeSnapshot({ manifest: { compact: true }, streamed: {} });
    const newer = makeSnapshot({
      streamed: {
        blockchainTransactions: [[txidDisc, { txid: txidDisc, blockHeight: 1 }]],
        records: [["bc1qmine", curatedRecord("bc1qmine", "Mine")]],
      },
      discoveryOnlyTxids: [txidDisc],
    });
    const result = diffSnapshots(older, newer);
    expect(table(result, "blockchainTransactions").added).toBe(0);
    expect(table(result, "blockchainTransactions").suppressed).toBe(1);
    expect(table(result, "records").added).toBe(1); // curated record: a real addition
  });

  it("reports everything when neither side is compact", () => {
    const older = makeSnapshot({
      streamed: { records: [["bc1qdisc", prunableRecord("bc1qdisc")]] },
    });
    const newer = makeSnapshot({ streamed: { records: [] } });
    const records = table(diffSnapshots(older, newer), "records");
    expect(records.removed).toBe(1);
    expect(records.suppressed).toBe(0);
  });
});

describe("diffSnapshots — CSV", () => {
  it("emits a formula-injection-safe CSV with one row per entry/delta", () => {
    const hostile = "=HYPERLINK(\"https://evil.example\",\"click\")";
    const older = makeSnapshot({
      streamed: {
        records: [
          [hostile, { ...curatedRecord(hostile, "Before") }],
          ["bc1qgone", curatedRecord("bc1qgone", "Gone")],
        ],
        tags: [],
      },
      inline: { tags: [["oldtag", { name: "oldtag" }]] },
    });
    const newer = makeSnapshot({
      streamed: { records: [[hostile, { ...curatedRecord(hostile, "=After") }]] },
      inline: { tags: [["newtag", { name: "newtag" }]] },
    });
    const result = diffSnapshots(older, newer);
    const csv = result.csv.parts.join("");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(DIFF_CSV_HEADER.join(","));
    // Hostile identifier is apostrophe-prefixed (formula neutralized) in every
    // row that carries it, and the hostile new value is too.
    const keyRows = lines.filter((l) => l.includes("HYPERLINK"));
    expect(keyRows.length).toBeGreaterThan(0);
    // The sigil is neutralized with a literal apostrophe (the cell itself is
    // RFC-4180 quoted, so embedded quotes appear doubled).
    for (const l of keyRows) expect(l).toContain("'=HYPERLINK");
    expect(csv).toContain(`'=After`);
    // added (newtag) + removed (oldtag + bc1qgone) + changed delta = 4 rows.
    expect(result.csv.rowCount).toBe(4);
    expect(lines).toHaveLength(5);
  });
});

describe("formatDiffValue", () => {
  it("renders primitives, arrays and objects; null for absent", () => {
    expect(formatDiffValue(undefined)).toBeNull();
    expect(formatDiffValue(null)).toBeNull();
    expect(formatDiffValue("x")).toBe("x");
    expect(formatDiffValue(12)).toBe("12");
    expect(formatDiffValue(["a", "b"])).toBe("a; b");
    expect(formatDiffValue({ a: 1 })).toBe('{"a":1}');
  });
});
