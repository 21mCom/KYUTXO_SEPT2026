import { describe, it, expect } from 'vitest';
import type { BlockchainTransaction, TransactionParticipant } from './db-types';
import {
  computeUnspentUtxos,
  classifyHop,
  traceUtxoProvenance,
  MAX_HOP_DEPTH,
  type ProvenanceWalkContext,
} from './utxo-provenance';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNED = new Set(['addrA', 'addrB', 'addrC']);
const isWalletAddress = (a: string) => OWNED.has(a);

let txCounter = 0;
function makeTx(overrides: Partial<BlockchainTransaction> = {}): BlockchainTransaction {
  txCounter += 1;
  return {
    txid: overrides.txid ?? `tx${txCounter.toString().padStart(4, '0')}`,
    blockHeight: 100 + txCounter,
    blockTime: 1_600_000_000 + txCounter * 600,
    fee: 500,
    feeRate: 1,
    syncedAt: Date.now(),
    ...overrides,
  };
}

function out(txid: string, address: string, amount: number, vout: number): TransactionParticipant {
  return { txid, role: 'output', address, amount, vout };
}

function inp(
  txid: string,
  address: string,
  amount: number,
  prevTxid?: string,
  prevVout?: number,
): TransactionParticipant {
  return { txid, role: 'input', address, amount, prevTxid, prevVout };
}

function ctxFrom(
  txs: BlockchainTransaction[],
  parts: TransactionParticipant[],
): ProvenanceWalkContext {
  const txByTxid = new Map(txs.map((t) => [t.txid, t]));
  const participantsByTxid = new Map<string, { inputs: TransactionParticipant[]; outputs: TransactionParticipant[] }>();
  for (const p of parts) {
    let e = participantsByTxid.get(p.txid);
    if (!e) {
      e = { inputs: [], outputs: [] };
      participantsByTxid.set(p.txid, e);
    }
    if (p.role === 'input') e.inputs.push(p);
    else e.outputs.push(p);
  }
  return { txByTxid, participantsByTxid, isWalletAddress };
}

// ---------------------------------------------------------------------------
// computeUnspentUtxos
// ---------------------------------------------------------------------------

describe('computeUnspentUtxos', () => {
  it('keeps outputs with no spending input', () => {
    const tx = makeTx({ txid: 'txA' });
    const parts = [out('txA', 'addrA', 50_000, 0)];
    const txMap = new Map([[tx.txid, tx]]);
    const utxos = computeUnspentUtxos(parts, txMap, isWalletAddress);
    expect(utxos).toHaveLength(1);
    expect(utxos[0].id).toBe('txA:0');
    expect(utxos[0].amountSats).toBe(50_000);
  });

  it('drops outputs spent via a known outpoint (exact detection)', () => {
    const txA = makeTx({ txid: 'txA' });
    const txB = makeTx({ txid: 'txB' });
    const parts = [
      out('txA', 'addrA', 50_000, 0),
      // Input carries no prevout address but DOES carry the outpoint.
      inp('txB', '', 50_000, 'txA', 0),
      out('txB', 'addrB', 40_000, 0),
    ];
    const txMap = new Map([[txA.txid, txA], [txB.txid, txB]]);
    const utxos = computeUnspentUtxos(parts, txMap, isWalletAddress);
    expect(utxos.map((u) => u.id)).toEqual(['txB:0']);
  });

  it('falls back to FIFO address:amount matching for outpoint-less inputs', () => {
    const txA = makeTx({ txid: 'txA' });
    const txB = makeTx({ txid: 'txB' });
    const parts = [
      out('txA', 'addrA', 50_000, 0),
      inp('txB', 'addrA', 50_000), // no outpoint data
      out('txB', 'addrB', 40_000, 0),
    ];
    const txMap = new Map([[txA.txid, txA], [txB.txid, txB]]);
    const utxos = computeUnspentUtxos(parts, txMap, isWalletAddress);
    expect(utxos.map((u) => u.id)).toEqual(['txB:0']);
  });

  it('ignores outputs to non-wallet addresses', () => {
    const tx = makeTx({ txid: 'txA' });
    const parts = [out('txA', 'external1', 50_000, 0), out('txA', 'addrA', 10_000, 1)];
    const txMap = new Map([[tx.txid, tx]]);
    const utxos = computeUnspentUtxos(parts, txMap, isWalletAddress);
    expect(utxos.map((u) => u.id)).toEqual(['txA:1']);
  });
});

// ---------------------------------------------------------------------------
// classifyHop
// ---------------------------------------------------------------------------

describe('classifyHop', () => {
  it('marks coinbase when there are no inputs', () => {
    expect(classifyHop([], [out('tx', 'addrA', 1, 0)], isWalletAddress)).toBe('coinbase');
  });

  it('marks origin when no input is owned', () => {
    expect(
      classifyHop([inp('tx', 'ext', 1000)], [out('tx', 'addrA', 900, 0)], isWalletAddress),
    ).toBe('origin');
  });

  it('marks wallet reorg when every output stays in the wallet', () => {
    expect(
      classifyHop(
        [inp('tx', 'addrA', 1000)],
        [out('tx', 'addrB', 600, 0), out('tx', 'addrC', 300, 1)],
        isWalletAddress,
      ),
    ).toBe('wallet-reorg');
  });

  it('marks partial spend when value leaves and change returns', () => {
    expect(
      classifyHop(
        [inp('tx', 'addrA', 1000)],
        [out('tx', 'merchant1', 600, 0), out('tx', 'addrB', 350, 1)],
        isWalletAddress,
      ),
    ).toBe('partial-spend');
  });

  it('marks unknown when participants carry no addresses at all', () => {
    expect(classifyHop([inp('tx', '', 1000)], [out('tx', '', 900, 0)], isWalletAddress)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// traceUtxoProvenance
// ---------------------------------------------------------------------------

describe('traceUtxoProvenance', () => {
  it('walks a two-hop partial-spend chain with dates per hop', () => {
    // ext -> tx1 (origin, creates UTXO) -> we still have the UTXO unspent.
    const tx0 = makeTx({ txid: 'txOrigin' });
    const tx1 = makeTx({ txid: 'txCreate' });
    const parts = [
      inp('txOrigin', 'extMiner', 100_000),
      out('txOrigin', 'extWallet', 99_000, 0),
      inp('txCreate', 'extWallet', 99_000, 'txOrigin', 0),
      out('txCreate', 'addrA', 60_000, 0),
      out('txCreate', 'extChange', 38_500, 1),
    ];
    const ctx = ctxFrom([tx0, tx1], parts);
    const utxo = computeUnspentUtxos(parts, ctx.txByTxid, isWalletAddress).find((u) => u.id === 'txCreate:0')!;
    const result = traceUtxoProvenance(utxo, ctx);

    expect(result.hopsBack).toBe(2);
    expect(result.hops).toHaveLength(2);
    expect(result.hops[0].txid).toBe('txCreate');
    expect(result.hops[0].classification).toBe('origin');
    expect(result.hops[0].stopReason).toBeUndefined();
    expect(result.hops[1].txid).toBe('txOrigin');
    expect(result.hops[1].blockTime).toBe(tx0.blockTime);
    // txOrigin's input carries no prevout reference, so the trail ends there.
    expect(result.hops[1].stopReason).toBe('no-outpoint-data');
    expect(result.oldestHopTime).toBe(Math.min(tx0.blockTime, tx1.blockTime));
    expect(result.newestHopTime).toBe(Math.max(tx0.blockTime, tx1.blockTime));
  });

  it('walks through wallet reorgs to the external origin and classifies each hop', () => {
    // txOrigin: ext -> addrA (origin)
    // txReorg: addrA -> addrB + addrC (wallet reorg, both owned)
    // UTXO: addrB output of txReorg, unspent.
    const txO = makeTx({ txid: 'txOrigin' });
    const txR = makeTx({ txid: 'txReorg' });
    const parts = [
      inp('txOrigin', 'extSource', 100_000),
      out('txOrigin', 'addrA', 99_000, 0),
      inp('txReorg', 'addrA', 99_000, 'txOrigin', 0),
      out('txReorg', 'addrB', 50_000, 0),
      out('txReorg', 'addrC', 48_500, 1),
    ];
    const ctx = ctxFrom([txO, txR], parts);
    const utxo = computeUnspentUtxos(parts, ctx.txByTxid, isWalletAddress).find((u) => u.id === 'txReorg:0')!;
    const result = traceUtxoProvenance(utxo, ctx);

    expect(result.hopsBack).toBe(2);
    expect(result.classifications).toContain('wallet-reorg');
    expect(result.classifications).toContain('origin');
    expect(result.truncated).toBe(false);
  });

  it('marks the last hop no-tx-record when the ancestor tx is missing', () => {
    const tx1 = makeTx({ txid: 'txCreate' });
    const parts = [
      inp('txCreate', 'addrA', 99_000, 'txMissing', 0),
      out('txCreate', 'addrB', 60_000, 0),
      out('txCreate', 'addrC', 38_500, 1),
    ];
    const ctx = ctxFrom([tx1], parts);
    const utxo = computeUnspentUtxos(parts, ctx.txByTxid, isWalletAddress).find((u) => u.id === 'txCreate:0')!;
    const result = traceUtxoProvenance(utxo, ctx);
    // The missing ancestor is not recorded as a hop, but the branch end is
    // auditable: the last hop explains why the trail stops.
    expect(result.hopsBack).toBe(1);
    expect(result.hops).toHaveLength(1);
    expect(result.classifications).toEqual(['wallet-reorg']);
    expect(result.hops[0].stopReason).toBe('no-tx-record');
  });

  it('derives blank-input ownership from the prevout (Electrum-style sync)', () => {
    // Electrum-synced inputs carry the outpoint but a blank address. Ownership
    // must come from the output being spent, not the input row itself.
    const txF = makeTx({ txid: 'txFund' });
    const txE = makeTx({ txid: 'txElectrum' });
    const parts = [
      inp('txFund', 'extSource', 71_000),
      out('txFund', 'addrA', 70_000, 0),
      inp('txElectrum', '', 70_000, 'txFund', 0), // blank address, outpoint known
      out('txElectrum', 'merchant1', 40_000, 0),
      out('txElectrum', 'addrB', 29_000, 1),
    ];
    const ctx = ctxFrom([txF, txE], parts);
    const utxo = computeUnspentUtxos(parts, ctx.txByTxid, isWalletAddress).find((u) => u.id === 'txElectrum:1')!;
    const result = traceUtxoProvenance(utxo, ctx);
    expect(result.hops[0].classification).toBe('partial-spend');
    expect(result.hops[0].ownedInputCount).toBe(1);
    expect(result.hopsBack).toBe(2);
    expect(result.classifications).toContain('origin');
  });

  it('flags ancestor-cap stop reasons when the ancestor budget runs out', () => {
    // Root spends 4 owned outputs from 4 distinct parents; only 2 hops fit.
    const parents = [0, 1, 2, 3].map((i) => makeTx({ txid: `parent${i}` }));
    const root = makeTx({ txid: 'root' });
    const parts: TransactionParticipant[] = [];
    for (const [i, p] of parents.entries()) {
      parts.push(inp(p.txid, `extFunder${i}`, 10_000));
      parts.push(out(p.txid, 'addrA', 9_000, 0));
      parts.push(inp('root', 'addrA', 9_000, p.txid, 0));
    }
    parts.push(out('root', 'addrB', 35_000, 0));
    const ctx = ctxFrom([...parents, root], parts);
    const utxo = { id: 'root:0', txid: 'root', vout: 0, address: 'addrB', amountSats: 35_000, blockTime: root.blockTime, blockHeight: root.blockHeight };
    const result = traceUtxoProvenance(utxo, ctx, new Map(), { maxAncestors: 2 });
    expect(result.truncated).toBe(true);
    expect(result.hops).toHaveLength(2);
    // The root's unvisited-but-on-record parents explain the early stop.
    expect(result.hops.find((h) => h.txid === 'root')?.stopReason).toBe('ancestor-cap');
  });

  it('stops with no-outpoint-data when inputs lack prevout references', () => {
    const tx1 = makeTx({ txid: 'txCreate' });
    const parts = [
      inp('txCreate', 'addrA', 99_000), // no prevTxid/prevVout
      out('txCreate', 'addrB', 60_000, 0),
    ];
    const ctx = ctxFrom([tx1], parts);
    const utxo = computeUnspentUtxos(parts, ctx.txByTxid, isWalletAddress).find((u) => u.id === 'txCreate:0')!;
    const result = traceUtxoProvenance(utxo, ctx);
    expect(result.hopsBack).toBe(1);
    expect(result.hops[0].stopReason).toBe('no-outpoint-data');
  });

  it('survives cycles without hanging', () => {
    // txA input references txB and txB input references txA (invalid on-chain,
    // but the walker must terminate).
    const txA = makeTx({ txid: 'txA' });
    const txB = makeTx({ txid: 'txB' });
    const parts = [
      inp('txA', 'addrA', 1000, 'txB', 0),
      out('txA', 'addrA', 900, 0),
      inp('txB', 'addrA', 1000, 'txA', 0),
      out('txB', 'addrA', 900, 0),
    ];
    const ctx = ctxFrom([txA, txB], parts);
    // Mark txA:0 unspent by removing any valid spend: here both reference each
    // other, so computeUnspentUtxos would consider txA:0 spent by txB's input.
    // Trace directly instead to exercise the cycle guard.
    const utxo = { id: 'txA:0', txid: 'txA', vout: 0, address: 'addrA', amountSats: 900, blockTime: txA.blockTime, blockHeight: txA.blockHeight };
    const result = traceUtxoProvenance(utxo, ctx);
    expect(result.hops.length).toBeLessThanOrEqual(2);
  });

  it('respects the depth cap and flags truncation', () => {
    // Linear chain of MAX_HOP_DEPTH + 5 self-transfers.
    const depth = MAX_HOP_DEPTH + 5;
    const txs: BlockchainTransaction[] = [];
    const parts: TransactionParticipant[] = [];
    for (let i = 0; i < depth; i++) {
      const txid = `chain${i}`;
      txs.push(makeTx({ txid }));
      if (i === 0) {
        parts.push(inp(txid, 'extRoot', 100_000));
      } else {
        parts.push(inp(txid, 'addrA', 100_000 - i * 100, `chain${i - 1}`, 0));
      }
      parts.push(out(txid, 'addrA', 99_000 - i * 100, 0));
    }
    const ctx = ctxFrom(txs, parts);
    const lastTx = txs[depth - 1];
    const utxo = { id: `${lastTx.txid}:0`, txid: lastTx.txid, vout: 0, address: 'addrA', amountSats: 100, blockTime: lastTx.blockTime, blockHeight: lastTx.blockHeight };
    const result = traceUtxoProvenance(utxo, ctx);
    expect(result.hopsBack).toBe(MAX_HOP_DEPTH);
    expect(result.truncated).toBe(true);
  });

  it('counts fan-in: multi-input transactions extend every branch', () => {
    // txJoin spends two owned UTXOs from tx1 and tx2; both branches are walked.
    const tx1 = makeTx({ txid: 'tx1' });
    const tx2 = makeTx({ txid: 'tx2' });
    const txJ = makeTx({ txid: 'txJoin' });
    const parts = [
      inp('tx1', 'ext1', 50_000),
      out('tx1', 'addrA', 49_000, 0),
      inp('tx2', 'ext2', 60_000),
      out('tx2', 'addrB', 59_000, 0),
      inp('txJoin', 'addrA', 49_000, 'tx1', 0),
      inp('txJoin', 'addrB', 59_000, 'tx2', 0),
      out('txJoin', 'addrC', 100_000, 0),
      out('txJoin', 'addrA', 7_000, 1),
    ];
    const ctx = ctxFrom([tx1, tx2, txJ], parts);
    const utxo = computeUnspentUtxos(parts, ctx.txByTxid, isWalletAddress).find((u) => u.id === 'txJoin:0')!;
    const result = traceUtxoProvenance(utxo, ctx);
    expect(result.hopsBack).toBe(2);
    const depth2 = result.hops.filter((h) => h.depth === 2).map((h) => h.txid).sort();
    expect(depth2).toEqual(['tx1', 'tx2']);
  });
});
