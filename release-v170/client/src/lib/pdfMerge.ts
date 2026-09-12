// Offline PDF merging for the Proof of Funds dossier.
//
// jsPDF builds the generated dossier (declaration text + embedded evidence
// images), but it cannot import or append pages from an existing PDF. When the
// declarant attaches PDF exhibits, we hand the finished jsPDF bytes plus each
// uploaded PDF to pdf-lib, which copies every exhibit page onto the end of the
// dossier and returns the combined document.
//
// Everything here runs in the browser with Uint8Array only (no Node Buffer):
// pdf-lib's load() accepts a Uint8Array and save() returns one, so the whole
// path stays offline and bundler-safe.

import { PDFDocument } from "pdf-lib";

export interface PdfExhibit {
  /** Original file name, used only for clear error messages. */
  name: string;
  /** Raw bytes of the uploaded PDF. */
  bytes: Uint8Array;
}

/**
 * Count the pages of a PDF. Used at upload time to validate that a file is a
 * readable PDF and to show the page count in the UI / exhibit index. Throws a
 * human-readable error if the file cannot be parsed.
 */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    throw new Error(
      "This file could not be read as a PDF. It may be corrupted or password-protected.",
    );
  }
}

/**
 * Append every exhibit's pages to the end of the base (dossier) PDF, preserving
 * the order in which exhibits are supplied. Returns the combined PDF bytes.
 *
 * Exhibit pages are copied verbatim — no watermark or footer is stamped onto
 * them — so the attached documents remain pristine. A failure to read any single
 * exhibit aborts the whole merge with a clear, file-named error rather than
 * silently dropping pages.
 */
export async function mergeEvidencePdfs(
  baseBytes: Uint8Array,
  exhibits: PdfExhibit[],
): Promise<Uint8Array> {
  const merged = await PDFDocument.load(baseBytes, { ignoreEncryption: true });

  for (const exhibit of exhibits) {
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(exhibit.bytes, { ignoreEncryption: true });
    } catch {
      throw new Error(
        `Could not read the PDF "${exhibit.name}". It may be corrupted or password-protected.`,
      );
    }
    const copied = await merged.copyPages(source, source.getPageIndices());
    for (const page of copied) {
      merged.addPage(page);
    }
  }

  return merged.save();
}
