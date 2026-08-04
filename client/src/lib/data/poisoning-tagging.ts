import {
  createRecord,
  updateRecord,
  getRecordsByInputStrings,
} from "./record-crud";
import { createTag, syncTagsToMaster } from "./vocabulary-crud";

// ── Address-poisoning tag application ────────────────────────────────────────
//
// Applies user-chosen tags (e.g. "suspected-poisoning") to suspect
// counterparty addresses (or the user's own targeted addresses) from the
// Address Poisoning scan results. Tags are UNION-merged onto existing records
// (QuickTagger-style, never replacing); a suspect address with no vault record
// gets a fresh blockchain-discovered-tier record so curated views stay clean.

export interface TagApplicationSummary {
  /** Records that received at least one new tag. */
  tagged: number;
  /** Records that already carried every requested tag (untouched). */
  alreadyTagged: number;
  /** Newly created records for addresses that had none. */
  created: number;
}

function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && /already exists/i.test(err.message);
}

/**
 * Ensure every requested tag exists in the tag vocabulary. "Already exists"
 * races (e.g. a concurrent import creating the same tag) are tolerated as
 * non-fatal — the goal is that the vocabulary row exists, not who made it.
 */
export async function ensurePoisoningTags(tagNames: string[]): Promise<void> {
  for (const name of tagNames) {
    try {
      await createTag(name);
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
    }
  }
  try {
    await syncTagsToMaster(tagNames);
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
  }
}

/**
 * Apply tags to a set of addresses. For each address:
 *  - existing record → union-merge the tags (no-op when all tags present),
 *  - no record → create a blockchain-discovered-tier address record carrying
 *    the tags, attributed to the poisoning scan.
 *
 * `discoveredInTxid` (per entry) records the dust transaction that surfaced
 * the suspect address.
 */
export async function applyPoisoningTags(
  entries: Array<{ address: string; discoveredInTxid?: string }>,
  tagNames: string[],
): Promise<TagApplicationSummary> {
  const summary: TagApplicationSummary = { tagged: 0, alreadyTagged: 0, created: 0 };
  if (entries.length === 0 || tagNames.length === 0) return summary;

  await ensurePoisoningTags(tagNames);

  // Dedup by address (keep the first discoveredInTxid seen).
  const byAddress = new Map<string, { address: string; discoveredInTxid?: string }>();
  for (const e of entries) {
    if (!e.address || byAddress.has(e.address)) continue;
    byAddress.set(e.address, e);
  }

  const addresses = Array.from(byAddress.keys());
  const existing = await getRecordsByInputStrings(addresses);
  const recordByAddress = new Map<string, (typeof existing)[number]>();
  for (const rec of existing) {
    if (!recordByAddress.has(rec.inputString)) {
      recordByAddress.set(rec.inputString, rec);
    }
  }

  for (const entry of byAddress.values()) {
    const rec = recordByAddress.get(entry.address);
    if (rec && rec.id != null) {
      const merged = Array.from(new Set([...(rec.tags ?? []), ...tagNames]));
      const changed = merged.length !== (rec.tags ?? []).length;
      if (changed) {
        await updateRecord(rec.id, { tags: merged });
        summary.tagged++;
      } else {
        summary.alreadyTagged++;
      }
    } else {
      await createRecord({
        type: "address",
        inputString: entry.address,
        label: "",
        tags: [...tagNames],
        categories: [],
        source: "address-poisoning-scan",
        addressImportance: "blockchain-discovered",
        discoveredInTxid: entry.discoveredInTxid,
      });
      summary.created++;
    }
  }

  return summary;
}
