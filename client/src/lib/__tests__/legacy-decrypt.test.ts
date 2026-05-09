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

import { stripLegacyMarkers } from '../legacy-decrypt';

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

describe('stripLegacyMarkers', () => {
  beforeEach(() => {
    setupAllEmpty();
  });

  it('counts rowsBefore as the number of rows carrying any legacy marker key', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'x' },
      { id: 2, isEncrypted: true },
      { id: 3, encryptedPayload: 'y' },
      { id: 4, label: 'no markers' },
      { id: 5, _legacyEncryptedPayload: 'z', isEncrypted: true },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;
    expect(records.rowsBefore).toBe(4);
    expect(records.rowsCleaned).toBe(4);
  });

  it('rowsRemaining is 0 after a clean strip', async () => {
    mockTables.records = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'a' },
      { id: 2, isEncrypted: true, label: 'foo' },
    ]);
    mockTables.tags = createMockTable([
      { id: 1, name: 'tag1', encryptedPayload: 'b' },
    ]);

    const result = await stripLegacyMarkers();

    expect(result.totalRemaining).toBe(0);
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
      { id: 1, _legacyEncryptedPayload: 'a', isEncrypted: true, encryptedPayload: 'b' },
      { id: 2, _legacyEncryptedPayload: 'c' },
    ]);

    const result = await stripLegacyMarkers();
    const records = result.tableResults.find(t => t.tableName === 'Records')!;
    expect(records.rowsBefore).toBe(2);
    expect(records.rowsCleaned).toBe(2);
    expect(records.rowsRemaining).toBe(0);
  });

  it('captures table read errors in tableErrors without aborting other tables', async () => {
    mockTables.records = createMockTable(
      [{ id: 1, _legacyEncryptedPayload: 'a' }],
      { readError: () => new Error('boom-read') },
    );
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'b' },
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
      [{ id: 1, _legacyEncryptedPayload: 'a' }],
      { writeError: () => new Error('boom-write') },
    );
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'b' },
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
      [{ id: 1, _legacyEncryptedPayload: 'a' }],
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
      { id: 1, _legacyEncryptedPayload: 'a' },
      { id: 2, isEncrypted: true },
    ]);
    mockTables.tags = createMockTable([
      { id: 1, encryptedPayload: 'b' },
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
    const rows = Array.from({ length: 600 }, (_, idx) => ({
      id: idx + 1,
      _legacyEncryptedPayload: `payload-${idx + 1}`,
    }));

    let stripReadCount = 0;
    mockTables.records = createMockTable(rows, {
      readError: () => {
        stripReadCount++;
        // 1st read = first 500 rows (strip), 2nd read throws (mid-batch)
        return stripReadCount === 2 ? new Error('mid-batch-boom') : null;
      },
    });
    mockTables.tags = createMockTable([
      { id: 1, _legacyEncryptedPayload: 'tag-payload' },
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
      { id: 1, _legacyEncryptedPayload: 'a' },
    ]);

    const phases: string[] = [];
    await stripLegacyMarkers((p) => {
      phases.push(p.phase);
    });

    expect(phases).toContain('strip');
    expect(phases).toContain('verify');
  });
});
