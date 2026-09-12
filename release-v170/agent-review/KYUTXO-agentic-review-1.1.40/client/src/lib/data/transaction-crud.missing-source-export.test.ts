// @vitest-environment jsdom
//
// Unit tests for buildMissingSourceJson() and buildMissingSourceCsv() in
// transaction-crud.ts. These pure serialisers back the offline "Download" action
// on the Balance page's "Missing source transactions" dialog, turning the
// in-memory MissingSourceDetail list into a JSON or CSV file the user can feed
// into a wallet export / spreadsheet workflow. They touch no DB or DOM.
//
// fake-indexeddb is imported only because transaction-crud.ts pulls in the Dexie
// db module at import time; the functions under test never read from it.

import "fake-indexeddb/auto";

import { describe, it, expect } from "vitest";
import {
  buildMissingSourceJson,
  buildMissingSourceCsv,
  type MissingSourceDetail,
} from "./transaction-crud";

const SAMPLE: MissingSourceDetail[] = [
  { sourceTxid: "aaa111", spendingTxids: ["spendA", "spendB"] },
  { sourceTxid: "bbb222", spendingTxids: ["spendC"] },
  { sourceTxid: "ccc333", spendingTxids: [] },
];

describe("buildMissingSourceJson", () => {
  it("produces valid, pretty-printed JSON that round-trips to the detail shape", () => {
    const json = buildMissingSourceJson(SAMPLE);
    expect(json).toContain("\n"); // pretty-printed
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([
      { sourceTxid: "aaa111", spendingTxids: ["spendA", "spendB"] },
      { sourceTxid: "bbb222", spendingTxids: ["spendC"] },
      { sourceTxid: "ccc333", spendingTxids: [] },
    ]);
  });

  it("handles an empty list as an empty JSON array", () => {
    expect(JSON.parse(buildMissingSourceJson([]))).toEqual([]);
  });
});

describe("buildMissingSourceCsv", () => {
  it("emits a header row plus one row per source with spends joined by a space", () => {
    const csv = buildMissingSourceCsv(SAMPLE);
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe("source_txid,referencing_spend_txids");
    expect(rows[1]).toBe("aaa111,spendA spendB");
    expect(rows[2]).toBe("bbb222,spendC");
    expect(rows[3]).toBe("ccc333,");
    expect(rows).toHaveLength(4);
  });

  it("emits just the header row for an empty list", () => {
    expect(buildMissingSourceCsv([])).toBe("source_txid,referencing_spend_txids");
  });

  it("quotes and escapes fields containing commas or quotes", () => {
    const csv = buildMissingSourceCsv([
      { sourceTxid: 'tx"weird', spendingTxids: ["a,b", "c"] },
    ]);
    const rows = csv.split("\r\n");
    expect(rows[1]).toBe('"tx""weird","a,b c"');
  });
});
