import { describe, it, expect } from 'vitest';
import {
  parseJsonLines,
  convertToImportRecords,
  buildBip329Lines,
  buildBip329Jsonl,
  recordToBip329Line,
  bip329LineKind,
  matchesBip329ExportFilter,
  type Bip329ExportFilter,
  type Bip329FilterableRecord,
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

describe('bip329LineKind', () => {
  it('groups line types into the user-facing kinds', () => {
    expect(bip329LineKind({ type: 'addr', ref: ADDR, label: 'a' })).toBe('address');
    expect(bip329LineKind({ type: 'tx', ref: TXID, label: 't' })).toBe('transaction');
    expect(bip329LineKind({ type: 'output', ref: `${TXID}:0`, label: 'o' })).toBe('utxo');
    expect(bip329LineKind({ type: 'input', ref: `${TXID}:1`, label: 'i' })).toBe('utxo');
  });
});

// A fixture vault covering every kind, two wallets, and two tags.
const FIXTURE: Bip329FilterableRecord[] = [
  { type: 'address', inputString: ADDR, label: 'Cold storage', walletName: 'Savings', tags: ['cold', 'long-term'] },
  { type: 'transaction', inputString: TXID, label: 'Bought coffee', walletName: 'Spending', tags: ['daily'] },
  {
    type: 'transaction',
    inputString: `${TXID2}:1`,
    label: 'Frozen change',
    notes: 'BIP-329 output at index 1. Spendable: false',
    walletName: 'Savings',
    tags: ['cold'],
  },
  {
    type: 'transaction',
    inputString: `${TXID2}:0`,
    label: 'Spent input',
    notes: 'BIP-329 input at index 0',
    walletName: 'Spending',
    tags: [],
  },
  { type: 'address', inputString: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', label: 'Exchange deposit', walletName: undefined, tags: undefined },
];

// Apply the filter exactly the way the export handler does: line conversion
// first (unconvertible rows drop out), then the predicate.
function filteredExport(records: Bip329FilterableRecord[], filter?: Bip329ExportFilter): string {
  const lines = [];
  for (const record of records) {
    const line = recordToBip329Line(record);
    if (line && matchesBip329ExportFilter(record, line, filter)) lines.push(line);
  }
  if (lines.length === 0) return '';
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

describe('matchesBip329ExportFilter', () => {
  it('matches everything with no filter or an empty filter', () => {
    const record = FIXTURE[0];
    const line = recordToBip329Line(record)!;
    expect(matchesBip329ExportFilter(record, line)).toBe(true);
    expect(matchesBip329ExportFilter(record, line, {})).toBe(true);
    expect(matchesBip329ExportFilter(record, line, { kind: 'all', search: '  ' })).toBe(true);
  });

  it('filters by kind: address', () => {
    const jsonl = filteredExport(FIXTURE, { kind: 'address' });
    const parsed = parseJsonLines(jsonl);
    expect(parsed.map(p => p.type)).toEqual(['addr', 'addr']);
  });

  it('filters by kind: transaction excludes inputs/outputs', () => {
    const jsonl = filteredExport(FIXTURE, { kind: 'transaction' });
    const parsed = parseJsonLines(jsonl);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: 'tx', ref: TXID });
  });

  it('filters by kind: utxo keeps both input and output lines', () => {
    const jsonl = filteredExport(FIXTURE, { kind: 'utxo' });
    const parsed = parseJsonLines(jsonl);
    expect(parsed.map(p => p.type).sort()).toEqual(['input', 'output']);
  });

  it('filters by tag', () => {
    const jsonl = filteredExport(FIXTURE, { tag: 'cold' });
    const parsed = parseJsonLines(jsonl);
    expect(parsed).toHaveLength(2);
    expect(parsed.map(p => p.label).sort()).toEqual(['Cold storage', 'Frozen change']);
  });

  it('filters by wallet name exactly', () => {
    const jsonl = filteredExport(FIXTURE, { walletName: 'Spending' });
    const parsed = parseJsonLines(jsonl);
    expect(parsed.map(p => p.label).sort()).toEqual(['Bought coffee', 'Spent input']);
    // A near-miss wallet name matches nothing.
    expect(filteredExport(FIXTURE, { walletName: 'spending' })).toBe('');
  });

  it('filters by free-text search across label, ref, and notes (case-insensitive)', () => {
    // Label match.
    expect(parseJsonLines(filteredExport(FIXTURE, { search: 'COLD STORAGE' }))).toHaveLength(1);
    // Ref match.
    const byRef = parseJsonLines(filteredExport(FIXTURE, { search: TXID2.slice(0, 16) }));
    expect(byRef).toHaveLength(2);
    // Notes match.
    const byNotes = parseJsonLines(filteredExport(FIXTURE, { search: 'spendable: false' }));
    expect(byNotes).toHaveLength(1);
    expect(byNotes[0].label).toBe('Frozen change');
    // No match.
    expect(filteredExport(FIXTURE, { search: 'no-such-text' })).toBe('');
  });

  it('combines filters conjunctively', () => {
    const jsonl = filteredExport(FIXTURE, { kind: 'utxo', walletName: 'Savings', tag: 'cold', search: 'frozen' });
    const parsed = parseJsonLines(jsonl);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: 'output', label: 'Frozen change' });
    // Same filter but a wallet that doesn't own it → empty.
    expect(filteredExport(FIXTURE, { kind: 'utxo', walletName: 'Spending', tag: 'cold', search: 'frozen' })).toBe('');
  });

  it('filtered export round-trips through the importer', () => {
    const jsonl = filteredExport(FIXTURE, { walletName: 'Savings' });
    const parsed = parseJsonLines(jsonl);
    expect(parsed).toHaveLength(2);

    const imported = convertToImportRecords(parsed);
    expect(imported.map(r => ({ type: r.type, inputString: r.inputString, label: r.label }))).toEqual([
      { type: 'address', inputString: ADDR, label: 'Cold storage' },
      { type: 'transaction', inputString: `${TXID2}:1`, label: 'Frozen change' },
    ]);

    // Re-exporting the imported rows reproduces the identical filtered file.
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

  it('filtering never resurrects unexportable rows', () => {
    const rows: Bip329FilterableRecord[] = [
      { type: 'other', inputString: 'something', label: 'note', walletName: 'Savings', tags: ['cold'] },
      { type: 'address', inputString: ADDR, label: '  ', walletName: 'Savings', tags: ['cold'] },
    ];
    expect(filteredExport(rows, { walletName: 'Savings', tag: 'cold' })).toBe('');
  });
});
