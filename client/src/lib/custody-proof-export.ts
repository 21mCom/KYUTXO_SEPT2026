// Shared export helpers for a single Continuity Proof custody segment.
//
// `buildSegmentProofPayload` is the single source of truth for the per-segment
// proof document: the JSON download and the PDF download in
// ContinuityProof.tsx both consume the payload it returns, so the two formats
// can never drift apart.
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

/** Render the per-segment proof payload as a human-readable PDF and save it. */
export async function downloadSegmentProofPdf(
  payload: SegmentProofPayload,
  filename?: string,
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = 20;

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

  // Title
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("KYUTXO Custody Proof", margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text("Continuity Proof - Custody Segment", margin, y);
  y += 8;

  // Segment info box
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

  // Footer on last page
  checkPageBreak(20);
  y = doc.internal.pageSize.getHeight() - 20;
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text("Generated by KYUTXO - Bitcoin Metadata Manager", margin, y);
  doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin - 20, y);

  doc.save(filename || `custody-proof-${payload.segmentId}.pdf`);
}
