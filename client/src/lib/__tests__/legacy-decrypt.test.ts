import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row {
  id: number;
  [key: string]: unknown;
}

interface MockTableOptions {
  readError?: () => Error | null;
  writeError?: () => Error | null;
}

function createMockTable(initialRows: Row[], opts: MockTableOptions = {}) {
  const rows = new Map<number, Row>();
  for (const r of initialRows) rows.set(r.id, { ...r });

  const table = {
    _rows: rows,
    where(_field: string) {
      return {
        above(threshold: number) {
          return {
            limit(n: number) {
              return {
                async toArray() {
                  const err = opts.readError?.();
                  if (err) throw err;
                  const sorted = Array.from(rows.values())
                    .filter(r => r.id > threshold)
                    .sort((a, b) => a.id - b.id);
                  return sorted.slice(0, n).map(r => ({ ...r }));
                },
              };
            },
          };
        },
      };
    },
    async bulkPut(items: Row[]) {
      const err = opts.writeError?.();
      if (err) throw err;
      for (const item of items) {
        rows.set(item.id, { ...item });
      }
    },
    async count() {
      return rows.size;
    },
    filter(_fn: (item: Row) => boolean) {
      return {
        count: async () => Array.from(rows.values()).filter(_fn).length,
        limit: (n: number) => ({
          toArray: async () => Array.from(rows.values()).filter(_fn).slice(0, n),
        }),
      };
    },
  };
  return table;
}

const mockTables: Record<string, ReturnType<typeof createMockTable>> = {};

vi.mock('../database', () => ({
  db: new Proxy({}, {
    get: (_t, prop: string) => mockTables[prop],
  }),
}));

vi.mock('../crypto', () => ({
  decrypt: vi.fn(),
}));

import {
  stripLegacyMarkers,
  countUnrecoveredLegacyRows,
  hasUnrecoveredLegacyData,
  isEncryptedPlaceholder,
} from '../legacy-decrypt';

const TABLE_KEYS = [
  'records', 'attachments', 'tags', 'categories', 'owners',
  'walletNames', 'seedNames', 'walletSoftware', 'recordOrigins',
  'transactionParticipants', 'derivationTemplates', 'evidence',
  'evidenceAttachments',
];

function setupAllEmpty() {
  for (const key of TABLE_KEYS) {
    mockTables[key] = createMockTable([]);
  }
}

// Each table's "sentinel" is the first of its historical sensitiveFields. A
// marker row is only safe to strip once that field holds real plaintext again.
// Records → inputString, Tags/Owners → name. These helpers keep the test rows
// readable about which rows are "recovered" vs still "locked".
function recoveredRecord(id: number, extra: Partial<Row> = {}): Row {
  return { id, _legacyEncryptedPayload: `payload-${id}`, inputString: `addr-${id}`, ...extra };
}

describe('isEncryptedPlaceholder', () => {
  it('matches the literal placeholder regardless of case or surrounding space', () => {
    expect(isEncryptedPlaceholder('[encrypted]')).toBe(true);
    expect(isEncryptedPlaceholder('[ENCRYPTED]')).toBe(true);
    expect(isEncryptedPlaceholder('[Encrypted]')).toBe(true);
    expect(isEncryptedPlaceholder('   [encrypted]   ')).toBe(true);
  });

  it('does not match real values or blanks', () => {
    expect(isEncryptedPlaceholder('bc1qrealaddress')).toBe(false);
    expect(isEncryptedPlaceholder('encrypted')).toBe(false);
    expect(isEncryptedPlaceholder('[encrypted] tail')).toBe(false);
    expect(isEncryptedPlaceholder('')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isEncryptedPlaceholder(undefined)).toBe(false);
    expect(isEncryptedPlaceholder(null)).toBe(false);
    expect(isEncryptedPlaceholder(123)).toBe(false);
    expect(isEncryptedPlaceholder({})).toBe(false);
  });
});

describe('stripLegacyMarkers', () => {
  beforeEach(() => {
    setupAllEmpty();
  });

  it('counts rowsBefore as the number of rows carrying any legacy marker key', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'x', inputString: 'addr1' },
      { id: 2, isEncrypted: true, inputString: 'addr2' },
      { id: 3, encryptedPayload: 'y', inputString: 'addr3' },
      { id: 4, label: 'no markers', inputString: 'addr4' },
      { id: 5, _legacyEncryptedPayload: 'z', isEncrypted: true, inputString: 'addr5' },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;
    expect(records.rowsBefore).toBe(4);
    expect(records.rowsCleaned).toBe(4);
  });

  it('rowsRemaining is 0 after a clean strip', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: 'addr1' },
      { id: 2, isEncrypted: true, label: 'foo', inputString: 'addr2' },
    ]);
    mockTables.tags = createMockTable([
      { id: 1, name: 'tag1', encryptedPayload: 'b' },
    ]);

    const result = await stripLegacyMarkers();

    expect(result.totalRemaining).toBe(0);
    expect(result.totalSkippedUnsafe).toBe(0);
    expect(result.verificationErrors).toEqual([]);
    for (const tr of result.tableResults) {
      expect(tr.rowsRemaining).toBe(0);
    }

    // Verify markers actually removed from underlying rows
    const recRows = Array.from(mockTables.records._rows.values());
    for (const r of recRows) {
      expect(r._legacyEncryptedPayload).toBeUndefined();
      expect(r.isEncrypted).toBeUndefined();
      expect(r.encryptedPayload).toBeUndefined();
    }
  });

  it('handles partial marker sets — counted once even with multiple markers', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', isEncrypted: true, encryptedPayload: 'b', inputString: 'addr1' },
      { id: 2, _legacyEncryptedPayload: 'c', inputString: 'addr2' },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;
    expect(records.rowsBefore).toBe(2);
    expect(records.rowsCleaned).toBe(2);
    expect(records.rowsRemaining).toBe(0);
  });

  it('captures table read errors in tableErrors without aborting other tables', async () => {
    mockTables.records = createMockTable(
      [{ id: 1, _legacyEncryptedPayload: 'a', inputString: 'addr1' }],
      { readError: () => new Error('boom-read') },
    );
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'b', name: 'tag1' },
    ]);

    const result = await stripLegacyMarkers();

    expect(result.tableErrors.some(e => e.includes('Records') && e.includes('boom-read'))).toBe(true);
    const tags = result.tableResults.find(t => t.tableName === 'Tags')!;
    expect(tags.rowsBefore).toBe(1);
    expect(tags.rowsCleaned).toBe(1);
    expect(tags.rowsRemaining).toBe(0);
  });

  it('captures table write errors in tableErrors without aborting other tables', async () => {
    mockTables.records = createMockTable(
      [{ id: 1, _legacyEncryptedPayload: 'a', inputString: 'addr1' }],
      { writeError: () => new Error('boom-write') },
    );
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'b', name: 'tag1' },
    ]);

    const result = await stripLegacyMarkers();

    expect(result.tableErrors.some(e => e.includes('Records') && e.includes('boom-write'))).toBe(true);
    // Records still has marker since write failed → verification should detect it
    const records = result.tableResults.find(t => t.tableName === 'Records')!;
    expect(records.rowsBefore).toBe(1);
    expect(records.rowsCleaned).toBe(0);
    expect(records.rowsRemaining).toBe(1);

    const tags = result.tableResults.find(t => t.tableName === 'Tags')!;
    expect(tags.rowsRemaining).toBe(0);
  });

  it('captures verification read errors in verificationErrors', async () => {
    let phase = 0;
    // Allow first reads (strip phase) to succeed, then throw on subsequent reads (verify phase)
    mockTables.records = createMockTable(
      [{ id: 1, _legacyEncryptedPayload: 'a', inputString: 'addr1' }],
      {
        readError: () => {
          phase++;
          // Strip phase issues 1 read (single row + chunk.length < BATCH_SIZE
          // terminates the loop). Verify pass is the 2nd read; throw there.
          return phase >= 2 ? new Error('verify-boom') : null;
        },
      },
    );

    const result = await stripLegacyMarkers();

    expect(result.verificationErrors.some(e => e.includes('verify-boom'))).toBe(true);
    const records = result.tableResults.find(t => t.tableName === 'Records')!;
    // strip succeeded
    expect(records.rowsCleaned).toBe(1);
    // rowsRemaining stays 0 by contract when verification fails
    expect(records.rowsRemaining).toBe(0);
  });

  it('aggregates totals across multiple tables', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: 'addr1' },
      { id: 2, isEncrypted: true, inputString: 'addr2' },
    ]);
    mockTables.tags = createMockTable([
      { id: 1, encryptedPayload: 'b', name: 'tag1' },
    ]);
    mockTables.owners = createMockTable([
      { id: 1, name: 'no-marker' },
    ]);

    const result = await stripLegacyMarkers();

    expect(result.totalBefore).toBe(3);
    expect(result.totalCleaned).toBe(3);
    expect(result.totalRemaining).toBe(0);
  });

  it('captures mid-batch read failures while preserving progress on other tables', async () => {
    // 600 rows → 2 strip chunks of 500 + 100. Fail on the 2nd strip read.
    const rows = Array.from({ length: 600 }, (_, idx) => recoveredRecord(idx + 1));

    let stripReadCount = 0;
    mockTables.records = createMockTable(rows, {
      readError: () => {
        stripReadCount++;
        // 1st read = first 500 rows (strip), 2nd read throws (mid-batch)
        return stripReadCount === 2 ? new Error('mid-batch-boom') : null;
      },
    });
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'tag-payload', name: 'tag1' },
    ]);

    const result = await stripLegacyMarkers();

    expect(result.tableErrors.some(e => e.includes('Records') && e.includes('mid-batch-boom'))).toBe(true);

    const records = result.tableResults.find(t => t.tableName === 'Records')!;
    // First batch (500 rows) was stripped before failure
    expect(records.rowsBefore).toBe(500);
    expect(records.rowsCleaned).toBe(500);

    // Other tables continue normally
    const tags = result.tableResults.find(t => t.tableName === 'Tags')!;
    expect(tags.rowsBefore).toBe(1);
    expect(tags.rowsCleaned).toBe(1);
    expect(tags.rowsRemaining).toBe(0);
  });

  it('reports progress for both strip and verify phases', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: 'addr1' },
    ]);

    const phases: string[] = [];
    await stripLegacyMarkers((p) => {
      phases.push(p.phase);
    });

    expect(phases).toContain('strip');
    expect(phases).toContain('verify');
  });
});

describe('stripLegacyMarkers — safe-strip of still-locked rows', () => {
  beforeEach(() => {
    setupAllEmpty();
  });

  it('never strips a marker from a row whose sentinel is still blank', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'still-locked', inputString: '' },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;

    expect(records.rowsBefore).toBe(1);
    expect(records.rowsCleaned).toBe(0);
    expect(records.rowsSkippedUnsafe).toBe(1);
    // The marker is intentionally kept, so verification still sees it.
    expect(records.rowsRemaining).toBe(1);
    expect(result.totalSkippedUnsafe).toBe(1);

    // The only copy of the data — the encrypted payload — must survive.
    const row = mockTables.records._rows.get(1)!;
    expect(row._legacyEncryptedPayload).toBe('still-locked');
  });

  it('never strips a marker from a row whose sentinel is the [encrypted] placeholder', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'still-locked', inputString: '[encrypted]' },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;

    expect(records.rowsCleaned).toBe(0);
    expect(records.rowsSkippedUnsafe).toBe(1);
    expect(mockTables.records._rows.get(1)!._legacyEncryptedPayload).toBe('still-locked');
  });

  it('strips a marker once the sentinel holds a real plaintext value again', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'x', inputString: 'bc1qrealaddress' },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;

    expect(records.rowsCleaned).toBe(1);
    expect(records.rowsSkippedUnsafe).toBe(0);
    expect(records.rowsRemaining).toBe(0);
    expect(mockTables.records._rows.get(1)!._legacyEncryptedPayload).toBeUndefined();
  });

  it('strips recovered rows but keeps locked rows within the same table', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: 'recovered1' },
      { id: 2, _legacyEncryptedPayload: 'b', inputString: '' },
      { id: 3, _legacyEncryptedPayload: 'c', inputString: '[encrypted]' },
      { id: 4, _legacyEncryptedPayload: 'd', inputString: 'recovered4' },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;

    expect(records.rowsBefore).toBe(4);
    expect(records.rowsCleaned).toBe(2);
    expect(records.rowsSkippedUnsafe).toBe(2);
    expect(records.rowsRemaining).toBe(2);

    expect(mockTables.records._rows.get(1)!._legacyEncryptedPayload).toBeUndefined();
    expect(mockTables.records._rows.get(4)!._legacyEncryptedPayload).toBeUndefined();
    expect(mockTables.records._rows.get(2)!._legacyEncryptedPayload).toBe('b');
    expect(mockTables.records._rows.get(3)!._legacyEncryptedPayload).toBe('c');
  });

  it('aggregates totalSkippedUnsafe across tables', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: '' },
    ]);
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'b', name: '' },
    ]);

    const result = await stripLegacyMarkers();

    expect(result.totalSkippedUnsafe).toBe(2);
    expect(result.totalCleaned).toBe(0);
  });
});

describe('countUnrecoveredLegacyRows', () => {
  beforeEach(() => {
    setupAllEmpty();
  });

  it('counts only rows that have a marker AND a still-locked sentinel', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: '' },
      { id: 2, _legacyEncryptedPayload: 'b', inputString: '[encrypted]' },
      { id: 3, _legacyEncryptedPayload: 'c', inputString: 'recovered' },
      { id: 4, inputString: '' },
    ]);

    const result = await countUnrecoveredLegacyRows();

    expect(result.totalUnrecovered).toBe(2);
    const records = result.perTable.find(t => t.tableName === 'Records')!;
    expect(records.unrecovered).toBe(2);
  });

  it('aggregates unrecovered counts across tables', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: '' },
    ]);
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'b', name: '[encrypted]' },
    ]);

    const result = await countUnrecoveredLegacyRows();

    expect(result.totalUnrecovered).toBe(2);
  });

  it('returns 0 when every marker row is already recovered', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: 'recovered1' },
      { id: 2, _legacyEncryptedPayload: 'b', inputString: 'recovered2' },
    ]);

    const result = await countUnrecoveredLegacyRows();

    expect(result.totalUnrecovered).toBe(0);
  });

  it('stops early when the signal is already aborted', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: '' },
    ]);
    const controller = new AbortController();
    controller.abort();

    const result = await countUnrecoveredLegacyRows(undefined, controller.signal);

    expect(result.totalUnrecovered).toBe(0);
    expect(result.perTable).toEqual([]);
  });
});

describe('hasUnrecoveredLegacyData', () => {
  beforeEach(() => {
    setupAllEmpty();
  });

  it('returns true as soon as one unrecovered row exists', async () => {
    mockTables.owners = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', name: '' },
    ]);

    expect(await hasUnrecoveredLegacyData()).toBe(true);
  });

  it('treats an [encrypted] sentinel as unrecovered', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: '[encrypted]' },
    ]);

    expect(await hasUnrecoveredLegacyData()).toBe(true);
  });

  it('returns false when every marker row is recovered', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a', inputString: 'recovered' },
    ]);

    expect(await hasUnrecoveredLegacyData()).toBe(false);
  });

  it('returns false when there are no markers at all', async () => {
    mockTables.records = createMockTable([
      { id: 1, inputString: 'plain' },
    ]);

    expect(await hasUnrecoveredLegacyData()).toBe(false);
  });
});
