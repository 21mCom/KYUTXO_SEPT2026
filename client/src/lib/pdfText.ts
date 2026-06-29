/**
 * Shared WinAnsi-safe text helper for jsPDF exports.
 *
 * KYUTXO's PDF exports (Fund Trail, Annual Activity Report, lineage/continuity
 * certificate) all use jsPDF's Standard-14 Helvetica font with no embedded
 * Unicode font. When jsPDF encounters a character outside the WinAnsi
 * (Windows-1252) 8-bit range it falls back to emitting that text run as a
 * UTF-16BE byte-stream, which renders as garbled glyphs in most PDF viewers.
 *
 * Routing every user-supplied string (wallet names, owner names, segment
 * labels, etc.) through `sanitizePdfText` keeps the output renderable without
 * shipping an embedded Unicode font, preserving KYUTXO's offline-first
 * guarantee.
 */

/**
 * Replace any character outside the WinAnsi (Windows-1252) 8-bit range with a
 * safe ASCII substitute so jsPDF's Standard-14 Helvetica font never falls back
 * to a UTF-16BE byte-stream, which renders as garbled glyphs in most PDF viewers.
 *
 * Characters in U+0000–U+00FF are left intact because jsPDF maps them through
 * the WinAnsi code page, which covers all Latin-1 symbols including the em-dash
 * (U+2014 → WinAnsi 0x97). Characters at U+0100 and above — including the "↳"
 * hop-indent marker (U+21B3) and any non-Latin user-supplied names — are
 * replaced with "?" so they stay renderable without requiring an embedded
 * Unicode font.
 */
export function sanitizePdfText(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += str.charCodeAt(i) <= 0xff ? str[i] : "?";
  }
  return out;
}
