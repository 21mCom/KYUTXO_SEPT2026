// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearStaleReport,
  appendStaleReportRows,
  getStaleReportWindow,
  countStaleReportRows,
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
