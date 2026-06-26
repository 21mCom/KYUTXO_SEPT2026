// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildPrintableReport, wireReportCopyButton } from '../privacy-report-html';
import { buildPrivacyTextReport } from '../privacy-report-export';
import type { PrivacyAuditResult, PrivacyFinding } from '../privacy-audit';

// ── Fixtures ────────────────────────────────────────────────────────────────
// A deterministic audit result. The same object feeds both the printable HTML
// (which carries the #copy-report-btn / #copy-report-status markup) and the
// plain-text export the button is expected to write to the clipboard — so the
// test proves the wiring copies the SAME text buildPrivacyTextReport produces.
const ENTITY_FINDING: PrivacyFinding = {
  type: 'ENTITY_SCAM',
  severity: 'CRITICAL',
  description: 'A transaction interacts with a known scam address.',
  correction: 'Avoid reusing funds linked to this counterparty.',
  txids: ['tx_scam'],
  addresses: ['134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak'],
  scoreDelta: -28,
  details: {
    citations: [
      {
        name: 'Lazarus Group (DPRK, OFAC-sanctioned)',
        address: '134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak',
        categoryLabel: 'Scam / Fraud',
        sourceNote: 'OFAC / US Treasury',
      },
    ],
  },
} as unknown as PrivacyFinding;

function makeResult(): PrivacyAuditResult {
  return {
    findings: [ENTITY_FINDING],
    warnings: [],
    transactionsAnalyzed: 1234,
    addressesScanned: 56,
    isClean: false,
    score: 72,
    grade: 'C+',
    scoreWaterfall: [
      { label: 'Base Score', findingType: 'BASE', delta: 0, runningScore: 100, count: 0 },
      { label: 'Known Scam', findingType: 'ENTITY_SCAM', delta: -28, runningScore: 72, count: 1 },
    ],
    needsResync: false,
    fingerprintCoverage: 1,
  } as PrivacyAuditResult;
}

const SCOPE = { owner: null, wallet: null };

/**
 * Render the printable report into the current jsdom document (as exportPdf
 * does via document.write) and wire the copy button against it. Returns the
 * expected report text so each test can assert the clipboard receives it.
 */
function setupWiredDocument(): { expectedText: string } {
  const result = makeResult();
  const html = buildPrintableReport(result, SCOPE);
  // jsdom's document.write replaces the whole document, mirroring exportPdf.
  document.open();
  document.write(html);
  document.close();

  const expectedText = buildPrivacyTextReport(result, SCOPE);
  wireReportCopyButton(window, expectedText);
  return { expectedText };
}

function clickCopy(): HTMLElement {
  const btn = document.getElementById('copy-report-btn');
  expect(btn).not.toBeNull();
  btn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return btn as HTMLElement;
}

function status(): HTMLElement {
  const el = document.getElementById('copy-report-status');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('print/PDF report copy button wiring', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore the clipboard descriptor we may have overridden per-test.
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  describe('async Clipboard API path', () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
        writable: true,
      });
    });

    it('writes the exact buildPrivacyTextReport plain text to the clipboard', async () => {
      const { expectedText } = setupWiredDocument();
      clickCopy();
      // The handler is async; let its awaited writeText settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(expectedText);
    });

    it('confirms success in #copy-report-status', async () => {
      setupWiredDocument();
      clickCopy();
      await Promise.resolve();
      await Promise.resolve();

      expect(status().textContent).toBe('Copied to clipboard.');
      expect(status().style.color).toBe('rgb(22, 163, 74)'); // #16a34a
    });

    it('does NOT fall back to execCommand when the Clipboard API succeeds', async () => {
      const execCommand = vi.fn().mockReturnValue(true);
      // jsdom doesn't implement execCommand by default; install a spy.
      (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

      setupWiredDocument();
      clickCopy();
      await Promise.resolve();
      await Promise.resolve();

      expect(execCommand).not.toHaveBeenCalled();
    });
  });

  describe('execCommand fallback path (clipboard unavailable)', () => {
    beforeEach(() => {
      // Simulate an environment with no async Clipboard API.
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    it('copies via a temporary textarea + execCommand and confirms success', async () => {
      let copiedValue: string | null = null;
      const execCommand = vi.fn((command: string) => {
        if (command === 'copy') {
          const active = document.activeElement as HTMLTextAreaElement | null;
          copiedValue = active?.value ?? null;
        }
        return true;
      });
      (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

      const { expectedText } = setupWiredDocument();
      clickCopy();
      await Promise.resolve();
      await Promise.resolve();

      expect(execCommand).toHaveBeenCalledWith('copy');
      // The textarea selected at copy time carried the exact report text.
      expect(copiedValue).toBe(expectedText);
      // The temporary textarea is cleaned up after copying.
      expect(document.querySelector('textarea')).toBeNull();

      expect(status().textContent).toBe('Copied to clipboard.');
      expect(status().style.color).toBe('rgb(22, 163, 74)'); // #16a34a
    });

    it('reports a failure message when execCommand returns false', async () => {
      const execCommand = vi.fn().mockReturnValue(false);
      (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

      setupWiredDocument();
      clickCopy();
      await Promise.resolve();
      await Promise.resolve();

      expect(status().textContent).toBe(
        'Copy unavailable — select the text and press Ctrl/Cmd+C.',
      );
      expect(status().style.color).toBe('rgb(220, 38, 38)'); // #dc2626
    });
  });

  describe('rejected Clipboard API falls back to execCommand', () => {
    it('uses execCommand when navigator.clipboard.writeText rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
        writable: true,
      });
      const execCommand = vi.fn().mockReturnValue(true);
      (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

      const { expectedText } = setupWiredDocument();
      clickCopy();
      // Let the rejected promise reject and the fallback run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(expectedText);
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(status().textContent).toBe('Copied to clipboard.');
    });
  });
});
