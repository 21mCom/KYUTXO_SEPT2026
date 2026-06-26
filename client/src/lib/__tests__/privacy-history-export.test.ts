import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPrivacyHistoryCsv, buildPrivacyHistoryPdf } from '../privacy-history-export';
import type { PrivacyAuditHistoryEntry } from '../db-types';

// Capture every jspdf-autotable invocation so tests can assert on the head/body
// the PDF builder constructs without parsing the binary output. The real jsPDF
// still runs, so doc.output("blob") returns a valid (table-less) PDF Blob.
const { autoTableCalls } = vi.hoisted(() => ({
  autoTableCalls: [] as { head: unknown[][]; body: unknown[][] }[],
}));
vi.mock('jspdf-autotable', () => ({
  default: (_doc: unknown, options: { head: unknown[][]; body: unknown[][] }) => {
    autoTableCalls.push({ head: options.head, body: options.body });
  },
}));

function makeEntry(overrides: Partial<PrivacyAuditHistoryEntry> = {}): PrivacyAuditHistoryEntry {
  return {
    id: 1,
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    score: 85,
    grade: 'A',
    totalFindings: 2,
    transactionsAnalyzed: 100,
    addressesScanned: 40,
    severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0 },
    findingTypeCounts: { ADDRESS_REUSE: 2 },
    ...overrides,
  };
}

function parse(csv: string): string[][] {
  return csv.split('\r\n').map((line) => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  });
}

describe('buildPrivacyHistoryCsv', () => {
  it('emits a header row and one row per audit run', () => {
    const rows = parse(buildPrivacyHistoryCsv([makeEntry(), makeEntry({ id: 2 })]));
    expect(rows).toHaveLength(3); // header + 2 runs
    expect(rows[0].slice(0, 7)).toEqual([
      'Timestamp (ISO)',
      'Date',
      'Score',
      'Grade',
      'Total Findings',
      'Transactions Analyzed',
      'Addresses Scanned',
    ]);
    expect(rows[0].slice(7, 13)).toEqual(['Critical', 'High', 'Medium', 'Low', 'Owner', 'Wallet']);
  });

  it('includes score, grade, severity, and scope values for each run', () => {
    const rows = parse(
      buildPrivacyHistoryCsv([
        makeEntry({ owner: 'Alice', walletName: 'Cold Storage' }),
      ]),
    );
    const row = rows[1];
    expect(row[2]).toBe('85'); // score
    expect(row[3]).toBe('A'); // grade
    expect(row[4]).toBe('2'); // total findings
    expect(row[7]).toBe('0'); // critical
    expect(row[8]).toBe('1'); // high
    expect(row[9]).toBe('1'); // medium
    expect(row[10]).toBe('0'); // low
    expect(row[11]).toBe('Alice');
    expect(row[12]).toBe('Cold Storage');
  });

  it('defaults owner/wallet scope to "All" when unset', () => {
    const rows = parse(buildPrivacyHistoryCsv([makeEntry()]));
    expect(rows[1][11]).toBe('All');
    expect(rows[1][12]).toBe('All');
  });

  it('creates a union column for every finding type and zero-fills missing ones', () => {
    const csv = buildPrivacyHistoryCsv([
      makeEntry({ id: 1, findingTypeCounts: { ADDRESS_REUSE: 2 } }),
      makeEntry({ id: 2, findingTypeCounts: { COMMON_INPUT_OWNERSHIP: 5 } }),
    ]);
    const rows = parse(csv);
    const header = rows[0];
    // Two distinct finding-type columns appear after the 13 fixed columns.
    expect(header.length).toBe(13 + 2);
    // Each run zero-fills the finding type it did not record.
    const dataValues = rows.slice(1).map((r) => r.slice(13).map(Number));
    for (const counts of dataValues) {
      const total = counts.reduce((a, b) => a + b, 0);
      expect(total === 2 || total === 5).toBe(true);
      expect(counts).toContain(0);
    }
  });

  it('orders runs newest first', () => {
    const older = makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 50 });
    const newer = makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 90 });
    const rows = parse(buildPrivacyHistoryCsv([older, newer]));
    expect(rows[1][2]).toBe('90'); // newest first
    expect(rows[2][2]).toBe('50');
  });

  it('escapes values containing commas or quotes', () => {
    const rows = parse(buildPrivacyHistoryCsv([makeEntry({ owner: 'Smith, John "JB"' })]));
    expect(rows[1][11]).toBe('Smith, John "JB"');
  });
});

describe('buildPrivacyHistoryPdf', () => {
  beforeEach(() => {
    autoTableCalls.length = 0;
  });

  it('returns a non-empty PDF Blob for sample runs', async () => {
    const blob = await buildPrivacyHistoryPdf([makeEntry(), makeEntry({ id: 2 })]);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('builds a runs table with one body row per run, newest first', async () => {
    const older = makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 50, grade: 'C' });
    const newer = makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 90, grade: 'A' });
    await buildPrivacyHistoryPdf([older, newer]);

    const runsTable = autoTableCalls[0];
    expect(runsTable.head[0]).toEqual([
      'Date', 'Score', 'Grade', 'Total', 'Txns', 'Addrs',
      'Crit', 'High', 'Med', 'Low', 'Owner', 'Wallet',
    ]);
    expect(runsTable.body).toHaveLength(2);
    // Newest first: score/grade columns reflect the input.
    expect(runsTable.body[0][1]).toBe('90');
    expect(runsTable.body[0][2]).toBe('A');
    expect(runsTable.body[1][1]).toBe('50');
    expect(runsTable.body[1][2]).toBe('C');
  });

  it('reflects severity and scope values for each run', async () => {
    await buildPrivacyHistoryPdf([
      makeEntry({
        owner: 'Alice',
        walletName: 'Cold Storage',
        totalFindings: 4,
        transactionsAnalyzed: 100,
        addressesScanned: 40,
        severityCounts: { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 0 },
      }),
    ]);
    const row = autoTableCalls[0].body[0] as string[];
    expect(row[3]).toBe('4'); // total
    expect(row[4]).toBe('100'); // txns
    expect(row[5]).toBe('40'); // addrs
    expect(row[6]).toBe('1'); // critical
    expect(row[7]).toBe('2'); // high
    expect(row[8]).toBe('1'); // medium
    expect(row[9]).toBe('0'); // low
    expect(row[10]).toBe('Alice');
    expect(row[11]).toBe('Cold Storage');
  });

  it('defaults owner/wallet scope to "All" when unset', async () => {
    await buildPrivacyHistoryPdf([makeEntry()]);
    const row = autoTableCalls[0].body[0] as string[];
    expect(row[10]).toBe('All');
    expect(row[11]).toBe('All');
  });

  it('adds a findings-by-type table with a column per type, zero-filled', async () => {
    await buildPrivacyHistoryPdf([
      makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), findingTypeCounts: { ADDRESS_REUSE: 2 } }),
      makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), findingTypeCounts: { COMMON_INPUT_OWNERSHIP: 5 } }),
    ]);
    // Two tables: runs table then findings-by-type table.
    expect(autoTableCalls).toHaveLength(2);
    const typeTable = autoTableCalls[1];
    expect(typeTable.head[0]).toEqual(['Date', 'Address Reuse', 'Common Input Ownership']);
    expect(typeTable.body).toHaveLength(2);
    // Newest first (COMMON_INPUT_OWNERSHIP=5 run), zero-filling the unseen type.
    expect((typeTable.body[0] as string[]).slice(1)).toEqual(['0', '5']);
    expect((typeTable.body[1] as string[]).slice(1)).toEqual(['2', '0']);
  });

  it('handles the empty case: a valid Blob with an empty runs table and no type table', async () => {
    const blob = await buildPrivacyHistoryPdf([]);
    expect(blob.size).toBeGreaterThan(0);
    expect(autoTableCalls).toHaveLength(1); // only the runs table
    expect(autoTableCalls[0].body).toHaveLength(0);
  });

  it('handles a single run: one runs row and a findings table', async () => {
    const blob = await buildPrivacyHistoryPdf([makeEntry({ findingTypeCounts: { ADDRESS_REUSE: 2 } })]);
    expect(blob.size).toBeGreaterThan(0);
    expect(autoTableCalls).toHaveLength(2);
    expect(autoTableCalls[0].body).toHaveLength(1);
    expect(autoTableCalls[1].body).toHaveLength(1);
    expect(autoTableCalls[1].head[0]).toEqual(['Date', 'Address Reuse']);
  });

  it('omits the findings-by-type table when no run has any finding types', async () => {
    await buildPrivacyHistoryPdf([
      makeEntry({ id: 1, findingTypeCounts: {} }),
      makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), findingTypeCounts: {} }),
    ]);
    expect(autoTableCalls).toHaveLength(1); // runs table only
  });
});
