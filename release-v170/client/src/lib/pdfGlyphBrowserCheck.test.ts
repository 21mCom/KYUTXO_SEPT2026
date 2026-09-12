import { describe, it, expect } from 'vitest';

import { runPdfGlyphBrowserCheck } from './pdfGlyphBrowserCheck';

// ---------------------------------------------------------------------------
// Deterministic CI coverage for the PDF-glyph real-viewer guard.
//
// pdfText.test.ts pins the BYTE mapping sanitizePdfText applies (U+2014 -> 0x97),
// but it cannot prove a real PDF rendering engine interprets that byte as the
// em-dash glyph. This test runs the full pipeline — generate a jsPDF document
// whose text is routed through sanitizePdfText, then re-open it with pdf.js (the
// engine Firefox ships as its PDF viewer) and confirm every remapped punctuation
// mark round-trips to the correct Unicode code point. The same module is run in
// a REAL headless Chromium by scripts/check-pdf-glyph-browser.mjs so the live,
// Vite-bundled jsPDF + pdf.js path users actually get is exercised too.
// ---------------------------------------------------------------------------

describe('runPdfGlyphBrowserCheck', () => {
  it('round-trips every remapped punctuation glyph through a real PDF engine', async () => {
    const report = await runPdfGlyphBrowserCheck({ throwOnFailure: false });

    const failed = report.steps.filter((s) => !s.passed);
    expect(
      failed,
      `Failed steps:\n${failed.map((s) => `  - ${s.name}: ${s.detail}`).join('\n')}`,
    ).toEqual([]);
    expect(report.ok).toBe(true);
  }, 30_000);

  it('recovers the em-dash glyph specifically (not "?" or a garble)', async () => {
    const report = await runPdfGlyphBrowserCheck({ throwOnFailure: false });
    // The em-dash is the canonical regression: it must appear, and the positive
    // line must contain no replacement characters at all.
    expect(report.extracted).toContain('\u2014');
    expect(report.extracted).not.toContain('?');
  }, 30_000);
});
