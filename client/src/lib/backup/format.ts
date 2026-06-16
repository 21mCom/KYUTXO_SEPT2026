// Streaming backup format (v3).
//
// A v3 backup is a ZIP laid out so it can be both WRITTEN and READ without ever
// holding the whole vault in memory:
//
//   backup.json                          <- small manifest (this module's types)
//   tables/records.ndjson                <- one JSON batch (array) per line
//   tables/blockchainTransactions.ndjson
//   tables/transactionParticipants.ndjson
//   tables/attachments.ndjson            <- attachment METADATA rows
//   tables/addressSyncState.ndjson
//   attachments/<relPath>                <- attachment file bytes, one entry each
//
// The five large tables are streamed line-by-line; every other (small) table is
// carried inline inside the manifest. Entry order matters for restore: the
// manifest is first, then records (which assigns the old->new id map), then the
// record-dependent tables, so a single forward pass can relink everything.
//
// Encryption: AES-GCM per line/blob (never the whole vault as one string), key
// derived from the password with PBKDF2 (see ../crypto). Each encrypted NDJSON
// line is the base64 envelope returned by encrypt(); base64 contains no newline
// so it is a safe single line. The inline tables are encrypted as one string.

import { encrypt, decrypt } from "@/lib/crypto";

export const BACKUP_FORMAT_VERSION = 3;
export const MANIFEST_FILENAME = "backup.json";
export const TABLES_DIR = "tables";
export const ATTACHMENTS_DIR = "attachments";

// Validates the password before any destructive restore work: decrypting this
// must yield the sentinel, otherwise the supplied password is wrong.
export const CHECK_SENTINEL = "KYUTXO-BACKUP-V3";

// The large tables streamed as NDJSON (one batch per line), in restore order.
// records MUST come first so its old->new id map exists before dependents load.
export const STREAMED_TABLES = [
  "records",
  "attachments",
  "transactionParticipants",
  "addressSyncState",
  "blockchainTransactions",
] as const;
export type StreamedTable = (typeof STREAMED_TABLES)[number];

export interface BackupCounts {
  records: number;
  blockchainTransactions: number;
  transactionParticipants: number;
  attachments: number;
  addressSyncState: number;
  attachmentFiles: number;
}

export interface BackupManifest {
  formatVersion: number; // 3
  app: string; // "KYUTXO"
  appVersion: string;
  exportDate: string;
  encrypted: boolean;
  salt?: string; // base64, present iff encrypted
  check?: string; // encrypt(CHECK_SENTINEL), present iff encrypted
  counts: BackupCounts;
  streamedTables: string[];
  // Small tables. Plaintext backups use `inline`; encrypted backups use
  // `inlineEnc` (a single base64 envelope of JSON.stringify(inline)).
  inline?: Record<string, unknown>;
  inlineEnc?: string;
}

export function ndjsonPath(table: StreamedTable): string {
  return `${TABLES_DIR}/${table}.ndjson`;
}

export function isStreamedTablePath(name: string): StreamedTable | null {
  for (const t of STREAMED_TABLES) {
    if (name === ndjsonPath(t)) return t;
  }
  return null;
}

// Is this a v3 manifest (as opposed to a legacy single-object backup, which has
// a `.data` field and no formatVersion)?
export function isV3Manifest(obj: unknown): obj is BackupManifest {
  return (
    !!obj &&
    typeof obj === "object" &&
    (obj as BackupManifest).formatVersion === BACKUP_FORMAT_VERSION
  );
}

// ---- per-line / inline serialization -------------------------------------

export async function serializeBatchLine(
  rows: unknown[],
  key: CryptoKey | null,
): Promise<string> {
  const json = JSON.stringify(rows);
  if (!key) return json + "\n";
  return (await encrypt(json, key)) + "\n";
}

export async function parseBatchLine(
  line: string,
  key: CryptoKey | null,
): Promise<unknown[]> {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (!key) return JSON.parse(trimmed) as unknown[];
  const json = await decrypt(trimmed, key);
  return JSON.parse(json) as unknown[];
}

export async function serializeInline(
  obj: Record<string, unknown>,
  key: CryptoKey | null,
): Promise<{ inline?: Record<string, unknown>; inlineEnc?: string }> {
  if (!key) return { inline: obj };
  return { inlineEnc: await encrypt(JSON.stringify(obj), key) };
}

export async function parseInline(
  manifest: BackupManifest,
  key: CryptoKey | null,
): Promise<Record<string, unknown>> {
  if (manifest.inlineEnc != null) {
    if (!key) throw new Error("Encrypted backup requires a password");
    return JSON.parse(await decrypt(manifest.inlineEnc, key)) as Record<string, unknown>;
  }
  return (manifest.inline as Record<string, unknown>) ?? {};
}
