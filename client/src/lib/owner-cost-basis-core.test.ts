import { describe, expect, it } from 'vitest';
import { allocateSatsProportionally, calculateOwnerCostBasis, pageOwnerCostBasis, selectOwnerCostBasisReport, UNASSIGNED_COST_BASIS_OWNER } from './owner-cost-basis-core';
import { calculateOwnerCostBasisFromStoredRows } from './owner-cost-basis-storage';

const owners = [{ id: 1, name: 'Alice', createdAt: 1 }, { id: 2, name: 'Bob', createdAt: 1 }];
const base = {
  owners, addresses: [{ address: 'a', owner: 'Alice' }, { address: 'b', owner: 'Bob' }, { address: 'blank', owner: '' }],
  residencies: [{ id: 1, ownerId: 1, startDate: '2024-01-01', endDate: '2024-06-30', jurisdiction: 'US', matchingMethod: 'lifo' as const, createdAt: 1, updatedAt: 1 },
    { id: 2, ownerId: 1, startDate: '2024-07-02', jurisdiction: 'CA', matchingMethod: 'hifo' as const, createdAt: 1, updatedAt: 1 }],
};

describe('owner cost-basis book', () => {
  it('uses inclusive residency boundaries and visibly falls back during a gap', () => {
    const ownersWithDefault = [{ ...owners[0], defaultMatchingMethod: 'hifo' as const }, owners[1]];
    const report = calculateOwnerCostBasis({ ...base,
      addresses: [...base.addresses, { address: 'c', owner: 'Carol' }], transactions: [
      { txid: 'one', date: '2024-01-01', costBasisUsd: 10 }, { txid: 'two', date: '2024-06-30', costBasisUsd: 20 },
      { txid: 'sell', date: '2024-07-01', proceedsUsd: 40 }],
    owners: ownersWithDefault, participants: [
      { txid: 'one', role: 'output', address: 'a', amount: 10, vout: 0 }, { txid: 'two', role: 'output', address: 'a', amount: 10, vout: 0 },
      { txid: 'sell', role: 'input', address: 'a', amount: 10 }, { txid: 'sell', role: 'output', address: 'merchant', amount: 10, vout: 0 },
    ] });
    expect(report.disposals.find(x => x.kind === 'external')?.matchingMethod).toBe('hifo');
    expect(report.warnings.some(x => x.code === 'residency-gap' && x.date === '2024-07-01')).toBe(true);
  });

  it('keeps gifts carry-over but records a related market-value sale/step-up', () => {
    const common = { ...base, transactions: [{ txid: 'buy', date: '2024-01-01', costBasisUsd: 100 }, { txid: 'move', date: '2024-02-01' }],
      participants: [{ txid: 'buy', role: 'output' as const, address: 'a', amount: 100, vout: 0 }, { txid: 'move', role: 'input' as const, address: 'a', amount: 100 }, { txid: 'move', role: 'output' as const, address: 'b', amount: 100, vout: 0 }] };
    const gift = calculateOwnerCostBasis(common);
    expect(gift.disposals[0]).toMatchObject({ kind: 'owner-transfer', costUsd: 100, proceedsProvenance: 'unknown', transferBasisRule: 'carry-over' });
    const sale = calculateOwnerCostBasis({ ...common, legs: [{ txid: 'move', legKey: 'output:0', transferBasisRule: 'market-value-step-up', marketValueUsd: 160 }] });
    expect(sale.disposals[0]).toMatchObject({ proceedsUsd: 160, proceedsProvenance: 'provided' });
    expect(sale.batches.find(x => x.owner === 'Bob')?.costUsd).toBe(160);
  });

  it('apportions one stepped-up recipient output across source owners without duplicating proceeds', () => {
    const report = calculateOwnerCostBasis({
      ...base,
      owners: [...owners, { id: 3, name: 'Carol', createdAt: 1 }],
      addresses: [...base.addresses, { address: 'c', owner: 'Carol' }],
      transactions: [
      { txid: 'alice-buy', date: '2024-01-01', costBasisUsd: 30 },
      { txid: 'bob-buy', date: '2024-01-01', costBasisUsd: 50 },
      { txid: 'gift', date: '2024-02-01' },
    ], participants: [
      { txid: 'alice-buy', role: 'output', address: 'a', amount: 3, vout: 0 },
      { txid: 'bob-buy', role: 'output', address: 'b', amount: 5, vout: 0 },
      { txid: 'gift', role: 'input', address: 'a', amount: 3 },
      { txid: 'gift', role: 'input', address: 'b', amount: 5 },
      { txid: 'gift', role: 'output', address: 'c', amount: 8, vout: 0 },
    ], legs: [{ txid: 'gift', legKey: 'output:0', transferBasisRule: 'market-value-step-up', marketValueUsd: 160 }] });
    const transfers = report.disposals.filter(row => row.kind === 'owner-transfer');
    expect(transfers.map(row => [row.owner, row.proceedsUsd])).toEqual([['Alice', 60], ['Bob', 100]]);
    expect(transfers.reduce((sum, row) => sum + (row.proceedsUsd ?? 0), 0)).toBe(160);
    expect(transfers).toMatchObject([
      { sourceLegKey: 'input:a', recipientLegKey: 'output:0' },
      { sourceLegKey: 'input:b', recipientLegKey: 'output:0' },
    ]);
    expect(report.batches.find(row => row.lotId === 'book:gift:0')?.costUsd).toBe(160);
  });

  it('does not cross owner books on mixed-owner consolidation and attributes fees to inputs', () => {
    const report = calculateOwnerCostBasis({ ...base, transactions: [{ txid: 'a1', date: '2024-01-01', costBasisUsd: 10 }, { txid: 'b1', date: '2024-01-01', costBasisUsd: 20 }, { txid: 'join', date: '2024-02-01', feeSats: 2 }],
      participants: [{ txid: 'a1', role: 'output', address: 'a', amount: 5, vout: 0 }, { txid: 'b1', role: 'output', address: 'b', amount: 5, vout: 0 },
        { txid: 'join', role: 'input', address: 'a', amount: 5 }, { txid: 'join', role: 'input', address: 'b', amount: 5 }, { txid: 'join', role: 'output', address: 'a', amount: 8, vout: 0 }] });
    expect(report.disposals.filter(x => x.kind === 'fee').map(x => [x.owner, x.sats])).toEqual([['Alice', 1], ['Bob', 1]]);
    expect(report.disposals.find(x => x.kind === 'owner-transfer' && x.owner === 'Bob')?.sats).toBe(4);
  });

  it('isolates blank owners and retains estimated and unknown provenance', () => {
    const report = calculateOwnerCostBasis({ ...base, transactions: [{ txid: 'e', date: '2024-01-01', estimatedCostBasisUsd: 12 }, { txid: 'u', date: '2024-01-02' }],
      participants: [{ txid: 'e', role: 'output', address: 'blank', amount: 3, vout: 0 }, { txid: 'u', role: 'output', address: 'a', amount: 4, vout: 0 }] });
    expect(report.batches.find(x => x.owner === UNASSIGNED_COST_BASIS_OWNER)?.costProvenance).toBe('estimated');
    expect(report.batches.find(x => x.owner === 'Alice')?.costProvenance).toBe('unknown');
    expect(report.byOwner.some(x => x.owner === UNASSIGNED_COST_BASIS_OWNER)).toBe(true);
  });

  it('allocates proportional satoshis exactly and preserves legacy single-owner figures', () => {
    expect(allocateSatsProportionally(7, [1, 1, 1])).toEqual([3, 2, 2]);
    const input = { owners: [{ id: 1, name: 'Me', createdAt: 1 }], residencies: [], legacyDefaultOwner: 'Me', addresses: [{ address: 'old' }],
      transactions: [{ txid: 'buy', date: '2024-01-01', costBasisUsd: 50 }, { txid: 'sell', date: '2024-02-01', proceedsUsd: 70 }],
      participants: [{ txid: 'buy', role: 'output' as const, address: 'old', amount: 9, vout: 0 }, { txid: 'sell', role: 'input' as const, address: 'old', amount: 9 }, { txid: 'sell', role: 'output' as const, address: 'x', amount: 9, vout: 0 }] };
    const report = calculateOwnerCostBasis(input);
    expect(report.byOwner).toMatchObject([{ owner: 'Me', disposedSats: 9, costUsd: 50, proceedsUsd: 70, gainUsd: 20 }]);
  });

  it('applies FIFO, LIFO, HIFO, and specific-id only to the disposing owner eligible lots', () => {
    const run = (method: 'fifo' | 'lifo' | 'hifo' | 'specific-identification', specificLotIds?: string[]) =>
      calculateOwnerCostBasis({ owners, addresses: base.addresses, residencies: [{ id: 1, ownerId: 1, startDate: '2024-01-01', jurisdiction: 'US', matchingMethod: method, createdAt: 1, updatedAt: 1 }],
        transactions: [{ txid: 'first', date: '2024-01-01', costBasisUsd: 10 }, { txid: 'second', date: '2024-01-02', costBasisUsd: 30 }, { txid: 'sell', date: '2024-02-01' }],
        participants: [{ txid: 'first', role: 'output', address: 'a', amount: 5, vout: 0 }, { txid: 'second', role: 'output', address: 'a', amount: 5, vout: 0 }, { txid: 'sell', role: 'input', address: 'a', amount: 5 }, { txid: 'sell', role: 'output', address: 'x', amount: 5, vout: 0 }],
        legs: specificLotIds ? [{ txid: 'sell', legKey: 'input:a', specificLotIds }] : [] });
    expect(run('fifo').disposals.find(x => x.kind === 'external')?.costUsd).toBe(10);
    expect(run('lifo').disposals.find(x => x.kind === 'external')?.costUsd).toBe(30);
    expect(run('hifo').disposals.find(x => x.kind === 'external')?.costUsd).toBe(30);
    expect(run('specific-identification', ['book:second:0']).disposals.find(x => x.kind === 'external')?.costUsd).toBe(30);
  });

  it('has identical deterministic output for a native-source snapshot and fallback snapshot', () => {
    const source = { ...base, transactions: [{ txid: 'x', date: '2024-01-01', costBasisUsd: 1 }], participants: [{ txid: 'x', role: 'output' as const, address: 'a', amount: 1, vout: 0 }] };
    // Native query adapters provide rows, not a separate accounting algorithm.
    expect(calculateOwnerCostBasis(JSON.parse(JSON.stringify(source)))).toEqual(calculateOwnerCostBasis(source));
  });

  it('uses identical shared semantics for stored native rows and fallback input', () => {
    const stored = calculateOwnerCostBasisFromStoredRows({
      records: [{ id: 1, type: 'address', inputString: 'a', label: '', tags: [], categories: [],
        owner: 'Alice', addressImportance: 'manual' }],
      transactions: [
        { txid: 'buy', blockHeight: 1, blockTime: 1_704_067_200, fee: 0, feeRate: 0, syncedAt: 1 },
        { txid: 'sell', blockHeight: 2, blockTime: 1_706_745_600, fee: 0, feeRate: 0, syncedAt: 1 },
      ],
      participants: [
        { txid: 'buy', role: 'output', address: 'a', amount: 5, vout: 0 },
        { txid: 'sell', role: 'input', address: 'a', amount: 5 },
        { txid: 'sell', role: 'output', address: 'outside', amount: 5, vout: 0 },
      ],
      metadata: [{ txid: 'buy', costBasisUsd: 10, updatedAt: 1 },
        { txid: 'sell', proceedsUsd: 12, updatedAt: 1 }],
      owners: [{ id: 1, name: 'Alice', createdAt: 1 }],
      residencies: [], legMetadata: [], entities: [], ownership: [], migrationComplete: false,
    });
    const fallback = calculateOwnerCostBasis({
      owners: [{ id: 1, name: 'Alice', createdAt: 1 }], residencies: [],
      addresses: [{ address: 'a', owner: 'Alice' }],
      transactions: [{ txid: 'buy', date: '2024-01-01', costBasisUsd: 10 },
        { txid: 'sell', date: '2024-02-01', proceedsUsd: 12 }],
      participants: [
        { txid: 'buy', role: 'output', address: 'a', amount: 5, vout: 0 },
        { txid: 'sell', role: 'input', address: 'a', amount: 5 },
        { txid: 'sell', role: 'output', address: 'outside', amount: 5, vout: 0 },
      ],
      legacyDefaultOwner: 'Alice',
    });
    expect(stored).toEqual(fallback);
  });

  it('projects a cached complete book exactly like a selected fallback calculation', () => {
    const source = { ...base, transactions: [
      { txid: 'buy', date: '2024-01-01', costBasisUsd: 10 },
      { txid: 'sell', date: '2024-02-01', proceedsUsd: 12 },
    ], participants: [
      { txid: 'buy', role: 'output' as const, address: 'a', amount: 10, vout: 0 },
      { txid: 'sell', role: 'input' as const, address: 'a', amount: 10 },
      { txid: 'sell', role: 'output' as const, address: 'merchant', amount: 10, vout: 0 },
    ] };
    const cached = selectOwnerCostBasisReport(calculateOwnerCostBasis(source), 'Alice');
    const fallback = calculateOwnerCostBasis(source, 'Alice');
    expect(cached).toEqual(fallback);
    // Selection is only a summary projection: detailed disposals, warnings,
    // assumptions, and every value provenance remain the shared calculation.
    expect(cached.disposals).toEqual(fallback.disposals);
    expect(cached.assumptions).toEqual(fallback.assumptions);
  });

  it('orders LIFO by acquisition date and apportions transaction totals without duplication', () => {
    const report = calculateOwnerCostBasis({
      owners: [{ id: 1, name: 'Alice', defaultMatchingMethod: 'lifo', createdAt: 1 }, { id: 2, name: 'Bob', createdAt: 1 }],
      residencies: [],
      addresses: base.addresses,
      transactions: [
        { txid: 'z-old', date: '2024-01-01', costBasisUsd: 30 },
        { txid: 'a-new', date: '2024-02-01', costBasisUsd: 60 },
        { txid: 'sale', date: '2024-03-01', proceedsUsd: 90 },
      ],
      participants: [
        { txid: 'z-old', role: 'output', address: 'a', amount: 10, vout: 0 },
        { txid: 'z-old', role: 'output', address: 'b', amount: 20, vout: 1 },
        { txid: 'a-new', role: 'output', address: 'a', amount: 10, vout: 0 },
        { txid: 'sale', role: 'input', address: 'a', amount: 10 },
        { txid: 'sale', role: 'input', address: 'b', amount: 20 },
        { txid: 'sale', role: 'output', address: 'merchant', amount: 30, vout: 0 },
      ],
    });
    expect(report.disposals.find(row => row.owner === 'Alice')?.allocations[0].lotId).toBe('book:a-new:0');
    expect(report.batches.find(row => row.lotId === 'book:z-old:0')?.costUsd).toBe(10);
    expect(report.batches.find(row => row.lotId === 'book:z-old:1')?.costUsd).toBe(20);
    expect(report.disposals.find(row => row.owner === 'Alice')?.proceedsUsd).toBe(30);
    expect(report.disposals.find(row => row.owner === 'Bob')?.proceedsUsd).toBe(60);
  });

  it('honors per-input leg owners and does not fabricate basis for mixed external funding', () => {
    const report = calculateOwnerCostBasis({ ...base, transactions: [{ txid: 'buy', date: '2024-01-01', costBasisUsd: 10 }, { txid: 'mix', date: '2024-02-01' }],
      participants: [{ txid: 'buy', role: 'output', address: 'a', amount: 5, vout: 0 }, { txid: 'mix', role: 'input', address: 'a', amount: 5 }, { txid: 'mix', role: 'input', address: 'outside', amount: 5 }, { txid: 'mix', role: 'output', address: 'a', amount: 10, vout: 0 }],
      legs: [{ txid: 'mix', legKey: 'input:a', owner: 'Bob', specificLotIds: ['book:buy:0'] }] });
    // The override prevents Alice's book from being used. Bob has no eligible
    // lot, and the funded output remains explicitly unknown rather than $10.
    expect(report.batches.find(x => x.lotId === 'book:mix:0')).toMatchObject({ owner: 'Alice', costProvenance: 'unknown' });
    expect(report.disposals.find(x => x.owner === 'Bob')?.allocations[0]).toMatchObject({ lotId: 'unknown', sats: 5 });
  });

  it('returns bounded owner, disposal, and open-batch renderer summaries', () => {
    const report = calculateOwnerCostBasis({ ...base,
      transactions: [{ txid: 'buy', date: '2024-01-01', costBasisUsd: 10 }, { txid: 'sell', date: '2024-02-01', proceedsUsd: 12 }],
      participants: [
        { txid: 'buy', role: 'output', address: 'a', amount: 10, vout: 0 },
        { txid: 'sell', role: 'input', address: 'a', amount: 5 },
        { txid: 'sell', role: 'output', address: 'merchant', amount: 5, vout: 0 },
      ],
    });
    const page = pageOwnerCostBasis(report, 'snapshot', 0);
    expect(page.byOwner).toHaveLength(1);
    expect(page.disposals).toHaveLength(1);
    expect(page.disposals[0]).not.toHaveProperty('allocations');
    expect(page.disposals[0].allocationsTotal).toBeGreaterThan(0);
    expect(page.openBatches).toHaveLength(1);
    expect(page.openBatches[0].remainingSats).toBe(5);
  });

  it('keeps a representative materialized book bounded and faster to page than build', () => {
    const requested = Number(process.env.KYUTXO_OWNER_BOOK_SCALE_ROWS ?? 20_000);
    const count = Math.min(1_000_000, Math.max(1_000, Number.isSafeInteger(requested) ? requested : 20_000));
    const transactions = Array.from({ length: count }, (_, i) => ({
      txid: `scale-${i}`, date: '2024-01-01', costBasisUsd: 1,
    }));
    const participants = Array.from({ length: count }, (_, i) => ({
      txid: `scale-${i}`, role: 'output' as const, address: 'a', amount: 1, vout: 0,
    }));
    const buildStarted = performance.now();
    const report = calculateOwnerCostBasis({ ...base, transactions, participants });
    const buildMs = performance.now() - buildStarted;
    const cachedStarted = performance.now();
    const pages = Array.from({ length: 10 }, () => pageOwnerCostBasis(report, 'scale', 25));
    const cachedBurstMs = performance.now() - cachedStarted;
    expect(pages.every(page => page.openBatches.length === 25)).toBe(true);
    expect(pages[0].openBatchesTotal).toBe(count);
    // Relative work on this process, never a machine-specific absolute budget.
    expect(cachedBurstMs).toBeLessThan(buildMs);
  }, 120_000);

  it('uses exact input/output conservation rather than missing or wrong provider fees', () => {
    const common = { ...base, transactions: [
      { txid: 'buy', date: '2024-01-01', costBasisUsd: 10 },
      { txid: 'sell', date: '2024-02-01', feeSats: 999 },
    ], participants: [
      { txid: 'buy', role: 'output' as const, address: 'a', amount: 10, vout: 0 },
      { txid: 'sell', role: 'input' as const, address: 'a', amount: 10 },
      { txid: 'sell', role: 'output' as const, address: 'merchant', amount: 8, vout: 0 },
    ] };
    expect(calculateOwnerCostBasis(common).disposals.find(row => row.kind === 'fee')?.sats).toBe(2);
    expect(calculateOwnerCostBasis({ ...common, transactions: common.transactions.map(tx =>
      tx.txid === 'sell' ? { ...tx, feeSats: undefined } : tx,
    ) }).disposals.find(row => row.kind === 'fee')?.sats).toBe(2);
  });

  it('does not create books for external participants or discovered counterparties', () => {
    const report = calculateOwnerCostBasis({
      owners, residencies: [], addresses: [{ address: 'controlled', owner: 'Alice' }],
      transactions: [{ txid: 'fund', date: '2024-01-01' }, { txid: 'mixed', date: '2024-02-01' }],
      participants: [
        { txid: 'fund', role: 'output', address: 'external-recipient', amount: 7, vout: 0 },
        { txid: 'mixed', role: 'input', address: 'external-input', amount: 5 },
        { txid: 'mixed', role: 'output', address: 'controlled', amount: 5, vout: 0 },
      ],
    });
    expect(report.batches.map(batch => batch.owner)).toEqual(['Alice']);
    expect(report.batches[0]).toMatchObject({ sats: 5, costProvenance: 'unknown' });
  });
});
