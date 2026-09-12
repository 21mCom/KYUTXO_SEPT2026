// Shared export helpers for Continuity Proof custody segments.
//
// `buildSegmentProofPayload` is the single source of truth for the per-segment
// proof document: the JSON download, the per-segment PDF download and the
// combined all-segments PDF in ContinuityProof.tsx all consume the payload it
// returns, so the formats can never drift apart. `renderSegmentProofSection`
// is likewise the single renderer used by both the per-segment and the
// combined PDF, so their per-segment layout is identical by construction.
//
// The PDF is rendered with jsPDF's Standard-14 Helvetica font (no embedded
// Unicode font), so every string drawn into the document is routed through
// `sanitizePdfText` — without it, punctuation outside WinAnsi (em-dashes,
// curly quotes, ...) falls back to a UTF-16BE byte-stream and renders as
// garbled glyphs in most PDF viewers.

import { sanitizePdfText } from "./pdfText";
import { unixSecondsToDate } from "./unix-seconds";
import type { CustodySegment } from "./db-types";

export interface SegmentProofPayload {
  segmentId: string;
  origin: {
    txid: string;
    vout: number;
    address: string;
    date: string | null;
    amount: string;
  };
  current: {
    address: string;
    amount: string;
  } | null;
  custody: {
    status: string;
    hopCount: number;
    narrative?: string;
  };
  evidence: {
    txids: string[];
  };
  metadata: {
    owner?: string;
    walletName?: string;
    seedName?: string;
    acquisitionMethod?: string;
    costBasisUsd?: number;
  };
  generatedAt: string;
}

const formatBtc = (sats: number) => (sats / 100_000_000).toFixed(8);

/**
 * Assemble the full per-segment proof object. `generatedAt` is injectable so
 * tests can pin the timestamp; production callers use the default.
 */
export function buildSegmentProofPayload(
  segment: CustodySegment,
  generatedAt: Date = new Date(),
): SegmentProofPayload {
  return {
    segmentId: segment.segmentId,
    origin: {
      txid: segment.originTxid,
      vout: segment.originVout,
      address: segment.originAddress,
      date: unixSecondsToDate(segment.originDate)?.toISOString() ?? null,
      amount: formatBtc(segment.originAmount) + " BTC",
    },
    current: segment.currentAddress
      ? {
          address: segment.currentAddress,
          amount: formatBtc(segment.currentAmount) + " BTC",
        }
      : null,
    custody: {
      status: segment.status,
      hopCount: segment.hopCount,
      narrative: segment.narrative,
    },
    evidence: {
      // Sparse rows restored from older backups may lack array fields.
      txids: Array.isArray(segment.evidenceTxids) ? segment.evidenceTxids : [],
    },
    metadata: {
      owner: segment.owner,
      walletName: segment.walletName,
      seedName: segment.seedName,
      acquisitionMethod: segment.acquisitionMethod,
      costBasisUsd: segment.costBasisUsd,
    },
    generatedAt: generatedAt.toISOString(),
  };
}

// jsPDF's type is imported dynamically; keep the renderer loosely typed on
// the doc handle so callers don't need a static jspdf import.
type JsPdfDoc = InstanceType<typeof import("jspdf").jsPDF>;

/**
 * Render one segment's proof payload into `doc` starting at `startY`,
 * handling its own page breaks. Shared by the per-segment PDF and the
 * combined all-segments PDF so the two can never drift apart.
 * Returns the y position after the last written line.
 */
function renderSegmentProofSection(
  doc: JsPdfDoc,
  payload: SegmentProofPayload,
  startY: number,
): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = startY;

  const checkPageBreak = (neededSpace: number) => {
    if (y + neededSpace > 280) {
      doc.addPage();
      y = 20;
    }
  };

  const writeLabelValue = (label: string, value: string) => {
    checkPageBreak(6);
    doc.setFont("helvetica", "bold");
    doc.text(label, margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(sanitizePdfText(value), margin + 45, y);
    y += 6;
  };

  const writeWrapped = (text: string) => {
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(sanitizePdfText(text), contentWidth);
    for (const line of lines as string[]) {
      checkPageBreak(6);
      doc.text(line, margin, y);
      y += 5;
    }
  };

  const writeSectionHeading = (heading: string) => {
    checkPageBreak(14);
    y += 4;
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0);
    doc.text(heading, margin, y);
    y += 7;
    doc.setFontSize(10);
  };

  // Segment info box
  checkPageBreak(24);
  doc.setDrawColor(200);
  doc.setFillColor(248, 248, 248);
  doc.roundedRect(margin, y, contentWidth, 20, 2, 2, "FD");

  doc.setTextColor(60);
  doc.setFontSize(9);
  y += 7;
  doc.text(sanitizePdfText(`Segment ID: ${payload.segmentId}`), margin + 5, y);
  y += 6;
  doc.text(
    `Generated: ${new Date(payload.generatedAt).toLocaleString()}`,
    margin + 5,
    y,
  );
  y += 12;

  // Origin
  writeSectionHeading("Origin");
  doc.setFontSize(9);
  writeLabelValue("TXID:", payload.origin.txid);
  writeLabelValue("Output Index:", String(payload.origin.vout));
  writeLabelValue("Address:", payload.origin.address);
  writeLabelValue(
    "Date:",
    payload.origin.date
      ? new Date(payload.origin.date).toLocaleString()
      : "Unknown",
  );
  writeLabelValue("Amount:", payload.origin.amount);

  // Current custody
  writeSectionHeading("Current Custody");
  doc.setFontSize(9);
  if (payload.current) {
    writeLabelValue("Address:", payload.current.address);
    writeLabelValue("Amount:", payload.current.amount);
  } else {
    writeLabelValue("Holding:", "No current UTXO (fully spent or merged)");
  }
  writeLabelValue("Status:", payload.custody.status.toUpperCase());
  writeLabelValue("Hop Count:", String(payload.custody.hopCount));

  // Narrative
  if (payload.custody.narrative) {
    writeSectionHeading("Narrative");
    doc.setFontSize(9);
    writeWrapped(payload.custody.narrative);
  }

  // Evidence txids
  writeSectionHeading(
    `Evidence Transactions (${payload.evidence.txids.length})`,
  );
  doc.setFontSize(9);
  if (payload.evidence.txids.length === 0) {
    doc.setTextColor(100);
    doc.text("No evidence transactions recorded.", margin, y);
    doc.setTextColor(0);
    y += 6;
  } else {
    for (let i = 0; i < payload.evidence.txids.length; i++) {
      checkPageBreak(6);
      doc.text(
        sanitizePdfText(`${i + 1}. ${payload.evidence.txids[i]}`),
        margin,
        y,
      );
      y += 5;
    }
    y += 1;
  }

  // Metadata
  const meta = payload.metadata;
  const hasMetadata =
    meta.owner ||
    meta.walletName ||
    meta.seedName ||
    meta.acquisitionMethod ||
    meta.costBasisUsd != null;
  if (hasMetadata) {
    writeSectionHeading("Metadata");
    doc.setFontSize(9);
    if (meta.owner) writeLabelValue("Owner:", meta.owner);
    if (meta.walletName) writeLabelValue("Wallet:", meta.walletName);
    if (meta.seedName) writeLabelValue("Seed:", meta.seedName);
    if (meta.acquisitionMethod) {
      writeLabelValue("Acquired via:", meta.acquisitionMethod);
    }
    if (meta.costBasisUsd != null) {
      writeLabelValue("Cost Basis:", `USD ${meta.costBasisUsd.toFixed(2)}`);
    }
  }

  return y;
}

/** Draw the document title block; returns the y position after it. */
function renderPdfTitle(doc: JsPdfDoc, subtitle: string, startY: number): number {
  const margin = 20;
  let y = startY;
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0);
  doc.text("KYUTXO Custody Proof", margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(sanitizePdfText(subtitle), margin, y);
  y += 8;
  return y;
}

/** Stamp the standard footer onto the current page. */
function renderPdfFooter(doc: JsPdfDoc, pageLabel: string): void {
  const margin = 20;
  const pageWidth = doc.internal.pageSize.getWidth();
  const y = doc.internal.pageSize.getHeight() - 20;
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text("Generated by KYUTXO - Bitcoin Metadata Manager", margin, y);
  doc.text(pageLabel, pageWidth - margin - 20, y);
}

/** Render the per-segment proof payload as a human-readable PDF and save it. */
export async function downloadSegmentProofPdf(
  payload: SegmentProofPayload,
  filename?: string,
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();

  let y = renderPdfTitle(doc, "Continuity Proof - Custody Segment", 20);
  renderSegmentProofSection(doc, payload, y);

  // Footer on last page
  renderPdfFooter(doc, `Page ${doc.getNumberOfPages()}`);

  doc.save(filename || `custody-proof-${payload.segmentId}.pdf`);
}

/** Thrown when a combined export is cancelled by the user. */
export class PdfExportCancelledError extends Error {
  constructor() {
    super("PDF export cancelled");
    this.name = "PdfExportCancelledError";
  }
}

export interface AllSegmentProofsPdfOptions {
  /**
   * Keyset page fetcher: returns up to `limit` segments with id < `beforeId`,
   * ordered by descending id. The export walks pages until one comes back
   * short, so the whole table is never materialised at once.
   */
  fetchPage: (beforeId: number, limit: number) => Promise<CustodySegment[]>;
  /** Total matching segments (drives the progress callback denominator). */
  totalCount: number;
  /** Called after each segment is rendered. */
  onProgress?: (done: number, total: number) => void;
  /** Abort to cancel; throws PdfExportCancelledError, nothing is saved. */
  signal?: AbortSignal;
  filename?: string;
  /** Injectable timestamp for tests; production callers use the default. */
  generatedAt?: Date;
  /** Page size for fetchPage; exposed for tests. */
  pageSize?: number;
}

/**
 * Render every custody segment (as served by `fetchPage`, which is expected
 * to apply any active list filters) into one combined PDF and save it.
 * Each segment starts on its own page and its content is produced by the
 * exact same payload builder + renderer as the per-segment PDF.
 * Returns the number of segments exported.
 */
export async function downloadAllSegmentProofsPdf(
  options: AllSegmentProofsPdfOptions,
): Promise<number> {
  const {
    fetchPage,
    totalCount,
    onProgress,
    signal,
    generatedAt = new Date(),
    pageSize = 100,
  } = options;

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new PdfExportCancelledError();
  };

  throwIfCancelled();
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();

  // Cover / summary page.
  let y = renderPdfTitle(
    doc,
    "Continuity Proof - All Custody Segments",
    20,
  );
  doc.setFontSize(9);
  doc.setTextColor(60);
  doc.text(
    sanitizePdfText(`Segments included: ${totalCount}`),
    20,
    y,
  );
  y += 6;
  doc.text(`Generated: ${generatedAt.toLocaleString()}`, 20, y);

  let done = 0;
  let beforeId = Number.MAX_SAFE_INTEGER;
  for (;;) {
    throwIfCancelled();
    const page = await fetchPage(beforeId, pageSize);
    if (page.length === 0) break;
    for (const segment of page) {
      throwIfCancelled();
      doc.addPage();
      const payload = buildSegmentProofPayload(segment, generatedAt);
      let segY = renderPdfTitle(
        doc,
        `Custody Segment ${done + 1} of ${totalCount}`,
        20,
      );
      renderSegmentProofSection(doc, payload, segY);
      done += 1;
      onProgress?.(done, totalCount);
      // Yield so the UI stays responsive (and cancel clicks land) on large
      // vaults; rendering is synchronous per segment.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const lastId = page[page.length - 1].id;
    if (typeof lastId !== "number" || page.length < pageSize) break;
    beforeId = lastId;
  }

  throwIfCancelled();

  // Footer with page numbers on every page.
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    renderPdfFooter(doc, `Page ${i} of ${pageCount}`);
  }

  const datePart = generatedAt.toISOString().slice(0, 10);
  doc.save(options.filename || `custody-proofs-${datePart}.pdf`);
  return done;
}
