/**
 * On-chain evidence notarization helpers.
 *
 * The Evidence page hashes an attachment's bytes (SHA-256) and hands the
 * digest to the watch-only PSBT builder as an OP_RETURN data output. The user
 * signs and broadcasts the transaction externally; anyone holding the file
 * can later prove it existed at that block time.
 *
 * This module holds:
 *   - the pending-notarization handoff between the Evidence page and the
 *     UTXOs page (where UTXO selection + the build dialog live);
 *   - matching of saved PSBTs back to the attachment they notarize, so the
 *     Evidence page can show the notarized state and offer a Verify action;
 *   - the SHA-256 helper (WebCrypto — browser-safe, no Buffer).
 */

import type { SavedPsbt } from './database';

export interface NotarizationIntent {
  /** Hex-encoded SHA-256 digest of the evidence file bytes. */
  payloadHex: string;
  /** Unique id of this handoff; dismiss/save clears only the matching intent. */
  nonce: string;
  /** Epoch ms when the intent was created; stale intents expire (see TTL). */
  createdAt: number;
  evidenceId?: number;
  evidenceAttachmentId?: number;
  evidenceTitle?: string;
  evidenceFilename?: string;
}

/** Fields the Evidence page provides; nonce/createdAt are stamped on set. */
export type NotarizationIntentInput = Omit<NotarizationIntent, 'nonce' | 'createdAt'>;

// Tab-scoped handoff: the Evidence page sets the intent and navigates to the
// UTXOs page. Stored in sessionStorage (per-tab, so a second tab never sees or
// consumes another tab's intent) and broadcast via an in-tab subscription so an
// already-mounted UTXOs page picks it up without a remount. A TTL keeps an
// abandoned flow's intent from resurrecting on a much later visit.
const STORAGE_KEY = 'kyutxo-pending-notarization';
export const PENDING_NOTARIZATION_TTL_MS = 15 * 60 * 1000;

// In-memory fallback when sessionStorage is unavailable (e.g. Node tests).
let memoryPending: string | null = null;

function readRaw(): string | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // fall through to memory
  }
  return memoryPending;
}

function writeRaw(value: string | null): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (value === null) sessionStorage.removeItem(STORAGE_KEY);
      else sessionStorage.setItem(STORAGE_KEY, value);
      return;
    }
  } catch {
    // fall through to memory
  }
  memoryPending = value;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of Array.from(listeners)) l();
}

/**
 * Subscribe to pending-intent changes in THIS tab. Returns an unsubscribe
 * function. sessionStorage is per-tab, so no cross-tab events are needed.
 */
export function subscribePendingNotarization(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function makeNonce(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function setPendingNotarization(intent: NotarizationIntentInput): NotarizationIntent {
  const full: NotarizationIntent = { ...intent, nonce: makeNonce(), createdAt: Date.now() };
  writeRaw(JSON.stringify(full));
  notify();
  return full;
}

export function peekPendingNotarization(): NotarizationIntent | null {
  const raw = readRaw();
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeRaw(null);
    return null;
  }
  const intent = parsed as Partial<NotarizationIntent> | null;
  if (
    !intent ||
    typeof intent.payloadHex !== 'string' ||
    typeof intent.nonce !== 'string' ||
    typeof intent.createdAt !== 'number'
  ) {
    writeRaw(null);
    return null;
  }
  // Expire abandoned flows so a stale intent cannot resurrect much later.
  if (Date.now() - intent.createdAt > PENDING_NOTARIZATION_TTL_MS) {
    writeRaw(null);
    notify();
    return null;
  }
  return intent as NotarizationIntent;
}

/**
 * Clear the pending intent. When a nonce is given, only the matching intent
 * is cleared — a dismiss/save from a stale flow can't wipe a newer handoff.
 */
export function clearPendingNotarization(nonce?: string): void {
  if (nonce !== undefined) {
    const current = peekPendingNotarization();
    if (!current || current.nonce !== nonce) return;
  }
  writeRaw(null);
  notify();
}

/** SHA-256 of a Blob's bytes as lowercase hex (WebCrypto; browser-safe). */
export async function hashBlobSha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export interface NotarizationRecord {
  savedPsbtId?: number;
  savedPsbtName: string;
  payloadHex: string;
  createdAt: number;
}

/**
 * Find the saved PSBTs that notarize a given attachment. Matches on the
 * attachment id first (the precise reference written at notarization time),
 * falling back to evidence id + filename for rows whose attachment reference
 * was lost (e.g. the attachment was re-created). Evidence references are
 * best-effort: ids are remapped on restore, so a restored vault can only
 * match via the filename fallback.
 */
export function findNotarizationsForAttachment(
  saved: SavedPsbt[],
  attachment: { id?: number; filename: string },
  evidenceId?: number,
): NotarizationRecord[] {
  const out: NotarizationRecord[] = [];
  for (const psbt of saved) {
    for (const output of psbt.outputs ?? []) {
      const data = output.dataOutput;
      if (!data?.isNotarization) continue;
      const idMatch =
        attachment.id !== undefined && data.evidenceAttachmentId === attachment.id;
      const fallbackMatch =
        evidenceId !== undefined &&
        data.evidenceId === evidenceId &&
        data.evidenceFilename === attachment.filename;
      if (!idMatch && !fallbackMatch) continue;
      out.push({
        savedPsbtId: psbt.id,
        savedPsbtName: psbt.name,
        payloadHex: data.payloadHex,
        createdAt: psbt.createdAt,
      });
      break; // one notarization entry per PSBT is enough
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
