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
