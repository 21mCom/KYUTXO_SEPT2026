// BIP-329 wallet label format helpers (import parsing + export building).
//
// BIP-329 is a JSONL format: one JSON object per line with fields
// { type, ref, label, origin?, spendable? }. `type` is one of
// tx | addr | pubkey | input | output | xpub. This app imports tx/addr and
// input/output labels (see BIP329Import page) and exports the records
// database back out so labels round-trip to Sparrow/Electrum/etc.

import type { ParsedRecord } from '@/lib/wallet-import/import-manager';
import type { Record as DbRecord } from '@/lib/db-types';

export interface BIP329Record {
  type: 'tx' | 'addr' | 'pubkey' | 'input' | 'output' | 'xpub';
  ref: string;
  label?: string;
  origin?: string;
  spendable?: string;
}

export function parseJsonLines(content: string): BIP329Record[] {
  const records: BIP329Record[] = [];
  const lines = content.split('\n').filter(line => line.trim());

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type && parsed.ref) {
        records.push(parsed as BIP329Record);
      }
    } catch {
      continue;
    }
  }

  return records;
}

export function convertToImportRecords(bip329Records: BIP329Record[]): ParsedRecord[] {
  const records: ParsedRecord[] = [];

  for (const record of bip329Records) {
    const label = record.label || '';

    switch (record.type) {
      case 'tx':
        records.push({
          type: 'transaction',
          inputString: record.ref,
          label: label || 'BIP-329 Transaction',
          notes: record.origin ? `Origin: ${record.origin}` : undefined,
          source: 'BIP-329 Import',
          originalData: record as unknown as { [key: string]: unknown },
        });
        break;

      case 'addr':
        records.push({
          type: 'address',
          inputString: record.ref,
          label: label || 'BIP-329 Address',
          notes: record.origin ? `Origin: ${record.origin}` : undefined,
          source: 'BIP-329 Import',
          isInputAddress: true,
          originalData: record as unknown as { [key: string]: unknown },
        });
        break;

      case 'output':
      case 'input': {
        const [txid, indexStr] = record.ref.split(':');
        if (txid && txid.length >= 64) {
          const typeLabel = record.type === 'output' ? 'Output' : 'Input';
          const indexLabel = indexStr ? `:${indexStr}` : '';
          records.push({
            type: 'transaction',
            inputString: record.ref,
            label: label || `BIP-329 ${typeLabel}${indexLabel}`,
            notes: `BIP-329 ${record.type} at index ${indexStr || 'unknown'}${record.origin ? `. Origin: ${record.origin}` : ''}${record.spendable ? `. Spendable: ${record.spendable}` : ''}`,
            source: 'BIP-329 Import',
            originalData: record as unknown as { [key: string]: unknown },
          });
        }
        break;
      }

      case 'xpub':
      case 'pubkey':
        break;
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Export: records database -> BIP-329 JSONL
// ---------------------------------------------------------------------------

const TXID_RE = /^[0-9a-fA-F]{64}$/;
const OUTPOINT_RE = /^[0-9a-fA-F]{64}:\d+$/;

// A minimal view of a records-table row needed to build an export line, so
// tests don't have to construct full Record objects.
export interface Bip329ExportableRecord {
  type: DbRecord['type'];
  inputString: string;
  label: string;
  notes?: string;
}

export interface Bip329Line {
  type: 'tx' | 'addr' | 'input' | 'output';
  ref: string;
  label: string;
  origin?: string;
  spendable?: string;
}

// Pull an `Origin: <value>` fragment back out of the notes an import wrote.
function extractOrigin(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const m = notes.match(/Origin:\s*(\S+?)\.?(?:\s|$)/);
  return m ? m[1] : undefined;
}

// Pull a `Spendable: <true|false>` fragment back out of imported notes.
function extractSpendable(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const m = notes.match(/Spendable:\s*(true|false)/i);
  return m ? m[1].toLowerCase() : undefined;
}

// Convert one records-table row to a BIP-329 line, or null when the row has
// nothing exportable (no label, non-blockchain identifier, or 'other' type).
export function recordToBip329Line(record: Bip329ExportableRecord): Bip329Line | null {
  const label = (record.label || '').trim();
  if (!label) return null;

  const ref = (record.inputString || '').trim();
  if (!ref) return null;

  if (record.type === 'address') {
    const origin = extractOrigin(record.notes);
    return { type: 'addr', ref, label, ...(origin ? { origin } : {}) };
  }

  if (record.type === 'transaction') {
    if (OUTPOINT_RE.test(ref)) {
      // txid:index rows come from BIP-329 input/output imports; the notes
      // record which side it was. Default to output (the common UTXO case).
      const isInput = /BIP-329 input\b/i.test(record.notes || '');
      const spendable = extractSpendable(record.notes);
      if (isInput) {
        return { type: 'input', ref, label };
      }
      return { type: 'output', ref, label, ...(spendable ? { spendable } : {}) };
    }
    if (TXID_RE.test(ref)) {
      const origin = extractOrigin(record.notes);
      return { type: 'tx', ref, label, ...(origin ? { origin } : {}) };
    }
    // Not a recognizable txid or outpoint — not representable in BIP-329.
    return null;
  }

  // 'other' records have no BIP-329 representation.
  return null;
}

export function buildBip329Lines(records: Bip329ExportableRecord[]): Bip329Line[] {
  const lines: Bip329Line[] = [];
  for (const record of records) {
    const line = recordToBip329Line(record);
    if (line) lines.push(line);
  }
  return lines;
}

// Serialize to JSONL: one compact JSON object per line, trailing newline when
// non-empty (matches Sparrow's output and what parseJsonLines expects).
export function buildBip329Jsonl(records: Bip329ExportableRecord[]): string {
  const lines = buildBip329Lines(records);
  if (lines.length === 0) return '';
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Export filters: free-text search / record kind / tag / wallet
// ---------------------------------------------------------------------------

// The record fields the export filter can match on, beyond what a BIP-329 line
// itself needs. `tags`/`walletName` are optional so tests can still use
// minimal rows; full records-table rows satisfy this interface directly.
export interface Bip329FilterableRecord extends Bip329ExportableRecord {
  tags?: string[];
  walletName?: string;
}

// User-facing grouping of the BIP-329 line types: 'utxo' covers the
// input/output lines (txid:vout refs), matching how the app talks about UTXOs
// everywhere else.
export type Bip329ExportKind = 'address' | 'transaction' | 'utxo';

export interface Bip329ExportFilter {
  // Case-insensitive substring matched against the label, ref, and notes.
  search?: string;
  // 'all' (or undefined) keeps every exportable line.
  kind?: Bip329ExportKind | 'all';
  // Single tag name; records match when they carry this tag.
  tag?: string;
  // Exact wallet name match.
  walletName?: string;
}

export function bip329LineKind(line: Bip329Line): Bip329ExportKind {
  if (line.type === 'addr') return 'address';
  if (line.type === 'tx') return 'transaction';
  return 'utxo'; // 'input' | 'output'
}

// Which export-kind bucket a raw records-table row falls into, without needing
// a BIP-329 line: outpoint-shaped transaction refs are UTXOs (matching
// bip329LineKind for input/output lines); 'other' records have no bucket and
// only survive an 'all' kind filter.
export function recordExportKind(
  record: Pick<Bip329ExportableRecord, 'type' | 'inputString'>
): Bip329ExportKind | 'other' {
  if (record.type === 'address') return 'address';
  if (record.type === 'transaction') {
    return OUTPOINT_RE.test((record.inputString || '').trim()) ? 'utxo' : 'transaction';
  }
  return 'other';
}

// The normalized view of one exportable item the shared filter predicate
// matches against. Both exports (BIP-329 JSONL and CSV) reduce their rows to
// this shape so the filter semantics can never drift between them.
export interface ExportFilterTarget {
  kind: Bip329ExportKind | 'other';
  label: string;
  ref: string;
  notes?: string;
  tags?: string[];
  walletName?: string;
}

// Shared filter predicate for both the BIP-329 and CSV exports.
export function matchesExportFilter(
  target: ExportFilterTarget,
  filter?: Bip329ExportFilter
): boolean {
  if (!filter) return true;

  if (filter.kind && filter.kind !== 'all' && target.kind !== filter.kind) {
    return false;
  }

  if (filter.walletName && target.walletName !== filter.walletName) {
    return false;
  }

  if (filter.tag && !(target.tags ?? []).includes(filter.tag)) {
    return false;
  }

  const search = (filter.search ?? '').trim().toLowerCase();
  if (search) {
    const haystacks = [target.label, target.ref, target.notes ?? ''];
    if (!haystacks.some(h => h.toLowerCase().includes(search))) {
      return false;
    }
  }

  return true;
}

// Decide whether one record (and the BIP-329 line it produced) survives the
// filter. Call recordToBip329Line first and skip the record entirely when it
// returns null — a record with no exportable line can never match.
export function matchesBip329ExportFilter(
  record: Bip329FilterableRecord,
  line: Bip329Line,
  filter?: Bip329ExportFilter
): boolean {
  return matchesExportFilter(
    {
      kind: bip329LineKind(line),
      label: line.label,
      ref: line.ref,
      notes: record.notes,
      tags: record.tags,
      walletName: record.walletName,
    },
    filter
  );
}

// Same predicate applied to a raw records-table row (the CSV export has no
// BIP-329 line — every record is a CSV row).
export function matchesRecordExportFilter(
  record: Bip329FilterableRecord,
  filter?: Bip329ExportFilter
): boolean {
  return matchesExportFilter(
    {
      kind: recordExportKind(record),
      label: record.label || '',
      ref: record.inputString || '',
      notes: record.notes,
      tags: record.tags,
      walletName: record.walletName,
    },
    filter
  );
}
