// Natural merge keys for the v3 restore pipeline, shared between the actual
// merge restore (restore.ts) and the read-only merge analysis (analyze.ts) so
// the two can never drift apart: whatever a merge would skip as "already
// present" is exactly what the analysis reports as already present, per table.
//
// Participant, transaction and lineage identities are NOT here — they already
// live in legacy-restore.ts / legacy-restore-misc.ts (participantKey,
// participantMatchKey, mergeDuplicateTransactionsByTxid, lineageIdentity) and
// both pipelines import them from there.

// A record's merge identity is its `inputString` (the address/txid/text itself).
// Records with a blank identity are never de-duped — a merge always inserts
// them, so the analysis always counts them as addable (subject to the
// discovery-only filter).
export function recordMergeIdentity(row: { inputString?: unknown }): string {
  return typeof row.inputString === "string" ? row.inputString : "";
}

// An attachment row's merge identity is its `objectStoragePath`
// (sha256-derived, unique per stored file), falling back to
// `recordId:filename`. `recordId` must already be the LIVE record id the row
// links to (remapped from the backup id by the caller).
export function attachmentMergeKey(
  row: { objectStoragePath?: unknown; filename?: unknown },
  recordId: number,
): string {
  const path = row.objectStoragePath;
  return typeof path === "string" && path !== ""
    ? path
    : `${recordId}:${String(row.filename ?? "")}`;
}

// addressSyncState's merge identity is the `address` (a unique index — a merge
// must skip rows whose address is already present or the insert aborts).
export function syncStateMergeAddress(row: { address?: unknown }): string {
  return typeof row.address === "string" ? row.address : "";
}

// Custody segments merge by their unique `segmentId`. Rows without a string
// segmentId can never collide, so they have no merge identity (always added).
export function segmentMergeId(row: { segmentId?: unknown }): string | null {
  return typeof row.segmentId === "string" ? row.segmentId : null;
}

// Lineage snapshots merge by their unique `snapshotId`, mirroring segments.
export function snapshotMergeId(row: { snapshotId?: unknown }): string | null {
  return typeof row.snapshotId === "string" ? row.snapshotId : null;
}
