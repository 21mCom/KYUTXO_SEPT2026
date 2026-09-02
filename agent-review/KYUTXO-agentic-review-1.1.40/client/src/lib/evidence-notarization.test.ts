import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  findNotarizationsForAttachment,
  setPendingNotarization,
  peekPendingNotarization,
  clearPendingNotarization,
  subscribePendingNotarization,
  PENDING_NOTARIZATION_TTL_MS,
} from './evidence-notarization';
import type { SavedPsbt } from './database';

const PAYLOAD_A = 'a'.repeat(64);
const PAYLOAD_B = 'b'.repeat(64);

function makeSavedPsbt(overrides: Partial<SavedPsbt> = {}): SavedPsbt {
  return {
    id: 1,
    name: 'PSBT',
    psbtBase64: 'cHNidP8BAAoCAAAAAQE=',
    destinationAddress: 'bc1qdest',
    feeRateSatsPerVb: 2,
    feeSats: 282,
    estimatedVbytes: 141,
    totalInputSats: 100_000,
    sendAmountSats: 99_718,
    changeSats: 0,
    inputs: [],
    outputs: [{ address: 'bc1qdest', amountSats: 99_718, isChange: false }],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('pending notarization handoff', () => {
  afterEach(() => {
    clearPendingNotarization();
    vi.useRealTimers();
  });

  it('stores, peeks, and clears the intent', () => {
    clearPendingNotarization();
    expect(peekPendingNotarization()).toBeNull();
    setPendingNotarization({ payloadHex: PAYLOAD_A, evidenceFilename: 'doc.pdf' });
    expect(peekPendingNotarization()?.payloadHex).toBe(PAYLOAD_A);
    clearPendingNotarization();
    expect(peekPendingNotarization()).toBeNull();
  });

  it('stamps a unique nonce and createdAt on set', () => {
    const a = setPendingNotarization({ payloadHex: PAYLOAD_A });
    const b = setPendingNotarization({ payloadHex: PAYLOAD_B });
    expect(a.nonce).not.toBe(b.nonce);
    expect(typeof b.createdAt).toBe('number');
    expect(peekPendingNotarization()?.nonce).toBe(b.nonce);
  });

  it('nonce-scoped clear only removes the matching intent', () => {
    const stale = setPendingNotarization({ payloadHex: PAYLOAD_A });
    const fresh = setPendingNotarization({ payloadHex: PAYLOAD_B });
    // A dismiss from the abandoned (stale) flow must not wipe the new handoff.
    clearPendingNotarization(stale.nonce);
    expect(peekPendingNotarization()?.nonce).toBe(fresh.nonce);
    clearPendingNotarization(fresh.nonce);
    expect(peekPendingNotarization()).toBeNull();
  });

  it('expires a stale intent after the TTL so it cannot resurrect later', () => {
    vi.useFakeTimers();
    setPendingNotarization({ payloadHex: PAYLOAD_A });
    vi.advanceTimersByTime(PENDING_NOTARIZATION_TTL_MS + 1);
    expect(peekPendingNotarization()).toBeNull();
    // Also gone on a subsequent peek (removed, not just filtered).
    vi.useRealTimers();
    expect(peekPendingNotarization()).toBeNull();
  });

  it('notifies subscribers on set and clear, and unsubscribes cleanly', () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribePendingNotarization(() => {
      seen.push(peekPendingNotarization()?.payloadHex ?? null);
    });
    const intent = setPendingNotarization({ payloadHex: PAYLOAD_A });
    clearPendingNotarization(intent.nonce);
    expect(seen).toEqual([PAYLOAD_A, null]);
    unsubscribe();
    setPendingNotarization({ payloadHex: PAYLOAD_B });
    expect(seen).toEqual([PAYLOAD_A, null]);
  });

  it('a mismatched nonce leaves the current intent untouched', () => {
    const current = setPendingNotarization({ payloadHex: PAYLOAD_A });
    clearPendingNotarization('not-the-nonce');
    expect(peekPendingNotarization()?.nonce).toBe(current.nonce);
  });
});

describe('findNotarizationsForAttachment', () => {
  it('matches on the attachment id recorded at notarization time', () => {
    const saved = [
      makeSavedPsbt({
        id: 5,
        name: 'Notarize doc.pdf',
        outputs: [
          {
            address: 'OP_RETURN',
            amountSats: 0,
            isChange: false,
            dataOutput: {
              payloadHex: PAYLOAD_A,
              isNotarization: true,
              evidenceId: 3,
              evidenceAttachmentId: 9,
              evidenceFilename: 'doc.pdf',
            },
          },
        ],
      }),
    ];
    const found = findNotarizationsForAttachment(saved, { id: 9, filename: 'doc.pdf' }, 3);
    expect(found).toHaveLength(1);
    expect(found[0].payloadHex).toBe(PAYLOAD_A);
    expect(found[0].savedPsbtName).toBe('Notarize doc.pdf');
  });

  it('falls back to evidence id + filename when the attachment id reference is lost', () => {
    const saved = [
      makeSavedPsbt({
        outputs: [
          {
            address: 'OP_RETURN',
            amountSats: 0,
            isChange: false,
            dataOutput: {
              payloadHex: PAYLOAD_B,
              isNotarization: true,
              evidenceId: 3,
              evidenceAttachmentId: 999, // stale id (remapped on restore)
              evidenceFilename: 'doc.pdf',
            },
          },
        ],
      }),
    ];
    // Different attachment id, same evidence + filename -> still matched.
    const found = findNotarizationsForAttachment(saved, { id: 12, filename: 'doc.pdf' }, 3);
    expect(found).toHaveLength(1);
    expect(found[0].payloadHex).toBe(PAYLOAD_B);
  });

  it('ignores non-notarization data outputs, other attachments, and unrelated PSBTs', () => {
    const saved = [
      makeSavedPsbt({
        id: 1,
        outputs: [
          // Data output without the notarization marker.
          { address: 'OP_RETURN', amountSats: 0, isChange: false, dataOutput: { payloadHex: PAYLOAD_A } },
        ],
      }),
      makeSavedPsbt({
        id: 2,
        outputs: [
          {
            address: 'OP_RETURN',
            amountSats: 0,
            isChange: false,
            dataOutput: {
              payloadHex: PAYLOAD_B,
              isNotarization: true,
              evidenceId: 4,
              evidenceAttachmentId: 10,
              evidenceFilename: 'other.pdf',
            },
          },
        ],
      }),
      makeSavedPsbt({ id: 3 }), // plain payment PSBT
    ];
    expect(findNotarizationsForAttachment(saved, { id: 9, filename: 'doc.pdf' }, 3)).toHaveLength(0);
    // The other attachment matches its own PSBT only.
    const other = findNotarizationsForAttachment(saved, { id: 10, filename: 'other.pdf' }, 4);
    expect(other).toHaveLength(1);
    expect(other[0].savedPsbtId).toBe(2);
  });

  it('reports multiple notarizations of the same file newest-first', () => {
    const dataOutput = {
      payloadHex: PAYLOAD_A,
      isNotarization: true,
      evidenceId: 3,
      evidenceAttachmentId: 9,
      evidenceFilename: 'doc.pdf',
    };
    const saved = [
      makeSavedPsbt({ id: 1, createdAt: 1_000, outputs: [{ address: 'OP_RETURN', amountSats: 0, isChange: false, dataOutput }] }),
      makeSavedPsbt({ id: 2, createdAt: 2_000, outputs: [{ address: 'OP_RETURN', amountSats: 0, isChange: false, dataOutput }] }),
    ];
    const found = findNotarizationsForAttachment(saved, { id: 9, filename: 'doc.pdf' }, 3);
    expect(found.map((f) => f.savedPsbtId)).toEqual([2, 1]);
  });
});
