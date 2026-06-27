import { describe, it, expect } from 'vitest';
import { buildPrintableReport } from '../privacy-report-html';
import type {
  PrivacyAuditResult,
  PrivacyFinding,
} from '../privacy-audit';

// ── Fixtures ────────────────────────────────────────────────────────────────
// A hand-built audit result so the HTML assembly is exercised with deterministic
// inputs. The HTML builder (buildPrintableReport) is the SAME function the
// Reports.tsx print action calls — these tests guard the real production HTML,
// not a copy. If a refactor drops a section or mis-renders a value, the
// assertions below catch it.

// An ENTITY_* finding carries a citations array in `details`; the builder
// renders a "Source Citations" table for it.
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
        sourceNote:
          'OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions',
      },
    ],
  },
} as unknown as PrivacyFinding;

// A non-entity warning — renders without a citations table.
const FINGERPRINT_WARNING: PrivacyFinding = {
  type: 'FINGERPRINT_NVERSION',
  severity: 'LOW',
  description: 'Transaction uses a non-default nVersion.',
  correction: 'Use a wallet with standard transaction construction.',
  txids: ['tx_fp'],
  addresses: [],
  scoreDelta: -0.4,
  details: {},
} as unknown as PrivacyFinding;

function makeResult(overrides: Partial<PrivacyAuditResult> = {}): PrivacyAuditResult {
  return {
    findings: [ENTITY_FINDING],
    warnings: [FINGERPRINT_WARNING],
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
    ...overrides,
  } as PrivacyAuditResult;
}

const FIXED_NOW = new Date('2026-06-26T12:00:00Z');

describe('printable HTML report — sections present', () => {
  it('renders the document scaffold (doctype, title, subtitle, footer)', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Privacy Audit Report — 2026-06-26</title>');
    expect(html).toContain('<h1>Privacy Audit Report</h1>');
    expect(html).toContain('All analysis ran fully offline.');
    expect(html).toContain('KYUTXO Privacy Audit');
    expect(html).toContain('never fetched');
  });

  it('renders the summary boxes with grade, score, txs analyzed and addresses', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    // Grade box.
    expect(html).toContain('<div class="value">C+</div><div class="label">Grade</div>');
    // Score box (score/100).
    expect(html).toContain('<div class="value">72/100</div><div class="label">Score</div>');
    // Txs analyzed — locale-formatted with a thousands separator.
    expect(html).toContain('<div class="value">1,234</div><div class="label">Txs Analyzed</div>');
    // Addresses.
    expect(html).toContain('<div class="value">56</div><div class="label">Addresses</div>');
  });

  it('renders the scope line from the chosen owner/wallet', () => {
    const html = buildPrintableReport(
      makeResult(),
      { owner: 'Alice', wallet: 'Cold Storage' },
      FIXED_NOW,
    );
    expect(html).toContain('Owner: Alice · Wallet: Cold Storage');
  });

  it('falls back to "All" in the scope line when owner/wallet are null', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);
    expect(html).toContain('Owner: All · Wallet: All');
  });

  it('renders the severity summary chips for findings present', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);
    expect(html).toContain('<strong>Issues:</strong>');
    // One CRITICAL (entity) and one LOW (warning).
    expect(html).toContain('1 Critical');
    expect(html).toContain('1 Low');
  });

  it('renders a "Clean" chip when there are no findings or warnings', () => {
    const html = buildPrintableReport(
      makeResult({ findings: [], warnings: [], isClean: true }),
      { owner: null, wallet: null },
      FIXED_NOW,
    );
    expect(html).toContain('>Clean<');
    expect(html).toContain('No privacy findings');
    expect(html).not.toContain('<strong>Issues:</strong>');
  });

  it('renders the score waterfall table with a row per entry', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(html).toContain('<h2>Score Breakdown</h2>');
    expect(html).toContain('<table class="waterfall-table">');
    // Each waterfall label appears as a row.
    expect(html).toContain('<td>Base Score</td>');
    expect(html).toContain('<td>Known Scam</td>');
    // Negative delta is rendered with the delta-neg class and a minus sign.
    expect(html).toContain('delta-neg">-28');
    // Running scores are rendered.
    expect(html).toContain('<td class="num">100</td>');
    expect(html).toContain('<td class="num">72</td>');
  });

  it('enumerates each individual finding as a nested row under its category', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    // A nested finding row is emitted beneath the aggregated category.
    expect(html).toContain('class="waterfall-finding-row"');
    // It carries the per-finding address/tx locator (escaped, in the mono cell)...
    expect(html).toContain(
      'addr 134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak  ·  tx tx_scam',
    );
    // ...and the per-finding score impact in its own cell.
    expect(html).toContain('class="num wf-finding-impact">-28 pts</td>');
  });

  it('shows an em dash for a nested finding with no score impact', () => {
    const html = buildPrintableReport(
      makeResult({
        findings: [
          { ...ENTITY_FINDING, scoreDelta: undefined } as unknown as PrivacyFinding,
        ],
        warnings: [],
      }),
      { owner: null, wallet: null },
      FIXED_NOW,
    );
    expect(html).toContain('class="waterfall-finding-row"');
    expect(html).toContain('class="num wf-finding-impact">—</td>');
  });

  it('omits the waterfall table when the result has no waterfall entries', () => {
    const html = buildPrintableReport(
      makeResult({ scoreWaterfall: [] }),
      { owner: null, wallet: null },
      FIXED_NOW,
    );
    expect(html).not.toContain('Score Breakdown');
    // The CSS still declares the .waterfall-table class, but no table element
    // (with its <thead> header row) should be emitted.
    expect(html).not.toContain('<table class="waterfall-table">');
  });

  it('renders the findings section with the human-readable label and fix text', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    // Section header includes the combined finding+warning count.
    expect(html).toContain('Findings &amp; Warnings (2)');
    // Friendly finding labels (from FINDING_TYPE_LABELS), not the raw type.
    expect(html).not.toContain('ENTITY_SCAM</span>');
    expect(html).not.toContain('FINGERPRINT_NVERSION</span>');
    // Descriptions and corrections render.
    expect(html).toContain('A transaction interacts with a known scam address.');
    expect(html).toContain('<strong>Fix:</strong> Avoid reusing funds linked to this counterparty.');
    // Finding meta counts.
    expect(html).toContain('1 address(es)');
    expect(html).toContain('1 transaction(s)');
  });

  it('renders each finding\'s score impact (matching the in-app per-finding penalty)', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    // The scam finding's -28 penalty renders as a rounded "-28 pts" chip.
    expect(html).toContain('<span class="finding-score">-28 pts</span>');
    // A sub-1-point penalty (the fingerprint warning's -0.4) renders as "<-1 pts",
    // escaped so the leading "<" cannot break out of the markup.
    expect(html).toContain('<span class="finding-score">&lt;-1 pts</span>');
  });

  it('omits the score-impact chip for findings without a penalty', () => {
    const html = buildPrintableReport(
      makeResult({
        findings: [{ ...ENTITY_FINDING, scoreDelta: undefined } as unknown as PrivacyFinding],
        warnings: [],
      }),
      { owner: null, wallet: null },
      FIXED_NOW,
    );
    expect(html).not.toContain('class="finding-score"');
  });

  it('renders a source citations table for ENTITY_* findings only', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(html).toContain('Source Citations');
    expect(html).toContain('Lazarus Group (DPRK, OFAC-sanctioned)');
    expect(html).toContain('Scam / Fraud');
    // Citation source URL passes through as plain text, never linked or fetched.
    expect(html).toContain('https://www.treasury.gov/resource-center/sanctions');
  });

  it('shows a re-sync notice when fingerprint coverage is incomplete', () => {
    const html = buildPrintableReport(
      makeResult({ needsResync: true, fingerprintCoverage: 0.42 }),
      { owner: null, wallet: null },
      FIXED_NOW,
    );
    expect(html).toContain('Fingerprint data 42%');
    expect(html).toContain('re-sync recommended');
  });

  it('renders a screen-only Copy control (hidden from the printed page)', () => {
    const html = buildPrintableReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    // The copy button and its status target are present for the print/PDF window
    // (wired up by Reports.tsx after document.write).
    expect(html).toContain('id="copy-report-btn"');
    expect(html).toContain('id="copy-report-status"');
    expect(html).toContain('Copy report text');
    // The toolbar is marked no-print so it never appears in the saved PDF.
    expect(html).toContain('class="toolbar no-print"');
    expect(html).toContain('.no-print { display: none !important; }');
  });
});

describe('printable HTML report — escaping of user-controlled values', () => {
  it('escapes owner and wallet names', () => {
    const html = buildPrintableReport(
      makeResult(),
      { owner: '<script>alert(1)</script>', wallet: 'A & B "Co"' },
      FIXED_NOW,
    );
    expect(html).toContain('Owner: &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Wallet: A &amp; B &quot;Co&quot;');
    // The raw script tag must never appear unescaped in the document.
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes finding description, correction, grade and citation fields', () => {
    const malicious = makeResult({
      grade: 'C<b>',
      findings: [
        {
          type: 'ENTITY_SCAM',
          severity: 'CRITICAL',
          description: 'desc <img src=x onerror=alert(1)>',
          correction: 'fix & <stay safe>',
          txids: ['tx'],
          addresses: ['addr'],
          details: {
            citations: [
              {
                name: 'Evil <b>Corp</b>',
                address: 'addr<script>',
                categoryLabel: 'Scam & "Fraud"',
                sourceNote: 'note <i>here</i>',
              },
            ],
          },
        } as unknown as PrivacyFinding,
      ],
      warnings: [],
    });

    const html = buildPrintableReport(malicious, { owner: null, wallet: null }, FIXED_NOW);

    expect(html).toContain('desc &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('fix &amp; &lt;stay safe&gt;');
    expect(html).toContain('<div class="value">C&lt;b&gt;</div>');
    expect(html).toContain('Evil &lt;b&gt;Corp&lt;/b&gt;');
    expect(html).toContain('addr&lt;script&gt;');
    expect(html).toContain('Scam &amp; &quot;Fraud&quot;');
    expect(html).toContain('note &lt;i&gt;here&lt;/i&gt;');

    // None of the raw payloads survive unescaped.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('Evil <b>Corp</b>');
  });
});
