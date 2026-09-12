// @vitest-environment jsdom
//
// Regression guard for the garbled-text vector in the Continuity Certificate /
// Evidence Bundle PDF (lineageEngine.ts `downloadEvidenceBundlePdf`).
//
// The bug: jsPDF's Standard-14 Helvetica has no embedded Unicode font, so any
// text run outside the WinAnsi (Windows-1252) range is emitted as a UTF-16BE
// byte stream that renders as garbled glyphs. The fix routes user-supplied
// strings (bundle id, segment ids, origin/current addresses, txids, lineage
// chain entries) through `sanitizePdfText`. If a future edit drops one of those
// wrappers, a non-Latin address or label would silently reintroduce a UTF-16BE
// run. This test feeds non-WinAnsi text into every record-derived surface and
// asserts the generated PDF contains NO UTF-16BE runs.
//
// `downloadEvidenceBundlePdf` ends in `doc.save(filename)`. jsPDF's `save` is an
// own instance property (so it can't be spied/overridden via the prototype), and
// jsPDF's Node build implements `save` as `fs.writeFileSync(filename, buffer)`.
// We lean on exactly that: hand it a unique path under the OS temp dir, then read
// the bytes back and inspect the real generated PDF. The temp file is deleted in
// afterEach so nothing leaks into the workspace.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { extractPdfText, pdfHasUtf16beRuns } from "@/test/pdfAssertions";
import {
  downloadEvidenceBundlePdf,
  type EvidenceBundle,
} from "./lineageEngine";

const tmpFiles: string[] = [];

function tmpPdfPath(): string {
  const p = path.join(
    os.tmpdir(),
    `kyutxo-cert-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
  );
  tmpFiles.push(p);
  return p;
}

async function renderToBlob(b: EvidenceBundle): Promise<Blob> {
  const filePath = tmpPdfPath();
  await downloadEvidenceBundlePdf(b, filePath);
  const buf = await fs.readFile(filePath);
  return new Blob([buf], { type: "application/pdf" });
}

// Non-WinAnsi strings: CJK names and the "↳" marker all live above U+00FF, so
// before sanitization they would each force a UTF-16BE run.
const NON_LATIN_ADDR = "bc1q魏健address0000000000000000000000000000aa";
const NON_LATIN_TXID = "魏健" + "f".repeat(60);
const NON_LATIN_SEG = "段_測試_↳";

function bundle(): EvidenceBundle {
  return {
    version: "1.0",
    generatedAt: new Date("2025-06-15T08:00:00Z").toISOString(),
    bundleId: "bundle_測試123456",
    isPartial: false,
    summary: {
      totalSegments: 1,
      totalValueBtc: 1.23456789,
      earliestOrigin: new Date("2025-01-01T00:00:00Z").toISOString(),
      latestActivity: new Date("2025-06-01T00:00:00Z").toISOString(),
      totalCustodyDays: 151,
    },
    segments: [
      {
        segmentId: NON_LATIN_SEG,
        origin: {
          address: NON_LATIN_ADDR,
          txid: NON_LATIN_TXID,
          vout: 0,
          date: new Date("2025-01-01T00:00:00Z").toISOString(),
          amount: 100_000_000,
        },
        current: {
          address: NON_LATIN_ADDR,
          txid: NON_LATIN_TXID,
          vout: 1,
          amount: 100_000_000,
          status: "active",
        },
        custodyDays: 151,
        hopCount: 2,
        lineageChain: [
          { txid: NON_LATIN_TXID, type: "created", confidenceLevel: "high" },
          { txid: NON_LATIN_TXID, type: "spent", confidenceLevel: "medium" },
        ],
        includesFullAddresses: true,
        includesFullTxids: true,
      },
    ],
    integrityHash: "abcdef0123456789".repeat(4),
  };
}

afterEach(async () => {
  await Promise.all(
    tmpFiles.splice(0).map((p) => fs.rm(p, { force: true })),
  );
});

describe("Continuity Certificate PDF — WinAnsi safety", () => {
  it("emits no UTF-16BE runs even with non-Latin addresses, txids and labels", async () => {
    const blob = await renderToBlob(bundle());

    // The smoking gun: any UTF-16BE run means a record-derived string skipped
    // sanitizePdfText and will render as garbled glyphs.
    expect(await pdfHasUtf16beRuns(blob)).toBe(false);

    const text = await extractPdfText(blob);
    // ASCII scaffolding around the sanitized fields still renders, proving the
    // text was emitted (not dropped) and the non-Latin glyphs were substituted.
    expect(text).toContain("Bundle ID: bundle_");
    expect(text).toContain("Segment 1:");
    expect(text).toContain("Address:");
    expect(text).toContain("TXID:");
    // Non-Latin glyphs were replaced with the safe "?" substitute.
    expect(text).toContain("?");
  });

  it("stays WinAnsi-safe for a partial (INCOMPLETE) bundle too", async () => {
    const partial = bundle();
    partial.isPartial = true;
    partial.requestedSegments = 3;

    const blob = await renderToBlob(partial);
    expect(await pdfHasUtf16beRuns(blob)).toBe(false);
    const text = await extractPdfText(blob);
    expect(text).toContain("INCOMPLETE");
  });

  it("would catch a bypass: raw non-Latin text DOES produce UTF-16BE runs", async () => {
    // Control proving the guard above is meaningful: render the same non-Latin
    // text WITHOUT sanitizePdfText via a bare jsPDF doc. This is exactly what a
    // regression (dropping the wrapper) would emit — and it must trip the
    // detector, otherwise the assertions above could pass vacuously.
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF();
    doc.text(`Address: ${NON_LATIN_ADDR}`, 14, 20);
    const rawBlob = doc.output("blob");
    expect(await pdfHasUtf16beRuns(rawBlob)).toBe(true);
  });
});
