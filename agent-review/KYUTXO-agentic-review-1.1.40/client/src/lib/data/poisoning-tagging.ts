import {
  bulkCreateRecords,
  bulkUpdateRecords,
  getRecordsByInputStrings,
} from "./record-crud";
import { ensureTag, syncTagsToMaster } from "./vocabulary-crud";
import { canonicalizeRecordIdentifier } from "../bitcoin";

// ── Address-poisoning tag application ────────────────────────────────────────
//
// Applies user-chosen tags (e.g. "suspected-poisoning") to suspect
// counterparty addresses (or the user's own targeted addresses) from the
// Address Poisoning scan results. Tags are UNION-merged onto existing records
// (QuickTagger-style, never replacing); a suspect address with no vault record
// gets a fresh blockchain-discovered-tier record so curated views stay clean.
//
// SCALE: a 10k-address vault can surface thousands of unique suspects, so
// this path must never issue per-record lookups/writes. Work is processed in
// bounded chunks — chunked anyOf lookups, bulkUpdateRecords for tag merges,
// bulkCreateRecords for missing records — with a cooperative yield between
// chunks so the main thread (and the page's busy spinner) stays responsive.

export interface TagApplicationSummary {
  /** Records that received at least one new tag. */
  tagged: number;
  /** Records that already carried every requested tag (untouched). */
  alreadyTagged: number;
  /** Newly created records for addresses that had none. */
  created: number;
}

export interface ApplyPoisoningTagsOptions {
  /** Called after each processed chunk with cumulative progress. */
  onProgress?: (done: number, total: number) => void;
  /** Chunk size for lookups/writes (default 500). Exposed for tests. */
  chunkSize?: number;
}

/** Addresses per lookup/write chunk. Keeps each Dexie transaction bounded. */
const DEFAULT_CHUNK_SIZE = 500;

/** Let the event loop breathe between chunks so the UI never freezes. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
    await ensureTag(name);
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
 *
 * Processes addresses in bounded chunks using bulk lookups and bulk writes,
 * yielding to the event loop between chunks — thousands of suspects must not
 * freeze the page or take minutes.
 */
export async function applyPoisoningTags(
  entries: Array<{ address: string; discoveredInTxid?: string }>,
  tagNames: string[],
  options?: ApplyPoisoningTagsOptions,
): Promise<TagApplicationSummary> {
  const summary: TagApplicationSummary = { tagged: 0, alreadyTagged: 0, created: 0 };
  if (entries.length === 0 || tagNames.length === 0) return summary;

  const chunkSize = Math.max(1, options?.chunkSize ?? DEFAULT_CHUNK_SIZE);

  await ensurePoisoningTags(tagNames);

  // Dedup by canonical address (keep the first discoveredInTxid seen) so the
  // key space matches what getRecordsByInputStrings / stored records use.
  const byAddress = new Map<string, { address: string; discoveredInTxid?: string }>();
  for (const e of entries) {
    if (!e.address) continue;
    const key = canonicalizeRecordIdentifier(e.address);
    if (byAddress.has(key)) continue;
    byAddress.set(key, e);
  }

  const canonicalAddresses = Array.from(byAddress.keys());
  const total = canonicalAddresses.length;
  let done = 0;

  for (let start = 0; start < total; start += chunkSize) {
    const chunk = canonicalAddresses.slice(start, start + chunkSize);

    const existing = await getRecordsByInputStrings(chunk);
    const recordByAddress = new Map<string, (typeof existing)[number]>();
    for (const rec of existing) {
      if (!recordByAddress.has(rec.inputString)) {
        recordByAddress.set(rec.inputString, rec);
      }
    }

    const updates: Array<{ id: number; changes: { tags: string[] } }> = [];
    const creations: Array<Parameters<typeof bulkCreateRecords>[0][number]> = [];

    for (const canonical of chunk) {
      const entry = byAddress.get(canonical)!;
      const rec = recordByAddress.get(canonical);
      if (rec && rec.id != null) {
        const merged = Array.from(new Set([...(rec.tags ?? []), ...tagNames]));
        if (merged.length !== (rec.tags ?? []).length) {
          updates.push({ id: rec.id, changes: { tags: merged } });
        } else {
          summary.alreadyTagged++;
        }
      } else {
        creations.push({
          type: "address",
          inputString: entry.address,
          label: "",
          tags: [...tagNames],
          categories: [],
          source: "address-poisoning-scan",
          addressImportance: "blockchain-discovered",
          discoveredInTxid: entry.discoveredInTxid,
        });
      }
    }

    if (updates.length > 0) {
      // Tags are vocabulary-synced up front via ensurePoisoningTags; skip the
      // per-call vocabulary pass. Notifications are batched to one at the end.
      const { successCount } = await bulkUpdateRecords(updates, {
        skipVocabularySync: true,
        skipNotification: true,
      });
      summary.tagged += successCount;
    }
    if (creations.length > 0) {
      const ids = await bulkCreateRecords(creations, {
        skipVocabularySync: true,
        skipNotification: true,
      });
      summary.created += ids.length;
    }

    done += chunk.length;
    options?.onProgress?.(done, total);

    // Cooperative yield between chunks: keeps the busy spinner animating and
    // the page interactive while thousands of writes stream through.
    if (start + chunkSize < total) await yieldToMain();
  }

  // Single change notification after all chunks so live queries refresh once.
  if (summary.tagged > 0 || summary.created > 0) {
    const { notifyDbChange } = await import("../database");
    notifyDbChange("records");
  }

  return summary;
}
