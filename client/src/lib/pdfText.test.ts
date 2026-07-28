import { describe, it, expect } from "vitest";

import { sanitizePdfText } from "./pdfText";

// ---------------------------------------------------------------------------
// sanitizePdfText is the single guard that keeps jsPDF's Standard-14 Helvetica
// from falling back to a UTF-16BE byte stream (the garbled-glyph bug). Every
// PDF export (Fund Trail, Annual Activity Report, Continuity Certificate) routes
// record-derived text through it. These tests pin the contract: U+0000–U+00FF
// survive unchanged (jsPDF maps them through the WinAnsi code page); the
// printable punctuation Windows-1252 places in its 0x80–0x9F range (em-dash,
// curly quotes, ellipsis, …) is remapped to the matching single byte so jsPDF
// renders the correct glyph; anything else at U+0100 or above is replaced with
// "?".
// ---------------------------------------------------------------------------

describe("sanitizePdfText", () => {
  it("leaves plain ASCII unchanged", () => {
    expect(sanitizePdfText("bc1qalice 1.5 BTC")).toBe("bc1qalice 1.5 BTC");
  });

  it("keeps dots in user text literally (labels, wallet names, versions)", () => {
    // Dot is ASCII 0x2E — well inside WinAnsi — so dotted user values
    // (including leading/trailing/consecutive dots) must survive verbatim in
    // every PDF export that routes text through this sanitizer.
    for (const s of ["Ledger v1.2", "cold.storage", "Alice.", ".hidden", "a..b", "..."]) {
      expect(sanitizePdfText(s)).toBe(s);
    }
  });

  it("preserves Latin-1 (U+0080–U+00FF) characters such as accents", () => {
    // é = U+00E9, ñ = U+00F1, ÿ = U+00FF — all inside the WinAnsi range and at
    // or below the helper's U+00FF cutoff, so they survive unchanged.
    const input = "Café Niño ÿ";
    expect(sanitizePdfText(input)).toBe(input);
  });

  it("remaps the em-dash to its WinAnsi byte (0x97) so jsPDF draws it", () => {
    // The em-dash is U+2014 — above the Latin-1 cutoff (U+00FF) but present in
    // the Windows-1252 0x80–0x9F range at byte 0x97. jsPDF's Standard-14 fonts
    // use WinAnsiEncoding, so emitting byte 0x97 renders the correct glyph.
    expect(sanitizePdfText("Alice — Bob")).toBe("Alice \u0097 Bob");
  });

  it("remaps other common WinAnsi punctuation (curly quotes, ellipsis, bullet)", () => {
    // '…'” • — all live in the Windows-1252 high range.
    expect(sanitizePdfText("\u2018a\u2019")).toBe("\u0091a\u0092"); // ' a '
    expect(sanitizePdfText("\u201Cb\u201D")).toBe("\u0093b\u0094"); // " b "
    expect(sanitizePdfText("wait\u2026")).toBe("wait\u0085"); // ellipsis
    expect(sanitizePdfText("\u2022 item")).toBe("\u0095 item"); // bullet
    expect(sanitizePdfText("a\u2013b")).toBe("a\u0096b"); // en dash
  });

  it("replaces the hop-indent marker ↳ (U+21B3) with ?", () => {
    expect(sanitizePdfText("↳ Carol")).toBe("? Carol");
  });

  it("replaces non-Latin (CJK) names with ?, leaving ASCII intact", () => {
    // "Wei (魏健)" — the two CJK glyphs are outside WinAnsi.
    expect(sanitizePdfText("Wei (魏健)")).toBe("Wei (??)");
  });

  it("replaces emoji and other astral-plane characters", () => {
    // A char above U+00FF anywhere in the string is substituted.
    expect(sanitizePdfText("ok→go")).toBe("ok?go");
  });

  it("replaces every char at U+0100 and above but nothing at U+00FF", () => {
    // Boundary proof: U+00FF stays, U+0100 flips to "?".
    expect(sanitizePdfText("\u00FF")).toBe("\u00FF");
    expect(sanitizePdfText("\u0100")).toBe("?");
  });

  it("returns an empty string unchanged", () => {
    expect(sanitizePdfText("")).toBe("");
  });
});
