import { describe, it, expect } from 'vitest';
import {
  parseJsonLines,
  convertToImportRecords,
  buildBip329Lines,
  buildBip329Jsonl,
  recordToBip329Line,
  type Bip329ExportableRecord,
} from './bip329';

const TXID = 'f'.repeat(64);
const TXID2 = 'a'.repeat(63) + 'b';
const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

describe('buildBip329Lines / recordToBip329Line', () => {
  it('maps address records to addr lines', () => {
    expect(
      recordToBip329Line({ type: 'address', inputString: ADDR, label: 'Cold storage' })
    ).toEqual({ type: 'addr', ref: ADDR, label: 'Cold storage' });
  });

  it('maps transaction records with a bare txid to tx lines', () => {
    expect(
      recordToBip329Line({ type: 'transaction', inputString: TXID, label: 'Bought coffee' })
    ).toEqual({ type: 'tx', ref: TXID, label: 'Bought coffee' });
  });

  it('maps txid:vout records to output lines with spendable from notes', () => {
    expect(
      recordToBip329Line({
        type: 'transaction',
        inputString: `${TXID}:1`,
        label: 'Change UTXO',
        notes: 'BIP-329 output at index 1. Spendable: false',
      })
    ).toEqual({ type: 'output', ref: `${TXID}:1`, label: 'Change UTXO', spendable: 'false' });
  });

  it('maps imported input rows back to input lines', () => {
    expect(
      recordToBip329Line({
        type: 'transaction',
        inputString: `${TXID2}:0`,
        label: 'Spent input',
        notes: 'BIP-329 input at index 0',
      })
    ).toEqual({ type: 'input', ref: `${TXID2}:0`, label: 'Spent input' });
  });

  it('round-trips origin through notes', () => {
    expect(
      recordToBip329Line({
        type: 'transaction',
        inputString: TXID,
        label: 'Tx with origin',
        notes: "Origin: wpkh([d34db33f/84'/0'/0'])",
      })
    ).toEqual({
      type: 'tx',
      ref: TXID,
      label: 'Tx with origin',
      origin: "wpkh([d34db33f/84'/0'/0'])",
    });
  });

  it('skips unlabeled, blank-ref, other-type, and non-blockchain refs', () => {
    const records: Bip329ExportableRecord[] = [
      { type: 'address', inputString: ADDR, label: '   ' },
      { type: 'address', inputString: '', label: 'no ref' },
      { type: 'other', inputString: 'something', label: 'note' },
      { type: 'transaction', inputString: 'not-a-txid', label: 'bad ref' },
    ];
    expect(buildBip329Lines(records)).toEqual([]);
  });
});

describe('buildBip329Jsonl', () => {
  it('emits one JSON object per line with trailing newline', () => {
    const jsonl = buildBip329Jsonl([
      { type: 'address', inputString: ADDR, label: 'Addr' },
      { type: 'transaction', inputString: TXID, label: 'Tx' },
    ]);
    expect(jsonl.endsWith('\n')).toBe(true);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ type: 'addr', ref: ADDR, label: 'Addr' });
    expect(JSON.parse(lines[1])).toEqual({ type: 'tx', ref: TXID, label: 'Tx' });
  });

  it('returns an empty string when nothing is exportable', () => {
    expect(buildBip329Jsonl([])).toBe('');
  });

  it('safely encodes labels with quotes, newlines, and unicode', () => {
    const jsonl = buildBip329Jsonl([
      { type: 'address', inputString: ADDR, label: 'He said "hi"\nnew line ☕' },
    ]);
    const parsed = parseJsonLines(jsonl);
    // The embedded newline is JSON-escaped, so the file still has one record per line.
    expect(jsonl.trim().split('\n')).toHaveLength(1);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe('He said "hi"\nnew line ☕');
  });
});

describe('round-trip: export -> parse -> import conversion -> export', () => {
  it('reimporting an export yields the same labels and refs', () => {
    const source: Bip329ExportableRecord[] = [
      { type: 'address', inputString: ADDR, label: 'Cold storage' },
      { type: 'transaction', inputString: TXID, label: 'Bought coffee', notes: 'Origin: wpkh([d34db33f])' },
      {
        type: 'transaction',
        inputString: `${TXID2}:1`,
        label: 'Frozen change',
        notes: 'BIP-329 output at index 1. Spendable: false',
      },
    ];

    const jsonl = buildBip329Jsonl(source);
    const parsed = parseJsonLines(jsonl);
    expect(parsed).toHaveLength(3);

    // Feed the exported file through the same conversion the import page uses.
    const imported = convertToImportRecords(parsed);
    expect(imported.map(r => ({ type: r.type, inputString: r.inputString, label: r.label }))).toEqual([
      { type: 'address', inputString: ADDR, label: 'Cold storage' },
      { type: 'transaction', inputString: TXID, label: 'Bought coffee' },
      { type: 'transaction', inputString: `${TXID2}:1`, label: 'Frozen change' },
    ]);
    // Origin survives into notes on import.
    expect(imported[1].notes).toContain('Origin: wpkh([d34db33f])');
    // Spendable survives into notes on import.
    expect(imported[2].notes).toContain('Spendable: false');

    // Exporting the imported records again reproduces the identical file.
    const reexported = buildBip329Jsonl(
      imported.map(r => ({
        type: r.type as Bip329ExportableRecord['type'],
        inputString: r.inputString,
        label: r.label,
        notes: r.notes,
      }))
    );
    expect(reexported).toBe(jsonl);
  });
});
