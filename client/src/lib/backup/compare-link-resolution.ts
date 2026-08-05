// Read-only resolution of backup-diff row keys against the live vault so the
// Compare Backups drill-down can render a record/address link when (and only
// when) the identifier actually matches a live-vault record. Compared backups
// may come from another device, so an unmatched key stays plain text — we
// never guess.

import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import { canonicalizeRecordIdentifier } from "@/lib/bitcoin";
import type { Record as VaultRecord } from "@/lib/db-types";

// How many identifiers a single Dexie anyOf lookup may carry. Resolution is
// batched per visible window, so this is just a safety cap for pathological
// windows.
const RESOLVE_CHUNK = 500;

/**
 * Extract the live-vault identifier a diff entry's natural key represents, or
 * null when the key is not a vault identifier (synthetic `#id:`/`#row:` keys,
 * tables keyed by names or composite ids). Only tables whose keys ARE
 * addresses/txids/inputStrings are linkable:
 *  - records: keyed by the record's canonical inputString.
 *  - blockchainTransactions: keyed by txid.
 *  - addressSyncState: keyed by address.
 *  - dustFlags: keyed by outpoint (`txid:vout`) — the txid part is linkable.
 */
export function diffKeyIdentifier(table: string, key: string): string | null {
  if (!key || key.startsWith("#")) return null;
  switch (table) {
    case "records":
    case "blockchainTransactions":
    case "addressSyncState":
      return key;
    case "dustFlags": {
      const m = /^([0-9a-fA-F]{64}):\d+$/.exec(key);
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

/** Canonical lookup key for an identifier (matches stored inputString). */
export function canonicalDiffIdentifier(identifier: string): string {
  return canonicalizeRecordIdentifier(identifier);
}

function selectBest(records: VaultRecord[]): VaultRecord {
  // Prefer the lowest id for determinism when duplicates exist (collisions
  // are reported elsewhere, never merged).
  return records.reduce((a, b) =>
    (a.id ?? Number.MAX_SAFE_INTEGER) <= (b.id ?? Number.MAX_SAFE_INTEGER) ? a : b
  );
}

/**
 * Batch-resolve identifiers against the live vault, read-only. Returns a map
 * of canonical identifier -> live record id for every identifier that matched;
 * unmatched identifiers are simply absent.
 */
export async function resolveDiffIdentifiers(
  identifiers: Iterable<string>
): Promise<Map<string, number>> {
  const unique = Array.from(new Set(Array.from(identifiers, canonicalDiffIdentifier)));
  const result = new Map<string, number>();
  for (let i = 0; i < unique.length; i += RESOLVE_CHUNK) {
    const chunk = unique.slice(i, i + RESOLVE_CHUNK);
    const rows = await getRecordsByInputStrings(chunk);
    const byIdentity = new Map<string, VaultRecord[]>();
    for (const r of rows) {
      if (typeof r.id !== "number" || typeof r.inputString !== "string") continue;
      const list = byIdentity.get(r.inputString);
      if (list) list.push(r);
      else byIdentity.set(r.inputString, [r]);
    }
    for (const [identity, list] of byIdentity) {
      const best = selectBest(list);
      if (typeof best.id === "number") result.set(identity, best.id);
    }
  }
  return result;
}
