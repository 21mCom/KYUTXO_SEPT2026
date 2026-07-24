/**
 * Real-viewer regression guard for jsPDF WinAnsi glyph rendering.
 *
 * Why this exists
 * ---------------
 * KYUTXO's PDF exports (Fund Trail, Annual Activity Report, Proof of Funds AML
 * appendix, lineage/continuity certificate) use jsPDF's Standard-14 Helvetica
 * with no embedded Unicode font. `sanitizePdfText` (./pdfText) remaps the
 * printable punctuation Windows-1252 places in its 0x80-0x9F range — em-dash
 * (U+2014), curly quotes, ellipsis, bullet, … — back to the matching single
 * WinAnsi byte so jsPDF emits the correct glyph instead of "?". The unit tests
 * in pdfText.test.ts pin that BYTE mapping (U+2014 -> 0x97), but a byte-level
 * assertion cannot prove that a real PDF rendering engine actually interprets
 * byte 0x97 as the em-dash glyph. A future jsPDF upgrade that changed how it
 * declares the font encoding (or fell back to a UTF-16BE byte stream) would
 * keep the unit tests green while shipping garbled "—" glyphs to real users.
 *
 * This module closes that gap. It:
 *   1. Generates a real jsPDF document whose text is routed through the actual
 *      `sanitizePdfText` guard (em-dash, en-dash, ellipsis, bullet, curly
 *      quotes, euro, trademark, dagger).
 *   2. Re-opens the generated PDF bytes with pdf.js — the same engine Firefox
 *      ships as its built-in PDF viewer — and extracts the rendered text. pdf.js
 *      maps each painted glyph back to Unicode through the font's WinAnsi
 *      encoding, so the recovered string is exactly what a real viewer displays.
 *   3. Confirms every remapped punctuation mark round-trips to its correct
 *      Unicode code point (not "?" and not a garbled UTF-16BE run), and that a
 *      genuinely-unsupported character (the "↳" hop-indent marker, U+21B3) still
 *      degrades to a clean "?" while a neighbouring em-dash survives.
 *
 * It is designed to run in two places, mirroring the Proof-of-Funds browser
 * guard:
 *   - A Node vitest (`pdfGlyphBrowserCheck.test.ts`) for deterministic CI
 *     coverage of the generate -> parse -> round-trip pipeline.
 *   - A REAL headless Chromium (`scripts/check-pdf-glyph-browser.mjs`) that
 *     loads the Vite-bundled module so the check exercises the same jsPDF +
 *     pdf.js code path real users get in the browser.
 *
 * The helper is written to be browser-safe (Uint8Array only, never the Node
 * `Buffer` global) so it can run unmodified in the browser bundle.
 */

import { sanitizePdfText } from './pdfText';

/** One remapped punctuation mark we expect a real PDF viewer to paint correctly. */
interface GlyphExpectation {
  /** The original Unicode character a user might type (before sanitizing). */
  char: string;
  /** Human-readable name for diagnostics. */
  name: string;
}

/**
 * The WinAnsi high-range punctuation that matters most for KYUTXO exports.
 * Each of these is above the Latin-1 cutoff (U+00FF) yet present in the
 * Windows-1252 0x80-0x9F range, so `sanitizePdfText` remaps it to a single byte
 * that jsPDF's WinAnsi Helvetica can paint. A real viewer must recover the
 * original code point.
 */
const GLYPHS: GlyphExpectation[] = [
  { char: '\u2014', name: 'em dash' },
  { char: '\u2013', name: 'en dash' },
  { char: '\u2026', name: 'horizontal ellipsis' },
  { char: '\u2022', name: 'bullet' },
  { char: '\u2018', name: 'left single quote' },
  { char: '\u2019', name: 'right single quote' },
  { char: '\u201C', name: 'left double quote' },
  { char: '\u201D', name: 'right double quote' },
  { char: '\u20AC', name: 'euro sign' },
  { char: '\u2122', name: 'trade mark sign' },
  { char: '\u2020', name: 'dagger' },
];

/** A character with no WinAnsi byte — must degrade to "?", never garble. */
const UNSUPPORTED_CHAR = '\u21B3'; // ↳ hop-indent marker
const REPLACEMENT = '?';

export interface PdfGlyphCheckStep {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PdfGlyphCheckReport {
  ok: boolean;
  /** True when running in a real browser (window + document present). */
  isBrowser: boolean;
  /** The text a real PDF engine recovered from the generated PDF. */
  extracted: string;
  steps: PdfGlyphCheckStep[];
}

/**
 * Dynamically load pdf.js. pdf.js is only our verification oracle here (a
 * real, production-grade PDF engine — the same one Firefox ships), so the build
 * flavor is a harness detail, not part of what we are testing: the default and
 * legacy builds parse the WinAnsi byte stream identically.
 *
 * We feature-detect at runtime: pdfjs-dist's *default* build (and the Web
 * Worker it spawns) relies on `Promise.try` (Chrome 128+ / Node 23+). Real
 * KYUTXO users run a modern Electron Chromium that has it, so when the engine
 * supports `Promise.try` natively we load the default build with its real
 * worker — the exact production configuration. On an older engine (e.g. a
 * Nix-pinned test Chromium predating v128, or Node under vitest) we fall back
 * to the *legacy* build, which is transpiled for older engines. The detection
 * must be native support — the check harness must not shim `Promise.try` on
 * the page, because init-script shims never reach the spawned Web Worker and
 * the default build's worker would crash there.
 *
 * In Node (vitest) we always use the legacy build: the default build requires
 * browser globals (e.g. DOMMatrix) that Node lacks, regardless of Node's own
 * `Promise.try` support. pdf.js ships an in-process fake worker there, so no
 * `workerSrc` is needed. In the browser pdf.js requires an explicit worker, so
 * we point it at the matching worker asset (Vite resolves the `?url` import).
 */
async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  const isBrowser =
    typeof window !== 'undefined' && typeof document !== 'undefined';
  const hasPromiseTry =
    typeof (Promise as { try?: unknown }).try === 'function';
  // Default build is browser-only: it needs browser globals (e.g. DOMMatrix)
  // that Node lacks, and pdf.js itself warns to use the legacy build in Node.
  const useDefaultBuild = isBrowser && hasPromiseTry;

  const pdfjs = (await (useDefaultBuild
    ? import('pdfjs-dist' as string)
    : import('pdfjs-dist/legacy/build/pdf.mjs' as string))) as typeof import('pdfjs-dist');

  if (isBrowser) {
    const workerUrl = (
      await (useDefaultBuild
        ? import('pdfjs-dist/build/pdf.worker.min.mjs?url' as string)
        : import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url' as string))
    ).default as string;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjs;
}

/** Build a one-line PDF for `text` and return its bytes as a Uint8Array. */
async function renderPdfBytes(text: string): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  doc.setFont('helvetica', 'normal');
  doc.text(sanitizePdfText(text), 10, 20);
  const ab = doc.output('arraybuffer') as ArrayBuffer;
  return new Uint8Array(ab);
}

/** Open `bytes` with pdf.js and return the rendered text of page 1. */
async function extractRenderedText(
  pdfjs: typeof import('pdfjs-dist'),
  bytes: Uint8Array,
): Promise<string> {
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    // getTextContent never paints to canvas, so font/eval helpers are unused.
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    return content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}

/**
 * Run the PDF-glyph real-viewer regression check.
 *
 * Returns a structured report and, by default, throws if any step fails so the
 * caller (vitest or the browser runner) surfaces a hard failure. Pass
 * `{ throwOnFailure: false }` to inspect the report without throwing.
 */
export async function runPdfGlyphBrowserCheck(
  opts: { throwOnFailure?: boolean } = {},
): Promise<PdfGlyphCheckReport> {
  const { throwOnFailure = true } = opts;
  const steps: PdfGlyphCheckStep[] = [];
  const isBrowser =
    typeof window !== 'undefined' && typeof document !== 'undefined';

  const pdfjs = await loadPdfjs();

  // Positive case: every remapped punctuation mark, separated by spaces so the
  // viewer keeps them as distinct runs.
  const positiveInput = GLYPHS.map((g) => g.char).join(' ');
  const positiveBytes = await renderPdfBytes(positiveInput);
  const extracted = await extractRenderedText(pdfjs, positiveBytes);

  for (const glyph of GLYPHS) {
    const passed = extracted.includes(glyph.char);
    steps.push({
      name: `viewer renders the ${glyph.name} (U+${glyph.char
        .charCodeAt(0)
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')})`,
      passed,
      detail: passed
        ? 'recovered the correct glyph from the rendered PDF'
        : `expected the rendered PDF to contain "${glyph.char}", but it was missing. ` +
          `Extracted text: ${JSON.stringify(extracted)}`,
    });
  }

  // The positive line carries no unsupported characters, so a real viewer must
  // not paint a single "?" — its presence would mean the sanitizer mangled a
  // glyph it was supposed to preserve.
  {
    const passed = !extracted.includes(REPLACEMENT);
    steps.push({
      name: 'no remapped punctuation degraded to "?"',
      passed,
      detail: passed
        ? 'the rendered PDF contained no replacement characters'
        : `the rendered PDF contained an unexpected "?" — a preserved glyph was lost. ` +
          `Extracted text: ${JSON.stringify(extracted)}`,
    });
  }

  // No garbled UTF-16BE / control-character runs: every recovered character is
  // either ASCII/Latin-1 or one of the expected remapped glyphs.
  {
    const allowed = new Set(GLYPHS.map((g) => g.char));
    const stray = [...extracted].find(
      (c) => c.charCodeAt(0) > 0x7e && !allowed.has(c),
    );
    const passed = stray === undefined;
    steps.push({
      name: 'no garbled / unexpected high characters in the rendered text',
      passed,
      detail: passed
        ? 'every recovered character was ASCII or an expected glyph'
        : `found an unexpected character U+${(stray as string)
            .charCodeAt(0)
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')} in the rendered PDF (likely a UTF-16BE garble). ` +
          `Extracted text: ${JSON.stringify(extracted)}`,
    });
  }

  // Negative control: an unsupported character degrades to a clean "?" while a
  // neighbouring em-dash still survives. This proves "?" appears only for
  // genuinely-unrenderable characters, not for the remapped punctuation.
  {
    const controlInput = `A\u2014${UNSUPPORTED_CHAR}B`; // A — ↳ B
    const controlBytes = await renderPdfBytes(controlInput);
    const controlText = await extractRenderedText(pdfjs, controlBytes);
    const passed =
      controlText.includes('\u2014') &&
      controlText.includes(REPLACEMENT) &&
      !controlText.includes(UNSUPPORTED_CHAR);
    steps.push({
      name: 'unsupported character degrades to "?" while the em-dash survives',
      passed,
      detail: passed
        ? 'the viewer rendered "—" and a clean "?" for the unsupported marker'
        : `expected "—" + "?" and no raw "↳", got ${JSON.stringify(controlText)}`,
    });
  }

  const ok = steps.every((s) => s.passed);
  const report: PdfGlyphCheckReport = { ok, isBrowser, extracted, steps };

  if (!ok && throwOnFailure) {
    const failures = steps
      .filter((s) => !s.passed)
      .map((s) => `  - ${s.name}: ${s.detail}`)
      .join('\n');
    throw new Error(
      `PDF glyph browser check FAILED (isBrowser=${isBrowser}):\n${failures}`,
    );
  }

  return report;
}
