// @vitest-environment node
//
// Static SCALE GUARD (a "ratchet"): counts the unbounded full-table access
// patterns across the client source. The count may only go DOWN. Any new
// `getAll*()` call-site or direct `db.<bigTable>.toArray()/.toCollection()`
// outside the CRUD definition modules pushes the count above BASELINE and fails
// this test, forcing the author to use a paginated/indexed helper instead.
//
// To intentionally lower the ceiling after removing an offender, drop BASELINE
// to match the new (lower) count.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// client/src — this file lives in client/src/lib.
const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Big tables whose full-table reads are the scale risk we ratchet against.
const BIG_TABLES = ["records", "blockchainTransactions", "transactionParticipants", "attachments"];

const PATTERNS: RegExp[] = [
  // getAllRecords()/getAllTransactions()/getAllTransactionParticipants()/getAllAttachments()
  /\bgetAll(Records|Transactions|TransactionParticipants|Attachments)\s*\(/g,
  // db.<big>.toArray(
  new RegExp(`\\bdb\\.(?:${BIG_TABLES.join("|")})\\.toArray\\s*\\(`, "g"),
  // db.<big>.toCollection(
  new RegExp(`\\bdb\\.(?:${BIG_TABLES.join("|")})\\.toCollection\\s*\\(`, "g"),
  // Full-load CRUD helpers that read an entire type/tier set into memory. The
  // trailing `\s*\(` anchors to the exact call name so we do NOT flag the
  // bounded variants that share a prefix (getRecordsPageByTypeAndImportanceTiersKeyset,
  // getAddressRecordsByImportanceTiersFiltered, getRecordsByTypeFiltered,
  // getRecordsByTypeAndImportanceLimited, countRecordsByTypeAndImportanceTiers).
  /\bgetRecordsByType\s*\(/g,
  /\bgetAddressRecordsByImportanceTiers\s*\(/g,
  /\bgetRecordsByTypeAndImportanceTiers\s*\(/g,
  // useAddressRecords() — the full-load address hook; counts its consumers.
  /\buseAddressRecords\s*\(/g,
];

// The CRUD modules where the bounded helpers AND the (intentional) getAll*/full
// reads are DEFINED. Excluded so the ratchet measures call-sites, not the legit
// definitions. dataFacade only re-exports (no `(`), so it never matches anyway.
const EXCLUDED_FILES = new Set([
  join(SRC_DIR, "lib", "data", "record-crud.ts"),
  join(SRC_DIR, "lib", "data", "transaction-crud.ts"),
  join(SRC_DIR, "lib", "data", "attachments-crud.ts"),
  // use-address-records.ts DEFINES the useAddressRecords full-load hook (and
  // calls getRecordsByType/getRecordsByTypeAndImportanceTiers internally). It is
  // the single chokepoint, so we exclude its definition and ratchet its
  // consumers' useAddressRecords() call-sites instead.
  join(SRC_DIR, "hooks", "use-address-records.ts"),
]);

// Current known offenders (August 2026): 4 getAll* call-sites + 2 direct toArray
// (fund-trail-engine.ts and record-queries.ts) + 1 direct toCollection
// (records-query.ts) + 21 full-load helper call-sites (15 getRecordsByType +
// 2 getAddressRecordsByImportanceTiers + 4 useAddressRecords consumers) = 28.
// (The overview pages — BalanceOverview/WalletOverview — were migrated off the
// useAddressRecords full-load to batched keyset aggregation, which is why those
// consumers no longer appear among the offenders.)
const BASELINE = 28;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function countOffenders(): { total: number; hits: string[] } {
  const files = collectSourceFiles(SRC_DIR);
  const hits: string[] = [];
  for (const file of files) {
    if (EXCLUDED_FILES.has(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches) {
        for (const m of matches) hits.push(`${file.replace(SRC_DIR, "")}: ${m.trim()}`);
      }
    }
  }
  return { total: hits.length, hits };
}

describe("scale ratchet: unbounded full-table access", () => {
  it("does not exceed the known baseline (only allowed to shrink)", () => {
    const { total, hits } = countOffenders();
    if (total > BASELINE) {
      // Surface the offenders to make a failure actionable.
      // eslint-disable-next-line no-console
      console.error("New unbounded full-table access detected:\n" + hits.join("\n"));
    }
    expect(total).toBeLessThanOrEqual(BASELINE);
  });

  it("the scanner actually finds the known patterns (self-check)", () => {
    // If this hits zero, the regexes or path resolution broke and the ratchet
    // would be silently useless.
    const { total } = countOffenders();
    expect(total).toBeGreaterThan(0);
  });
});
