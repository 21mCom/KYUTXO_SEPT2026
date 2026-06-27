// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildPrivacyTextReport,
  downloadPrivacyTextReport,
  privacyTextReportFilename,
} from '../privacy-report-export';
import type { PrivacyAuditResult, PrivacyFinding } from '../privacy-audit';

// ── Fixtures ────────────────────────────────────────────────────────────────
// A deterministic audit result. The same object produces the plain-text report
// the in-app "Export Text" button downloads — so the test proves
// downloadPrivacyTextReport writes the EXACT buildPrivacyTextReport output.
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

describe('in-app Privacy report Export Text (downloadPrivacyTextReport)', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let anchorClick: ReturnType<typeof vi.fn>;
  let createdAnchor: HTMLAnchorElement | null;
  const FAKE_URL = 'blob:fake-object-url';
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue(FAKE_URL);
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    // jsdom anchors don't perform navigation on click; spy on it anyway so the
    // download trigger doesn't throw and we can assert it fired.
    anchorClick = vi.fn();
    createdAnchor = null;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, opts?: unknown) => {
      const el = originalCreateElement(tag as 'a', opts as ElementCreationOptions);
      if (tag === 'a') {
        createdAnchor = el as HTMLAnchorElement;
        (el as HTMLAnchorElement).click = anchorClick as unknown as () => void;
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('downloads a Blob containing the exact buildPrivacyTextReport output', async () => {
    const expectedText = buildPrivacyTextReport(makeResult(), SCOPE);

    const { blob } = downloadPrivacyTextReport(expectedText);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const passedBlob = createObjectURL.mock.calls[0][0] as Blob;
    expect(passedBlob).toBe(blob);
    expect(passedBlob).toBeInstanceOf(Blob);
    expect(passedBlob.type).toBe('text/plain;charset=utf-8');
    // The blob the user downloads carries the identical report text.
    await expect(passedBlob.text()).resolves.toBe(expectedText);
  });

  it('names the file privacy-audit-report-<YYYY-MM-DD>.txt for the given date', () => {
    const date = new Date('2026-06-27T12:34:56Z');
    const { filename } = downloadPrivacyTextReport('report body', date);

    expect(filename).toBe('privacy-audit-report-2026-06-27.txt');
    expect(privacyTextReportFilename(date)).toBe(filename);
    // The triggered anchor advertises the same download filename + object URL.
    expect(createdAnchor).not.toBeNull();
    expect(createdAnchor!.download).toBe('privacy-audit-report-2026-06-27.txt');
    expect(createdAnchor!.getAttribute('href')).toBe(FAKE_URL);
  });

  it('defaults the filename to today when no date is provided', () => {
    const today = new Date().toISOString().slice(0, 10);
    const { filename } = downloadPrivacyTextReport('report body');
    expect(filename).toBe(`privacy-audit-report-${today}.txt`);
  });

  it('creates the object URL, clicks the anchor, then revokes the URL', () => {
    downloadPrivacyTextReport('report body');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    // The exact URL handed out by createObjectURL is the one revoked.
    expect(revokeObjectURL).toHaveBeenCalledWith(FAKE_URL);
  });
});
