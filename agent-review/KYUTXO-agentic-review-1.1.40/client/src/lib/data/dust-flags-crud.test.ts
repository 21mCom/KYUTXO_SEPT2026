import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../database';
import {
  toOutpoint,
  markOutpointsAsDust,
  unmarkDustOutpoints,
  getAllDustFlags,
  getDustFlaggedOutpointSet,
  getUnspentDustByAddress,
} from './dust-flags-crud';
import { bulkAddParticipants, clearParticipants } from './transaction-crud';
import { detectDustUTXOs, type AuditContext } from '../privacy-audit';
import type { TransactionParticipant } from '../database';

const TXID_A = 'a'.repeat(64);
const TXID_B = 'b'.repeat(64);
const ADDR = 'bc1qexampledustaddr000000000000000000000000';

beforeEach(async () => {
  await db.dustFlags.clear();
  await clearParticipants();
});

describe('dust-flags-crud', () => {
  it('marks outpoints, dedupes input, and skips already-flagged outpoints', async () => {
    const added = await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR, amountSats: 546 },
      { txid: TXID_A, vout: 0, address: ADDR, amountSats: 546 },
      { txid: TXID_A, vout: 1, address: ADDR, amountSats: 800 },
    ]);
    expect(added).toBe(2);

    const again = await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR, amountSats: 546 },
      { txid: TXID_B, vout: 3, address: ADDR, amountSats: 700 },
    ]);
    expect(again).toBe(1);

    const flags = await getAllDustFlags();
    expect(flags).toHaveLength(3);

    const set = await getDustFlaggedOutpointSet();
    expect(set.has(toOutpoint(TXID_A, 0))).toBe(true);
    expect(set.has(toOutpoint(TXID_B, 3))).toBe(true);
    expect(set.has(toOutpoint(TXID_B, 0))).toBe(false);
  });

  it('unmarks outpoints and reports the removed count', async () => {
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR, amountSats: 546 },
      { txid: TXID_A, vout: 1, address: ADDR, amountSats: 800 },
    ]);
    const removed = await unmarkDustOutpoints([
      toOutpoint(TXID_A, 0),
      toOutpoint(TXID_B, 9),
    ]);
    expect(removed).toBe(1);
    const set = await getDustFlaggedOutpointSet();
    expect(set.size).toBe(1);
    expect(set.has(toOutpoint(TXID_A, 1))).toBe(true);
  });

  it('sums unspent dust per address and excludes spent + address-less flags', async () => {
    const ADDR_2 = 'bc1qseconddustaddr0000000000000000000000000';
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR, amountSats: 546 },
      { txid: TXID_A, vout: 1, address: ADDR, amountSats: 800 },
      { txid: TXID_B, vout: 0, address: ADDR_2, amountSats: 700 },
      // Spent flag: an input references this outpoint below.
      { txid: TXID_B, vout: 1, address: ADDR, amountSats: 900 },
      // No address: cannot be attributed to any per-address balance.
      { txid: TXID_B, vout: 2, address: '', amountSats: 1000 },
    ]);
    await bulkAddParticipants([
      {
        txid: 'c'.repeat(64),
        role: 'input',
        address: ADDR,
        amount: 900,
        prevTxid: TXID_B,
        prevVout: 1,
      } as unknown as TransactionParticipant,
    ]);

    const { byAddress } = await getUnspentDustByAddress();
    expect(byAddress.get(ADDR)).toEqual({ sats: 546 + 800, count: 2 });
    expect(byAddress.get(ADDR_2)).toEqual({ sats: 700, count: 1 });
    expect(byAddress.has('')).toBe(false);
    expect(byAddress.size).toBe(2);
  });

  it('returns an empty map when there are no dust flags', async () => {
    const { byAddress } = await getUnspentDustByAddress();
    expect(byAddress.size).toBe(0);
  });
});

describe('privacy audit dust annotation', () => {
  function makeCtx(dustFlaggedOutpoints?: Set<string>): AuditContext {
    const participants: TransactionParticipant[] = [
      {
        txid: TXID_A,
        address: ADDR,
        role: 'output',
        amount: 600,
        vout: 0,
      } as unknown as TransactionParticipant,
    ];
    const participantsByTxid = new Map<string, TransactionParticipant[]>([
      [TXID_A, participants],
    ]);
    return {
      userAddresses: new Set([ADDR]),
      participants,
      participantsByTxid,
      transactions: new Map(),
      dustFlaggedOutpoints,
    };
  }

  it('downgrades user-flagged dust findings to LOW with markedAsDust details', () => {
    const result = detectDustUTXOs(makeCtx(new Set([toOutpoint(TXID_A, 0)])));
    const all = [...result.findings, ...result.warnings];
    const finding = all.find(
      (f) => f.type === 'DUST' && (f.details as any)?.markedAsDust === true,
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('LOW');
    expect(finding!.description).toContain('already marked as dust');
  });

  it('keeps full severity when the output is not user-flagged', () => {
    const result = detectDustUTXOs(makeCtx(new Set()));
    const all = [...result.findings, ...result.warnings];
    const finding = all.find(
      (f) => f.type === 'DUST' && (f.details as any)?.unspent === true,
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).not.toBe('LOW');
    expect((finding!.details as any)?.markedAsDust).toBeUndefined();
  });
});
