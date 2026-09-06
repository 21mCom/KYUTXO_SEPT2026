import { describe, expect, it } from 'vitest';
import type { BlockchainTransaction, Record, TransactionParticipant } from './db-types';
import { deriveAddressAnnotationContext, deriveTransactionAnnotationContext, shouldPersistTransactionRelationships } from './annotation-context';

const tx: BlockchainTransaction = { txid: 'tx', blockHeight: 1, blockTime: 1, fee: 1, feeRate: 1, syncedAt: 1 };
const own = (id: number, extra: Partial<Record> = {}): Record => ({
  id, type: 'address', inputString: `mine-${id}`, label: '', tags: [], categories: [], createdAt: 1, updatedAt: 1, ...extra,
});
const part = (role: 'input' | 'output', recordId: number | undefined, amount = 100, vout?: number): TransactionParticipant =>
  ({ txid: 'tx', role, address: recordId === undefined ? 'external' : `mine-${recordId}`, amount, recordId, vout });
const derive = (participants: TransactionParticipant[], records: Record[], extra = {}) =>
  deriveTransactionAnnotationContext({ transaction: tx, participants, addressRecords: records, ...extra });

describe('annotation context', () => {
  it('keeps address annotation free of transaction-only questions', () => {
    expect(deriveAddressAnnotationContext(own(1)).questions).toEqual(
      ['controlled-by', 'wallet-or-counterparty', 'label', 'notes', 'tags']);
  });

  it('classifies receives and sends from linked address metadata', () => {
    expect(derive([part('output', 1)], [own(1)]).classification).toBe('receive');
    const context = derive([part('input', 1), part('output', 2)], [own(1), own(2, { counterpartyType: 'business' })]);
    expect(context.classification).toBe('send');
    expect(context.questions).toContain('disposition-type');
  });

  it('distinguishes change, consolidation, and transfers between owners', () => {
    expect(derive([part('input', 1), part('output', 2)], [own(1), own(2)]).classification).toBe('change');
    expect(derive([part('input', 1), part('input', 2), part('output', 3)], [own(1), own(2), own(3)]).classification).toBe('consolidation');
    expect(derive([part('input', 1), part('output', 2)], [own(1, { owner: 'Ada' }), own(2, { owner: 'Ben' })]).classification).toBe('owner-transfer');
  });

  it('does not persist hidden blank relationships during a change metadata save', () => {
    const context = derive([part('input', 1), part('output', 2)], [
      own(1, { owner: 'Ada', walletName: 'Cold' }),
      own(2, { owner: 'Ada', walletName: 'Cold' }),
    ]);
    expect(context.classification).toBe('change');
    expect(shouldPersistTransactionRelationships(context, false)).toBe(false);
    expect(shouldPersistTransactionRelationships(context, true)).toBe(false);
  });

  it('recognizes mixer metadata and equal-output CoinJoin shapes', () => {
    const externalInput = { ...own(9, { addressImportance: 'blockchain-discovered' }), inputString: 'external-input' };
    expect(derive([part('input', 9), part('output', 1)], [externalInput, own(1, { counterpartyType: 'mixer' })]).classification).toBe('coinjoin');
    const external1 = { ...own(10, { addressImportance: 'blockchain-discovered' }), inputString: 'external-1' };
    const external2 = { ...own(11, { addressImportance: 'blockchain-discovered' }), inputString: 'external-2' };
    expect(derive([part('input', 10), part('input', 11), part('output', 1, 50), part('output', 2, 50), part('output', 3, 50)], [external1, external2, own(1), own(2), own(3)]).classification).toBe('coinjoin');
  });

  it('does not misrepresent missing input addresses and exposes that fact', () => {
    const missing = { ...part('input', undefined), address: '' };
    const context = derive([missing, part('output', 1)], [own(1)]);
    expect(context.classification).toBe('undetermined');
    expect(context.hasUndeterminedInputs).toBe(true);
    expect(context.sentence).toMatch(/undetermined inputs/i);
  });

  it('keeps incomplete CoinJoin-shaped inputs undetermined before heuristics', () => {
    const missing = { ...part('input', undefined), address: '' };
    const context = derive([missing, part('input', 10), part('output', 1, 50), part('output', 2, 50), part('output', 3, 50)],
      [{ ...own(10, { addressImportance: 'blockchain-discovered' }), inputString: 'external-1' }, own(1), own(2), own(3)]);
    expect(context.classification).toBe('undetermined');
    expect(context.questions).toContain('controlled-by');
  });

  it('uses normalized entity IDs, not stale legacy owner labels, for owner transfers', () => {
    const context = derive([part('input', 1), part('output', 2)], [
      own(1, { owner: '' }), own(2, { owner: 'stale owner' }),
    ], {
      addressOwnership: [
        { recordId: 1, state: 'assigned', entityId: 10, createdAt: 1, updatedAt: 1 },
        { recordId: 2, state: 'assigned', entityId: 20, createdAt: 1, updatedAt: 1 },
      ],
    });
    expect(context.classification).toBe('owner-transfer');
  });

  it('preserves serializable defaults and per-leg overrides separately', () => {
    const context = derive([part('input', 1, 100, 0), part('output', 2, 90, 1)], [own(1), own(2)], {
      transactionMetadata: { txid: 'tx', flowType: 'sent', tags: ['default'], createdAt: 1, updatedAt: 1 },
      legMetadata: [{ txid: 'tx', legKey: 'output:1', direction: 'incoming', flowType: 'received', notes: 'gift', createdAt: 1, updatedAt: 1 }],
    });
    expect(context.defaults).toEqual({ flowType: 'sent', tags: ['default'] });
    expect(context.legs[1]).toMatchObject({ override: { flowType: 'received', notes: 'gift' }, effective: { flowType: 'received', tags: ['default'], notes: 'gift' } });
    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
  });
});