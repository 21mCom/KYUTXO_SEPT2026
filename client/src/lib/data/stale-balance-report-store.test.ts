// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearStaleReport,
  appendStaleReportRows,
  getStaleReportWindow,
  countStaleReportRows,
  exportStaleReport,
} from './stale-balance-report-store';
import type { StaleAddressDetail } from './address-stats';

function makeRow(i: number): StaleAddressDetail {
  return {
    recordId: i,
    address: `addr-${i}`,
    cachedSats: i,
    computedSats: i + 1,
  };
}

describe('stale-balance-report-store', () => {
  beforeEach(async () => {
    await clearStaleReport();
  });

  it('starts empty', async () => {
    expect(await countStaleReportRows()).toBe(0);
    expect(await getStaleReportWindow(0, 100)).toEqual([]);
  });

  it('appends batches and counts them', async () => {
    await appendStaleReportRows([makeRow(0), makeRow(1)]);
    await appendStaleReportRows([makeRow(2)]);
    expect(await countStaleReportRows()).toBe(3);
  });

  it('ignores empty batches', async () => {
    await appendStaleReportRows([]);
    expect(await countStaleReportRows()).toBe(0);
  });

  it('reads contiguous windows in scan order', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => makeRow(i));
    // Stream in several batches to mimic the live check.
    for (let i = 0; i < rows.length; i += 50) {
      await appendStaleReportRows(rows.slice(i, i + 50));
    }
    expect(await countStaleReportRows()).toBe(250);

    const first = await getStaleReportWindow(0, 100);
    expect(first.map((r) => r.recordId)).toEqual(
      Array.from({ length: 100 }, (_, i) => i)
    );

    const middle = await getStaleReportWindow(100, 100);
    expect(middle.map((r) => r.recordId)).toEqual(
      Array.from({ length: 100 }, (_, i) => 100 + i)
    );

    const tail = await getStaleReportWindow(200, 100);
    expect(tail.map((r) => r.recordId)).toEqual(
      Array.from({ length: 50 }, (_, i) => 200 + i)
    );
  });

  it('returns nothing for a non-positive limit', async () => {
    await appendStaleReportRows([makeRow(0)]);
    expect(await getStaleReportWindow(0, 0)).toEqual([]);
  });

  it('clear() empties the store', async () => {
    await appendStaleReportRows([makeRow(0), makeRow(1)]);
    await clearStaleReport();
    expect(await countStaleReportRows()).toBe(0);
  });
});

describe('exportStaleReport', () => {
  beforeEach(async () => {
    await clearStaleReport();
  });

  it('empty store yields a header-only CSV with rowCount 0', async () => {
    const { blob, rowCount } = await exportStaleReport('csv');
    expect(rowCount).toBe(0);
    expect(await blob.text()).toBe('recordId,address,cachedSats,computedSats\n');
    expect(blob.type).toContain('text/csv');
  });

  it('empty store yields an empty JSON array with rowCount 0', async () => {
    const { blob, rowCount } = await exportStaleReport('json');
    expect(rowCount).toBe(0);
    const text = await blob.text();
    expect(text).toBe('[]');
    expect(JSON.parse(text)).toEqual([]);
    expect(blob.type).toContain('application/json');
  });

  it('CSV has the right header, row count, and scan-order rows', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(i));
    await appendStaleReportRows(rows);

    const { blob, rowCount } = await exportStaleReport('csv');
    expect(rowCount).toBe(5);

    const text = await blob.text();
    const lines = text.split('\n');
    // header + 5 data rows + trailing newline => empty final element
    expect(lines[0]).toBe('recordId,address,cachedSats,computedSats');
    expect(lines[lines.length - 1]).toBe('');
    const dataLines = lines.slice(1, -1);
    expect(dataLines).toHaveLength(5);
    expect(dataLines[0]).toBe('0,addr-0,0,1');
    expect(dataLines[4]).toBe('4,addr-4,4,5');
  });

  it('CSV quotes fields containing commas, quotes, and newlines (RFC 4180)', async () => {
    await appendStaleReportRows([
      { recordId: 1, address: 'has,comma', cachedSats: 10, computedSats: 20 },
      { recordId: 2, address: 'has"quote', cachedSats: 30, computedSats: 40 },
      { recordId: 3, address: 'has\nnewline', cachedSats: 50, computedSats: 60 },
      { recordId: 4, address: 'has\r\ncrlf', cachedSats: 70, computedSats: 80 },
      { recordId: 5, address: 'plain', cachedSats: 90, computedSats: 100 },
    ]);

    const { blob, rowCount } = await exportStaleReport('csv');
    expect(rowCount).toBe(5);
    const text = await blob.text();

    expect(text).toContain('1,"has,comma",10,20\n');
    // Embedded double quote is doubled per RFC 4180.
    expect(text).toContain('2,"has""quote",30,40\n');
    expect(text).toContain('3,"has\nnewline",50,60\n');
    expect(text).toContain('4,"has\r\ncrlf",70,80\n');
    // A plain field is not quoted.
    expect(text).toContain('5,plain,90,100\n');
  });

  it('CSV streams correctly across multiple export windows (>1000 rows)', async () => {
    const total = 2350; // spans 3 export windows of 1000
    const rows = Array.from({ length: total }, (_, i) => makeRow(i));
    for (let i = 0; i < rows.length; i += 500) {
      await appendStaleReportRows(rows.slice(i, i + 500));
    }
    expect(await countStaleReportRows()).toBe(total);

    const { blob, rowCount } = await exportStaleReport('csv');
    expect(rowCount).toBe(total);

    const lines = (await blob.text()).split('\n');
    expect(lines[0]).toBe('recordId,address,cachedSats,computedSats');
    const dataLines = lines.slice(1, -1);
    expect(dataLines).toHaveLength(total);
    // Verify the window boundaries (rows 999/1000 and 1999/2000) are intact.
    expect(dataLines[999]).toBe('999,addr-999,999,1000');
    expect(dataLines[1000]).toBe('1000,addr-1000,1000,1001');
    expect(dataLines[1999]).toBe('1999,addr-1999,1999,2000');
    expect(dataLines[2000]).toBe('2000,addr-2000,2000,2001');
    expect(dataLines[total - 1]).toBe('2349,addr-2349,2349,2350');
  });

  it('JSON parses to an array of the exact rows in scan order across windows', async () => {
    const total = 2350; // spans 3 export windows of 1000
    const rows = Array.from({ length: total }, (_, i) => makeRow(i));
    for (let i = 0; i < rows.length; i += 500) {
      await appendStaleReportRows(rows.slice(i, i + 500));
    }

    const { blob, rowCount } = await exportStaleReport('json');
    expect(rowCount).toBe(total);

    const parsed = JSON.parse(await blob.text());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(total);
    // Exact rows, in scan order, with the expected shape.
    expect(parsed[0]).toEqual({
      recordId: 0,
      address: 'addr-0',
      cachedSats: 0,
      computedSats: 1,
    });
    // Window boundaries: commas must join entries across chunk seams.
    expect(parsed[999].recordId).toBe(999);
    expect(parsed[1000].recordId).toBe(1000);
    expect(parsed[1999].recordId).toBe(1999);
    expect(parsed[2000].recordId).toBe(2000);
    expect(parsed[total - 1]).toEqual({
      recordId: 2349,
      address: 'addr-2349',
      cachedSats: 2349,
      computedSats: 2350,
    });
  });

  it('JSON escapes special characters and round-trips exactly', async () => {
    const tricky: StaleAddressDetail[] = [
      { recordId: 1, address: 'quote"and,comma', cachedSats: 1, computedSats: 2 },
      { recordId: 2, address: 'new\nline\ttab', cachedSats: 3, computedSats: 4 },
    ];
    await appendStaleReportRows(tricky);

    const { blob, rowCount } = await exportStaleReport('json');
    expect(rowCount).toBe(2);
    const parsed = JSON.parse(await blob.text());
    expect(parsed).toEqual(tricky);
  });

  it('reports progress with the running written/total counts', async () => {
    const total = 2100;
    await appendStaleReportRows(
      Array.from({ length: total }, (_, i) => makeRow(i)),
    );

    const calls: Array<[number, number]> = [];
    const { rowCount } = await exportStaleReport('csv', (written, t) => {
      calls.push([written, t]);
    });

    expect(rowCount).toBe(total);
    expect(calls).toEqual([
      [1000, total],
      [2000, total],
      [2100, total],
    ]);
  });

  it('rowCount matches the stored count', async () => {
    await appendStaleReportRows(
      Array.from({ length: 123 }, (_, i) => makeRow(i)),
    );
    const stored = await countStaleReportRows();
    const csv = await exportStaleReport('csv');
    const json = await exportStaleReport('json');
    expect(csv.rowCount).toBe(stored);
    expect(json.rowCount).toBe(stored);
  });
});
