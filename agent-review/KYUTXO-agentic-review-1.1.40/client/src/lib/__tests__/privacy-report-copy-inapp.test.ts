// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildPrivacyTextReport,
  copyPrivacyReportText,
} from '../privacy-report-export';
import type { PrivacyAuditResult, PrivacyFinding } from '../privacy-audit';

// ── Fixtures ────────────────────────────────────────────────────────────────
// A deterministic audit result. The same object produces the plain-text report
// the in-app "Copy" button writes to the clipboard — so the test proves
// copyPrivacyReportText copies the EXACT buildPrivacyTextReport output.
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

describe('in-app Privacy report copy (copyPrivacyReportText)', () => {
  const originalClipboard = navigator.clipboard;
  let toast: ReturnType<typeof vi.fn>;
  let expectedText: string;

  beforeEach(() => {
    toast = vi.fn();
    expectedText = buildPrivacyTextReport(makeResult(), SCOPE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  function setClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', {
      value,
      configurable: true,
      writable: true,
    });
  }

  describe('success path', () => {
    it('writes the exact buildPrivacyTextReport text to navigator.clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      setClipboard({ writeText });

      const outcome = await copyPrivacyReportText(expectedText, toast);

      expect(outcome).toBe('copied');
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(expectedText);
    });

    it('shows a non-destructive success toast', async () => {
      setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });

      await copyPrivacyReportText(expectedText, toast);

      expect(toast).toHaveBeenCalledTimes(1);
      const arg = toast.mock.calls[0][0];
      expect(arg.title).toBe('Copied to Clipboard');
      expect(arg.description).toBe('The Privacy Audit report is ready to paste.');
      expect(arg.variant).toBeUndefined();
    });
  });

  describe('clipboard unavailable path', () => {
    it('shows a destructive "Clipboard Unavailable" toast and does not write', async () => {
      // No async Clipboard API at all.
      setClipboard(undefined);

      const outcome = await copyPrivacyReportText(expectedText, toast);

      expect(outcome).toBe('unavailable');
      expect(toast).toHaveBeenCalledTimes(1);
      const arg = toast.mock.calls[0][0];
      expect(arg.variant).toBe('destructive');
      expect(arg.title).toBe('Clipboard Unavailable');
      expect(arg.description).toContain('Use Export Text');
    });

    it('treats a clipboard object missing writeText as unavailable', async () => {
      // Clipboard present, but writeText is absent (e.g. insecure context).
      setClipboard({});

      const outcome = await copyPrivacyReportText(expectedText, toast);

      expect(outcome).toBe('unavailable');
      expect(toast.mock.calls[0][0].title).toBe('Clipboard Unavailable');
    });
  });

  describe('write rejects path', () => {
    it('shows a destructive "Copy Failed" toast when writeText rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      setClipboard({ writeText });

      const outcome = await copyPrivacyReportText(expectedText, toast);

      expect(outcome).toBe('failed');
      expect(writeText).toHaveBeenCalledWith(expectedText);
      expect(toast).toHaveBeenCalledTimes(1);
      const arg = toast.mock.calls[0][0];
      expect(arg.variant).toBe('destructive');
      expect(arg.title).toBe('Copy Failed');
      expect(arg.description).toContain('Use Export Text');
    });
  });
});
