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
 * Windows-1252 (WinAnsi) only differs from ISO-8859-1 (Latin-1) in the
 * 0x80–0x9F range, where it places a handful of printable punctuation glyphs
 * that live at much higher Unicode code points. jsPDF's Standard-14 fonts use
 * WinAnsiEncoding, so emitting the raw byte (e.g. 0x97) renders the correct
 * glyph (em-dash). This table maps those Unicode code points back to their
 * Windows-1252 byte so common punctuation survives the sanitizer instead of
 * being blanket-replaced with "?".
 */
const WINANSI_HIGH_RANGE: Record<number, number> = {
  0x20ac: 0x80, // € euro sign
  0x201a: 0x82, // ‚ single low-9 quotation mark
  0x0192: 0x83, // ƒ latin small letter f with hook
  0x201e: 0x84, // „ double low-9 quotation mark
  0x2026: 0x85, // … horizontal ellipsis
  0x2020: 0x86, // † dagger
  0x2021: 0x87, // ‡ double dagger
  0x02c6: 0x88, // ˆ modifier letter circumflex accent
  0x2030: 0x89, // ‰ per mille sign
  0x0160: 0x8a, // Š latin capital letter s with caron
  0x2039: 0x8b, // ‹ single left-pointing angle quotation mark
  0x0152: 0x8c, // Œ latin capital ligature oe
  0x017d: 0x8e, // Ž latin capital letter z with caron
  0x2018: 0x91, // ' left single quotation mark
  0x2019: 0x92, // ' right single quotation mark
  0x201c: 0x93, // " left double quotation mark
  0x201d: 0x94, // " right double quotation mark
  0x2022: 0x95, // • bullet
  0x2013: 0x96, // – en dash
  0x2014: 0x97, // — em dash
  0x02dc: 0x98, // ˜ small tilde
  0x2122: 0x99, // ™ trade mark sign
  0x0161: 0x9a, // š latin small letter s with caron
  0x203a: 0x9b, // › single right-pointing angle quotation mark
  0x0153: 0x9c, // œ latin small ligature oe
  0x017e: 0x9e, // ž latin small letter z with caron
  0x0178: 0x9f, // Ÿ latin capital letter y with diaeresis
};

/**
 * Make a string safe for jsPDF's Standard-14 Helvetica font (WinAnsi encoding)
 * so it never falls back to a UTF-16BE byte-stream (which renders as garbled
 * glyphs in most PDF viewers).
 *
 * Characters in U+0000–U+00FF are left intact because jsPDF maps them directly
 * through the WinAnsi code page. The printable punctuation that Windows-1252
 * places in its 0x80–0x9F range (em-dash U+2014, curly quotes, ellipsis, etc.)
 * is mapped back to the matching single byte so it renders as the correct glyph
 * instead of "?". Every remaining code point at U+0100 and above — including the
 * "↳" hop-indent marker (U+21B3) and any non-Latin user-supplied names — is
 * replaced with "?" so the output stays renderable without an embedded Unicode
 * font.
 */
export function sanitizePdfText(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0xff) {
      out += str[i];
      continue;
    }
    const winAnsiByte = WINANSI_HIGH_RANGE[code];
    out += winAnsiByte !== undefined ? String.fromCharCode(winAnsiByte) : "?";
  }
  return out;
}
