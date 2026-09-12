// Save path for Descriptor Import (Task #1556), extracted from the page so the
// create / dedup-update / failure accounting can be unit-tested against the
// real Dexie facade.
//
// Root cause this fixes: the page ended its save by calling the strict
// createOwner/createWalletName/createSeedName/createWalletSoftware helpers,
// guarded only by STALE React hook state. But every createRecord in the loop
// fire-and-forgets syncRecordVocabulary, which inserts the same vocabulary rows
// mid-save — so the final strict create reliably threw "... already exists"
// (e.g. the default walletSoftware "Sparrow"), the whole save surfaced as
// "Save failed" AFTER all rows were written, and step 3 never rendered. Users
// concluded the import was lost. Vocabulary upkeep is now idempotent (ensure*)
// and non-fatal, per-address write errors no longer abort the loop, and the
// completion summary is verified against what is actually in the database.

import {
  createRecord,
  updateRecord,
  lookupRecordsByInputStrings,
} from "@/hooks/use-records";
import {
  computeExistingRecordMerge,
  type MetadataFieldKey,
} from "@/lib/descriptor-import-utils";
import {
  createRecordOrigin,
  captureMergeOrigin,
  syncTagsToMaster,
  syncCategoriesToMaster,
  ensureOwner,
  ensureWalletName,
  ensureSeedName,
  ensureWalletSoftware,
} from "@/lib/dataFacade";

export interface DescriptorSaveAddress {
  address: string;
  chainType: string; // 'receive' | 'change'
  index: number;
}

export interface DescriptorSaveMeta {
  isMultisig: boolean;
  isTaproot: boolean;
  threshold: number;
  keysCount: number;
  scriptType: string;
  tags: string[];
  categories: string[];
  notes?: string;
  seedName?: string;
  walletSoftware?: string;
  owner?: string;
  walletName?: string;
  markAsVerified: boolean;
  sourceName: string;
}

export interface DescriptorSaveFailure {
  address: string;
  reason: string;
}

export interface DescriptorSaveResult {
  created: number;
  updated: number;
  /** Addresses that could not be written, with the reason. Never silent. */
  failures: DescriptorSaveFailure[];
  /** Non-fatal problems (vocabulary upkeep) — the records themselves are fine. */
  warnings: string[];
  /**
   * Post-save verification against the database: how many of the attempted
   * addresses actually resolve to a stored record, and which ones do not.
   * `missing` excludes addresses already reported in `failures`.
   */
  verifiedCount: number;
  missing: string[];
  /**
   * Per-field counts of existing (already-set) values that were KEPT on
   * addresses that already existed in the vault, so the UI can report which
   * user-entered metadata was not applied instead of dropping it silently.
   */
  keptFieldCounts: Partial<Record<MetadataFieldKey, number>>;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function saveDescriptorAddresses(
  addresses: DescriptorSaveAddress[],
  meta: DescriptorSaveMeta,
  onProgress?: (current: number, total: number) => void | Promise<void>,
): Promise<DescriptorSaveResult> {
  const tags = meta.tags.filter((t) => t.trim() !== "");
  const categories = meta.categories.filter((c) => c.trim() !== "");

  const recordLookup = await lookupRecordsByInputStrings(
    addresses.map((a) => a.address),
  );

  const vaultFields = meta.isMultisig
    ? {
        vault: {
          isVaultXpub: true,
          vaultName: meta.walletName || meta.seedName || "Multisig Vault",
          m: meta.threshold,
          n: meta.keysCount,
          vaultNotes: `${meta.threshold}-of-${meta.keysCount} ${meta.scriptType}`,
        },
      }
    : {};
  const walletLabel = meta.isTaproot
    ? meta.walletName || "Taproot"
    : meta.walletName || "Multisig";

  let created = 0;
  let updated = 0;
  const failures: DescriptorSaveFailure[] = [];
  const warnings: string[] = [];
  const keptFieldCounts: Partial<Record<MetadataFieldKey, number>> = {};

  for (let ai = 0; ai < addresses.length; ai++) {
    const addr = addresses[ai];
    if (ai % 10 === 0) {
      await onProgress?.(ai + 1, addresses.length);
      await new Promise((r) => setTimeout(r, 0));
    }

    const label = `${walletLabel} ${addr.chainType === "receive" ? "Receive" : "Change"} #${addr.index}`;

    try {
      const existingRecord = recordLookup.get(addr.address.trim().toLowerCase());

      if (existingRecord) {
        if (existingRecord.id === undefined) {
          // A lookup match with no primary key can be neither updated nor
          // safely re-created (the row exists). Report it instead of silently
          // dropping the address.
          failures.push({
            address: addr.address,
            reason: "Matched an existing record without an id — cannot update",
          });
          continue;
        }

        // Merge policy: tags/categories are unioned; existing scalar fields
        // are kept and reported via keptFieldCounts so entered metadata is
        // never dropped silently.
        const merge = computeExistingRecordMerge(existingRecord, {
          owner: meta.owner || "",
          walletName: meta.walletName || "",
          seedName: meta.seedName || "",
          walletSoftware: meta.walletSoftware || "",
          notes: meta.notes || "",
          tags,
          categories,
        });
        for (const field of merge.keptFields) {
          keptFieldCounts[field] = (keptFieldCounts[field] || 0) + 1;
        }

        let newImportance = existingRecord.addressImportance;
        if (meta.markAsVerified && existingRecord.addressImportance !== "verified") {
          newImportance = "verified";
        } else if (
          existingRecord.addressImportance !== "verified" &&
          existingRecord.addressImportance !== "manual" &&
          existingRecord.addressImportance !== "wallet-import"
        ) {
          newImportance = "xpub-derived";
        }

        await updateRecord(existingRecord.id, {
          tags: merge.tags,
          categories: merge.categories,
          notes: merge.fields.notes,
          seedName: merge.fields.seedName,
          walletSoftware: merge.fields.walletSoftware,
          derivationPath:
            existingRecord.derivationPath || `${addr.chainType}/${addr.index}`,
          owner: merge.fields.owner,
          walletName: merge.fields.walletName,
          addressImportance: newImportance,
          ...vaultFields,
        });

        // Record the incoming metadata as an origin (backfilling a baseline
        // origin first when the record has none) so differing values surface
        // on the Conflict Resolution page. Non-fatal.
        await captureMergeOrigin(existingRecord, {
          originType: "xpub-derived",
          label,
          notes: meta.notes || undefined,
          owner: meta.owner || undefined,
          walletName: meta.walletName || undefined,
          seedName: meta.seedName || undefined,
          walletSoftware: meta.walletSoftware || undefined,
          tags,
          categories,
          source: meta.sourceName,
        });
        updated++;
      } else {
        const recordId = await createRecord({
          type: "address",
          inputString: addr.address,
          label,
          tags,
          categories,
          notes: meta.notes || undefined,
          seedName: meta.seedName || undefined,
          walletSoftware: meta.walletSoftware || undefined,
          derivationPath: `${addr.chainType}/${addr.index}`,
          owner: meta.owner || undefined,
          walletName: meta.walletName || undefined,
          addressImportance: meta.markAsVerified ? "verified" : "xpub-derived",
          ...vaultFields,
        });

        if (recordId) {
          try {
            await createRecordOrigin({
              recordId,
              originType: "xpub-derived",
              label,
              notes: meta.notes || undefined,
              tags,
              categories,
              source: meta.sourceName,
            });
          } catch (e) {
            console.error("Failed to create record origin:", e);
          }
        }
        created++;
      }
    } catch (e) {
      failures.push({ address: addr.address, reason: errMessage(e) });
    }
  }

  // Vocabulary upkeep is idempotent and NON-FATAL: the loop above already
  // fire-and-forgets per-record vocabulary sync, so "already exists" here was
  // the original silent-failure trigger. A vocabulary problem must never make
  // a completed import report "Save failed".
  try {
    if (tags.length > 0) await syncTagsToMaster(tags);
    if (categories.length > 0) await syncCategoriesToMaster(categories);
    if (meta.owner) await ensureOwner(meta.owner);
    if (meta.walletName) await ensureWalletName(meta.walletName);
    if (meta.seedName) await ensureSeedName(meta.seedName);
    if (meta.walletSoftware) await ensureWalletSoftware(meta.walletSoftware);
  } catch (e) {
    warnings.push(`Vocabulary sync problem (records saved fine): ${errMessage(e)}`);
  }

  // Verify the summary against actual database state: every attempted address
  // must now resolve to a stored record. Anything absent (and not already in
  // `failures`) is loudly reported instead of silently counted as saved.
  let verifiedCount = 0;
  const missing: string[] = [];
  try {
    const postLookup = await lookupRecordsByInputStrings(
      addresses.map((a) => a.address),
    );
    const failedSet = new Set(failures.map((f) => f.address));
    for (const addr of addresses) {
      if (postLookup.has(addr.address.trim().toLowerCase())) {
        verifiedCount++;
      } else if (!failedSet.has(addr.address)) {
        missing.push(addr.address);
      }
    }
  } catch (e) {
    warnings.push(`Post-save verification failed: ${errMessage(e)}`);
    verifiedCount = created + updated;
  }

  return { created, updated, failures, warnings, verifiedCount, missing, keptFieldCounts };
}
