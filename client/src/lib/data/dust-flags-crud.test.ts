import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../database';
import {
  toOutpoint,
  markOutpointsAsDust,
  unmarkDustOutpoints,
  getAllDustFlags,
  getDustFlaggedOutpointSet,
} from './dust-flags-crud';
import { detectDustUTXOs, type AuditContext } from '../privacy-audit';
import type { TransactionParticipant } from '../database';

const TXID_A = 'a'.repeat(64);
const TXID_B = 'b'.repeat(64);
const ADDR = 'bc1qexampledustaddr000000000000000000000000';

beforeEach(async () => {
  await db.dustFlags.clear();
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
