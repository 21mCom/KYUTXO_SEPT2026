// ── Supporting Evidence (optional) ──────────────────────────────────────────
// Declarants may attach screenshots/photos (embedded into the dossier PDF) and
// PDF documents (merged onto the end as extra pages). Files are held in memory
// only for the current session — never written to localStorage or IndexedDB —
// and processed entirely offline.
export type EvidenceKind = "image" | "pdf";

export interface EvidenceItem {
  id: string;
  name: string;
  kind: EvidenceKind;
  mime: string;
  /** Raw file bytes; hashed for the fingerprint and used for embed/merge. */
  bytes: Uint8Array;
  /** Images only: data URL for the form thumbnail and jsPDF embedding. */
  dataUrl?: string;
  caption: string;
  sha256: string;
  size: number;
  /** PDFs only: page count, validated and shown in the exhibit index. */
  pageCount?: number;
}

export const EVIDENCE_MAX_ITEMS = 20;
export const EVIDENCE_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
// Cumulative cap across all attachments. Image data URLs, jsPDF's embedded
// copies, and pdf-lib's in-memory merge all multiply the raw bytes, so a
// generous per-file cap with no overall ceiling could still exhaust memory and
// freeze the renderer. Bound the total to keep PDF generation safe.
export const EVIDENCE_MAX_TOTAL_BYTES = 75 * 1024 * 1024; // 75 MB combined
export const EVIDENCE_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";
export const EVIDENCE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"];

let evidenceIdCounter = 0;
export function nextEvidenceId(): string {
  evidenceIdCounter += 1;
  return `ev-${Date.now().toString(36)}-${evidenceIdCounter}`;
}

export async function hashBytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Browser-safe base64 (no Node Buffer): chunk to stay within the
// String.fromCharCode argument limit for large images.
export function imageBytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function formatEvidenceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
