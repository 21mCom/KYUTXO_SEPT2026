import { describe, expect, it } from 'vitest';
import type { AddressOwnership, Record, TransactionParticipant } from './db-types';
import { decideOwnership, decideWalletOwnership, generateOwnershipSuggestions, getOwnershipWalletCascade, undoOwnershipDecision, visibleOwnershipSuggestions } from './ownership-resolution';

const address = (id: number, inputString: string, extra: Partial<Record> = {}): Record =>
  ({ id, type: 'address', inputString, label: '', tags: [], categories: [], createdAt: 1, updatedAt: 1, ...extra });
const assigned = (recordId: number, entityId: number): AddressOwnership =>
  ({ id: recordId, recordId, state: 'assigned', entityId, createdAt: 1, updatedAt: 1 });
const input = (txid: string, recordId: number): TransactionParticipant =>
  ({ txid, role: 'input', address: `a${recordId}`, amount: 1, recordId });

describe('ownership resolution evidence', () => {
  it('is deterministic, bounded, and proposes a direct propagation without mutating ownership', () => {
    const records = [address(1, 'seed'), address(2, 'child', { discoveredFromRecordId: 1, discoveredInTxid: 'tx' })];
    const ownership = [assigned(1, 9), { id: 2, recordId: 2, state: 'undetermined', createdAt: 1, updatedAt: 1 } as AddressOwnership];
    const first = generateOwnershipSuggestions({ records, ownership, participants: [] });
    const second = generateOwnershipSuggestions({ records: [...records].reverse(), ownership, participants: [] });
    expect(first).toEqual(second);
    expect(first).toMatchObject([{ kind: 'propagation', recordId: 2, entityId: 9 }]);
    expect(ownership[1].state).toBe('undetermined');
  });

  it('uses a single-owner common-input cluster but never guesses from commingled owners', () => {
    const records = [address(1, 'a'), address(2, 'b'), address(3, 'c')];
    const oneOwner = generateOwnershipSuggestions({ records, ownership: [assigned(1, 7)], participants: [input('t', 1), input('t', 2)] });
    expect(oneOwner.some(s => s.kind === 'common-input-cluster' && s.recordId === 2 && s.entityId === 7)).toBe(true);
    const mixed = generateOwnershipSuggestions({ records, ownership: [assigned(1, 7), assigned(3, 8)],
      participants: [input('t', 1), input('t', 2), input('t', 3)] });
    expect(mixed.some(s => s.kind === 'common-input-cluster')).toBe(false);
  });

  it('suppresses only an unchanged rejected fingerprint', () => {
    const suggestions = generateOwnershipSuggestions({ records: [address(1, 'A'), address(2, 'a')],
      ownership: [assigned(1, 4)], participants: [] });
    const reuse = suggestions.find(s => s.kind === 'address-reuse')!;
    expect(visibleOwnershipSuggestions(suggestions, [{
      id: reuse.fingerprint, evidenceFingerprint: reuse.fingerprint, state: 'rejected', action: 'reject',
      recordIds: [2], createdAt: 1, updatedAt: 1,
    }])).not.toContainEqual(reuse);
    expect(visibleOwnershipSuggestions([{ ...reuse, fingerprint: `${reuse.fingerprint}-changed` }], [{
      id: reuse.fingerprint, evidenceFingerprint: reuse.fingerprint, state: 'rejected', action: 'reject',
      recordIds: [2], createdAt: 1, updatedAt: 1,
    }])).toHaveLength(1);
  });

  it('keeps evidence fingerprints stable when backup restore remaps local ids', () => {
    const before = generateOwnershipSuggestions({
      records: [address(1, 'bc1qsource'), address(2, 'bc1qtarget')],
      ownership: [assigned(1, 7)],
      participants: [input('stable-txid', 1), input('stable-txid', 2)],
      entities: [{ id: 7, naturalKey: 'person:alice', name: 'Alice', kind: 'person', createdAt: 1, updatedAt: 1 }],
    }).find(suggestion => suggestion.recordId === 2)!;
    const after = generateOwnershipSuggestions({
      records: [address(101, 'bc1qsource'), address(202, 'bc1qtarget')],
      ownership: [assigned(101, 70)],
      participants: [input('stable-txid', 101), input('stable-txid', 202)],
      entities: [{ id: 70, naturalKey: 'person:alice', name: 'Alice', kind: 'person', createdAt: 1, updatedAt: 1 }],
    }).find(suggestion => suggestion.recordId === 202)!;
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(visibleOwnershipSuggestions([after], [{
      id: before.fingerprint,
      evidenceFingerprint: before.fingerprint,
      state: 'rejected',
      action: 'reject',
      recordIds: [202],
      createdAt: 1,
      updatedAt: 1,
    }])).toHaveLength(0);
  });

  it('ranks observed value descending and keeps suggestions out of ownership until accepted', () => {
    const suggestions = generateOwnershipSuggestions({
      records: [address(1, 'a', { cachedBalanceSats: 1 }), address(2, 'a', { cachedBalanceSats: 20 }),
        address(3, 'b', { discoveredFromRecordId: 1, cachedBalanceSats: 10 })],
      ownership: [assigned(1, 4)], participants: [],
    });
    expect(suggestions.map(s => s.valueSats)).toEqual([...suggestions.map(s => s.valueSats)].sort((a, b) => b - a));
    expect(suggestions.every(s => s.recordId !== 1)).toBe(true);
  });

  it('commits an accepted new ownership row with its decision and undo deletes that new row', async () => {
    const ownership: AddressOwnership[] = [];
    const decisions: any[] = [];
    let atomicCalls = 0;
    const repository: any = {
      list: async (table: string) => ({ rows: table === 'addressOwnership' ? ownership : decisions, cursor: undefined }),
      get: async (table: string, id: string) => table === 'ownershipReviewDecisions' ? decisions.find(d => d.id === id) : undefined,
      commitOwnershipReview: async (command: any) => {
        atomicCalls++;
        for (const id of command.deleteOwnershipIds ?? []) {
          const index = ownership.findIndex(row => row.id === id); if (index >= 0) ownership.splice(index, 1);
        }
        const createdOwnershipRecordIds = command.ownershipRows.filter((r: AddressOwnership) => r.id === undefined).map((r: AddressOwnership) => r.recordId);
        command.ownershipRows.forEach((row: AddressOwnership) => {
          const old = ownership.findIndex(existing => existing.id === row.id);
          if (old >= 0) ownership[old] = row; else ownership.push({ ...row, id: row.id ?? ownership.length + 1 });
        });
        const saved = { ...command.decision, createdOwnershipRecordIds };
        const previous = decisions.findIndex(d => d.id === saved.id);
        if (previous >= 0) decisions[previous] = saved; else decisions.push(saved);
        return saved;
      },
    };
    const suggestion = { fingerprint: 'ownership-v1:test', kind: 'propagation' as const, recordId: 2, recordIds: [2],
      entityId: 5, suggestedState: 'assigned' as const, confidence: 'low' as const, valueSats: 10, explanation: '', transactionIds: [] };
    const decision = await decideOwnership({ suggestion, action: 'assign', now: 22 }, repository);
    expect(ownership).toMatchObject([{ recordId: 2, state: 'assigned', entityId: 5 }]);
    expect(await undoOwnershipDecision(decision.undoToken!, repository)).toBe(true);
    expect(ownership).toHaveLength(0);
    expect(atomicCalls).toBe(2);
  });

  it('enumerates unresolved normalized-wallet rows and commits a wallet cascade atomically', async () => {
    const ownership: AddressOwnership[] = [
      { id: 1, recordId: 2, walletId: 11, state: 'undetermined', createdAt: 1, updatedAt: 1 },
      { id: 2, recordId: 3, walletId: 11, state: 'ours-owner-unknown', createdAt: 1, updatedAt: 1 },
      { id: 3, recordId: 4, walletId: 11, state: 'assigned', entityId: 9, createdAt: 1, updatedAt: 1 },
    ];
    let command: any;
    const repository: any = {
      list: async () => ({ rows: ownership, cursor: undefined }),
      get: async () => undefined,
      commitOwnershipReview: async (value: any) => { command = value; return value.decision; },
    };
    expect(await getOwnershipWalletCascade(2, repository)).toEqual({ walletId: 11, recordIds: [2, 3] });
    const suggestion = { fingerprint: 'wallet-evidence', kind: 'propagation' as const, recordId: 2, recordIds: [2],
      entityId: 9, suggestedState: 'assigned' as const, confidence: 'low' as const, valueSats: 1, explanation: '', transactionIds: [] };
    await decideWalletOwnership({ suggestion, action: 'assign-wallet', recordIds: [2, 3], now: 10 }, repository);
    expect(command.ownershipRows).toMatchObject([{ recordId: 2, state: 'assigned', entityId: 9 }, { recordId: 3, state: 'assigned', entityId: 9 }]);
    expect(command.decision.action).toBe('assign-wallet');
  });
});