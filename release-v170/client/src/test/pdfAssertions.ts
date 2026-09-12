// Shared helpers for asserting on jsPDF output in tests.
//
// KYUTXO's PDF exports use jsPDF's Standard-14 Helvetica with no embedded
// Unicode font. Any text run jsPDF cannot map through the WinAnsi (Windows-1252)
// code page is emitted as a UTF-16BE byte stream, which renders as garbled
// glyphs in most viewers. UTF-16BE runs are identifiable by embedded NUL bytes
// in the PDF text literals. These helpers recover the rendered text and detect
// those runs so tests can prove the sanitizePdfText guard is still wired in.

function unescapePdfLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let oct = next;
      i++;
      for (let k = 0; k < 2; k++) {
        const d = raw[i + 1];
        if (d >= "0" && d <= "7") {
          oct += d;
          i++;
        } else {
          break;
        }
      }
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
      };
      out += escapes[next] ?? next;
      i++;
    }
  }
  return out;
}

function decodePdfBytes(bytes: string): string {
  // A run carrying any NUL byte is a UTF-16BE string; decode it as pairs.
  if (!bytes.includes("\u0000")) return bytes;
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(
      (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1),
    );
  }
  return out;
}

/** Recover the rendered text from a (uncompressed) jsPDF blob's content streams. */
export async function extractPdfText(blob: Blob): Promise<string> {
  const latin1 = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  const literals = latin1.match(/\((?:[^()\\]|\\.)*\)/g) ?? [];
  return literals
    .map((lit) => decodePdfBytes(unescapePdfLiteral(lit.slice(1, -1))))
    .join("\n");
}

/**
 * Returns true if any PDF text literal in the blob was emitted as a UTF-16BE
 * byte stream (i.e. contains embedded NUL bytes). That encoding is the root
 * cause of the garbled-text bug: Helvetica/WinAnsi cannot render those runs.
 */
export async function pdfHasUtf16beRuns(blob: Blob): Promise<boolean> {
  const latin1 = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  const literals = latin1.match(/\((?:[^()\\]|\\.)*\)/g) ?? [];
  return literals.some((lit) =>
    unescapePdfLiteral(lit.slice(1, -1)).includes("\u0000"),
  );
}
