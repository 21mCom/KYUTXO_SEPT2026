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
  evidenceId?: number;
  evidenceAttachmentId?: number;
  evidenceTitle?: string;
  evidenceFilename?: string;
}

// Module-level handoff: the Evidence page sets the intent and navigates to
// the UTXOs page, which reads it on mount. SPA navigation keeps module state;
// a full reload clears it (by design — the digest is cheap to recompute).
let pending: NotarizationIntent | null = null;

export function setPendingNotarization(intent: NotarizationIntent): void {
  pending = intent;
}

export function peekPendingNotarization(): NotarizationIntent | null {
  return pending;
}

export function clearPendingNotarization(): void {
  pending = null;
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
