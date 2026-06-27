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

// Wrap the real jsPDF so PDF content still draws onto a genuine doc
// (doc.output("blob") returns a valid PDF), while every vector drawing call
// (rect/line/circle) and every text() call is recorded. The summary line is
// drawn via doc.text() and the score-trend chart via rect/line/circle, so
// recording these lets the tests assert geometry/content without parsing the
// binary output. Methods are wrapped per-instance because jsPDF assigns some
// (e.g. text) as own properties rather than on the prototype.
const { drawCalls } = vi.hoisted(() => ({
  drawCalls: { rect: [], line: [], circle: [], text: [] } as Record<string, unknown[][]>,
}));
vi.mock('jspdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jspdf')>();
  const RealJsPDF = actual.jsPDF;
  function Wrapped(...args: unknown[]) {
    const doc = new (RealJsPDF as new (...a: unknown[]) => InstanceType<typeof RealJsPDF>)(
      ...args,
    ) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of Object.keys(drawCalls)) {
      const orig = doc[name].bind(doc);
      doc[name] = (...a: unknown[]) => {
        drawCalls[name].push(a);
        return orig(...a);
      };
    }
    return doc;
  }
  (Wrapped as unknown as { API: unknown }).API = RealJsPDF.API;
  return { ...actual, default: Wrapped, jsPDF: Wrapped };
});

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

  it('reflects each run scope (owner-only, wallet-only, both, neither) in the Owner/Wallet columns', () => {
    // One run per scope combination so a reviewer of the exported file can tell
    // a filtered run apart from a full-vault run — the same disambiguation the
    // on-screen scope badge provides.
    const cases = [
      { entry: makeEntry({ id: 1, owner: 'Alice' }), owner: 'Alice', wallet: 'All' }, // owner-only
      { entry: makeEntry({ id: 2, walletName: 'Cold Storage' }), owner: 'All', wallet: 'Cold Storage' }, // wallet-only
      { entry: makeEntry({ id: 3, owner: 'Bob', walletName: 'Trading' }), owner: 'Bob', wallet: 'Trading' }, // both
      { entry: makeEntry({ id: 4 }), owner: 'All', wallet: 'All' }, // neither (full-vault)
    ];
    for (const { entry, owner, wallet } of cases) {
      const rows = parse(buildPrivacyHistoryCsv([entry]));
      expect(rows[1][11]).toBe(owner);
      expect(rows[1][12]).toBe(wallet);
    }
  });

  it('keeps each run scope on its own row in a single multi-run export', () => {
    // All four scope variants in ONE export call guards against cross-row
    // contamination (one run's scope bleeding into another row).
    const rows = parse(
      buildPrivacyHistoryCsv([
        makeEntry({ id: 1, owner: 'Alice' }), // owner-only
        makeEntry({ id: 2, walletName: 'Cold Storage' }), // wallet-only
        makeEntry({ id: 3, owner: 'Bob', walletName: 'Trading' }), // both
        makeEntry({ id: 4 }), // neither (full-vault)
      ]),
    );
    const pairs = rows.slice(1).map((r) => [r[11], r[12]]);
    expect(pairs).toHaveLength(4);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['Alice', 'All'],
        ['All', 'Cold Storage'],
        ['Bob', 'Trading'],
        ['All', 'All'],
      ]),
    );
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

  it('renders the "Date" cell in the human-readable locale format, not epoch/ISO', () => {
    const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
    const rows = parse(buildPrivacyHistoryCsv([makeEntry({ timestamp: ts })]));
    const isoCell = rows[1][0];
    const dateCell = rows[1][1];
    const expected = new Date(ts).toLocaleString();
    // The "Date" column is the formatted timestamp, never a raw epoch or ISO string.
    expect(dateCell).toBe(expected);
    expect(dateCell).not.toBe(String(ts));
    expect(dateCell).not.toBe(new Date(ts).toISOString());
    // The "Timestamp (ISO)" column stays the ISO string, so the two columns
    // can't silently collapse to the same value.
    expect(isoCell).toBe(new Date(ts).toISOString());
    expect(isoCell).not.toBe(dateCell);
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

  it('renders the runs-table "Date" cell in the human-readable locale format, not epoch/ISO', async () => {
    const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
    await buildPrivacyHistoryPdf([makeEntry({ timestamp: ts })]);
    const dateCell = (autoTableCalls[0].body[0] as string[])[0];
    const expected = new Date(ts).toLocaleString();
    expect(dateCell).toBe(expected);
    // The cell must be the formatted timestamp, never a raw epoch or ISO string.
    expect(dateCell).not.toBe(String(ts));
    expect(dateCell).not.toBe(new Date(ts).toISOString());
  });

  it('renders the findings-by-type "Date" cell in the same human-readable locale format', async () => {
    const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
    await buildPrivacyHistoryPdf([makeEntry({ timestamp: ts, findingTypeCounts: { ADDRESS_REUSE: 2 } })]);
    // autoTableCalls[1] is the findings-by-type table.
    const dateCell = (autoTableCalls[1].body[0] as string[])[0];
    const expected = new Date(ts).toLocaleString();
    expect(dateCell).toBe(expected);
    expect(dateCell).not.toBe(String(ts));
    expect(dateCell).not.toBe(new Date(ts).toISOString());
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

  it('reflects each run scope (owner-only, wallet-only, both, neither) in the runs table', async () => {
    // Mirror the CSV scope coverage: every combination must surface in the PDF
    // runs table so an exported audit can't be mistaken for a full-vault run.
    const cases = [
      { entry: makeEntry({ id: 1, owner: 'Alice' }), owner: 'Alice', wallet: 'All' }, // owner-only
      { entry: makeEntry({ id: 2, walletName: 'Cold Storage' }), owner: 'All', wallet: 'Cold Storage' }, // wallet-only
      { entry: makeEntry({ id: 3, owner: 'Bob', walletName: 'Trading' }), owner: 'Bob', wallet: 'Trading' }, // both
      { entry: makeEntry({ id: 4 }), owner: 'All', wallet: 'All' }, // neither (full-vault)
    ];
    for (const { entry, owner, wallet } of cases) {
      autoTableCalls.length = 0;
      await buildPrivacyHistoryPdf([entry]);
      const row = autoTableCalls[0].body[0] as string[];
      expect(row[10]).toBe(owner);
      expect(row[11]).toBe(wallet);
    }
  });

  it('keeps each run scope on its own runs-table row in a single multi-run export', async () => {
    // All four scope variants in ONE export call guards against cross-row
    // contamination in the PDF runs table.
    await buildPrivacyHistoryPdf([
      makeEntry({ id: 1, owner: 'Alice' }), // owner-only
      makeEntry({ id: 2, walletName: 'Cold Storage' }), // wallet-only
      makeEntry({ id: 3, owner: 'Bob', walletName: 'Trading' }), // both
      makeEntry({ id: 4 }), // neither (full-vault)
    ]);
    const pairs = (autoTableCalls[0].body as string[][]).map((r) => [r[10], r[11]]);
    expect(pairs).toHaveLength(4);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['Alice', 'All'],
        ['All', 'Cold Storage'],
        ['Bob', 'Trading'],
        ['All', 'All'],
      ]),
    );
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

// The summary line ("N audit runs | +X pts overall | latest S/100 (grade)") is
// drawn directly via doc.text(), not through autotable, so it is verified by
// reading back the recorded doc.text(...) calls (see the jspdf wrapper above)
// and picking the string drawn at the summary anchor (x=14, y=27).
describe('buildPrivacyHistoryPdf summary line', () => {
  beforeEach(() => {
    drawCalls.text.length = 0;
  });

  /** The summary string drawn at the summary anchor (x=14, y=27). */
  function summaryText(): string | undefined {
    const call = drawCalls.text.find((args) => args[1] === 14 && args[2] === 27);
    return call?.[0] as string | undefined;
  }

  it('single run: uses the singular "audit run", omits the delta, shows the latest score', async () => {
    await buildPrivacyHistoryPdf([makeEntry({ score: 85, grade: 'A' })]);
    expect(summaryText()).toBe('1 audit run  |  latest 85/100 (A)');
  });

  it('multi-run improving: plural runs, signed positive delta, latest score', async () => {
    const older = makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 50, grade: 'C' });
    const newer = makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 90, grade: 'A' });
    await buildPrivacyHistoryPdf([older, newer]);
    expect(summaryText()).toBe('2 audit runs  |  +40 pts overall  |  latest 90/100 (A)');
  });

  it('multi-run declining: plural runs, negative delta keeps its minus sign, latest score', async () => {
    const older = makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 90, grade: 'A' });
    const newer = makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 75, grade: 'B' });
    await buildPrivacyHistoryPdf([older, newer]);
    expect(summaryText()).toBe('2 audit runs  |  -15 pts overall  |  latest 75/100 (B)');
  });

  it('computes the delta chronologically regardless of input order', async () => {
    const older = makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 50, grade: 'C' });
    const newer = makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 90, grade: 'A' });
    // Pass newest-first to ensure the builder sorts before computing the delta.
    await buildPrivacyHistoryPdf([newer, older]);
    expect(summaryText()).toBe('2 audit runs  |  +40 pts overall  |  latest 90/100 (A)');
  });

  it('multi-run with no net change shows an unsigned zero delta', async () => {
    const older = makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 80, grade: 'A' });
    const newer = makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 80, grade: 'A' });
    await buildPrivacyHistoryPdf([older, newer]);
    expect(summaryText()).toBe('2 audit runs  |  0 pts overall  |  latest 80/100 (A)');
  });
});

// The report title ("Privacy Score History") and the two footer lines
// ("Generated: <timestamp>" and the "KYUTXO — generated offline" branding) are
// drawn directly via doc.text(), not through autotable, so they are verified by
// reading back the recorded doc.text(...) calls (see the jspdf wrapper above).
describe('buildPrivacyHistoryPdf title and footer', () => {
  beforeEach(() => {
    drawCalls.text.length = 0;
  });

  it('draws the report title at the title anchor (x=14, y=20)', async () => {
    await buildPrivacyHistoryPdf([makeEntry()]);
    const call = drawCalls.text.find((args) => args[1] === 14 && args[2] === 20);
    expect(call?.[0]).toBe('Privacy Score History');
  });

  it('draws both footer lines, including the offline-branding string', async () => {
    await buildPrivacyHistoryPdf([makeEntry()]);
    const labels = drawCalls.text.map((c) => c[0]) as string[];
    // The "Generated:" footer carries a runtime timestamp, so match by prefix.
    expect(labels.some((s) => s.startsWith('Generated: '))).toBe(true);
    // The offline-branding footer is a fixed string.
    expect(labels).toContain('KYUTXO — generated offline');
  });

  it('renders the "Generated:" footer timestamp in the human-readable locale format', async () => {
    // Pin the wall clock so the footer's `new Date()` is deterministic, then
    // assert the exact rendered string. This locks the format down: a regression
    // that swapped toLocaleString() for an ISO string or a raw epoch number
    // would no longer match.
    const fixedNow = new Date(Date.UTC(2026, 5, 27, 9, 30, 0));
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      await buildPrivacyHistoryPdf([makeEntry()]);
    } finally {
      vi.useRealTimers();
    }
    const labels = drawCalls.text.map((c) => c[0]) as string[];
    const generated = labels.find((s) => s.startsWith('Generated: '));
    const expected = fixedNow.toLocaleString();
    expect(generated).toBe(`Generated: ${expected}`);
    // Guard against the two most likely format regressions explicitly.
    expect(generated).not.toBe(`Generated: ${fixedNow.toISOString()}`);
    expect(generated).not.toBe(`Generated: ${fixedNow.getTime()}`);
  });
});

// The score-trend sparkline is drawn with raw jsPDF vector primitives (rect for
// the frame, line for the threshold guides + connecting segments, circle for the
// point markers). autoTable is mocked, so the only rect/line/circle calls that
// reach the real jsPDF come from drawScoreTrend — letting us assert the chart
// geometry from the recorded drawCalls.
describe('buildPrivacyHistoryPdf score-trend chart', () => {
  beforeEach(() => {
    autoTableCalls.length = 0;
    drawCalls.rect.length = 0;
    drawCalls.line.length = 0;
    drawCalls.circle.length = 0;
    drawCalls.text.length = 0;
  });

  it('draws the trend chart (frame, threshold guides, segments, markers) for 2+ runs', async () => {
    await buildPrivacyHistoryPdf([
      makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 50 }),
      makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 90 }),
      makeEntry({ id: 3, timestamp: Date.UTC(2026, 0, 3), score: 70 }),
    ]);

    // Single plot frame.
    expect(drawCalls.rect).toHaveLength(1);
    // One marker per point.
    expect(drawCalls.circle).toHaveLength(3);
    // Two threshold guide lines + (n-1) connecting segments.
    expect(drawCalls.line).toHaveLength(2 + 2);
  });

  it('draws the A/C threshold guide lines (80 and 60) as horizontal rules with labels', async () => {
    await buildPrivacyHistoryPdf([
      makeEntry({ id: 1, timestamp: Date.UTC(2026, 0, 1), score: 50 }),
      makeEntry({ id: 2, timestamp: Date.UTC(2026, 0, 2), score: 90 }),
    ]);

    // The first two line() calls are the threshold guides, drawn before any
    // connecting segment; each spans the plot width at a constant y (horizontal).
    const guides = drawCalls.line.slice(0, 2) as number[][];
    expect(guides).toHaveLength(2);
    for (const [x1, y1, x2, y2] of guides) {
      expect(y1).toBe(y2); // horizontal rule
      expect(x2).toBeGreaterThan(x1); // spans left → right
    }
    // The two guides sit at distinct heights (the 80 vs 60 thresholds).
    expect(guides[0][1]).not.toBe(guides[1][1]);

    // Each guide is labelled with its threshold score.
    const labels = drawCalls.text.map((c) => c[0]);
    expect(labels).toContain('80');
    expect(labels).toContain('60');
  });

  it('no-ops the chart (no frame, guides, or markers) for a single run', async () => {
    await buildPrivacyHistoryPdf([makeEntry()]);

    expect(drawCalls.rect).toHaveLength(0);
    expect(drawCalls.line).toHaveLength(0);
    expect(drawCalls.circle).toHaveLength(0);
  });

  it('no-ops the chart for the empty case', async () => {
    await buildPrivacyHistoryPdf([]);

    expect(drawCalls.rect).toHaveLength(0);
    expect(drawCalls.line).toHaveLength(0);
    expect(drawCalls.circle).toHaveLength(0);
  });
});
