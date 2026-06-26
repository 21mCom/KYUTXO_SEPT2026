import { describe, it, expect } from 'vitest';
import { buildPrivacyTextReport } from '../privacy-report-export';
import type {
  PrivacyAuditResult,
  PrivacyFinding,
} from '../privacy-audit';

// ── Fixtures ────────────────────────────────────────────────────────────────
// A hand-built audit result so the plain-text assembly is exercised with
// deterministic inputs. buildPrivacyTextReport is the SAME function the
// Reports.tsx Export Text / Copy actions call — these tests guard the real
// production text report, not a copy. If a refactor drops a section (header,
// summary, severity counts, findings list, footer) or mis-formats a value, the
// assertions below catch it.

// An ENTITY_* finding carries a citations array in `details`; the builder
// renders a "Source Citations" block for it.
const ENTITY_FINDING: PrivacyFinding = {
  type: 'ENTITY_SCAM',
  severity: 'CRITICAL',
  description: 'A transaction interacts with a known scam address.',
  correction: 'Avoid reusing funds linked to this counterparty.',
  txids: ['tx_scam'],
  addresses: ['134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak'],
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

// A non-entity warning — renders without a citations block.
const FINGERPRINT_WARNING: PrivacyFinding = {
  type: 'FINGERPRINT_NVERSION',
  severity: 'LOW',
  description: 'Transaction uses a non-default nVersion.',
  correction: 'Use a wallet with standard transaction construction.',
  txids: ['tx_fp'],
  addresses: [],
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

const FIXED_NOW = 'Jun 26, 2026, 12:00:00 PM';

describe('plain-text report — sections present', () => {
  it('renders the header block (title banner, generated time, offline note, scope)', () => {
    const text = buildPrivacyTextReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(text).toContain('PRIVACY AUDIT REPORT');
    expect(text).toContain('='.repeat(60));
    expect(text).toContain(`Generated: ${FIXED_NOW}`);
    expect(text).toContain('All analysis ran fully offline.');
    expect(text).toContain('Owner: All');
    expect(text).toContain('Wallet: All');
  });

  it('renders the scope line from the chosen owner/wallet', () => {
    const text = buildPrivacyTextReport(
      makeResult(),
      { owner: 'Alice', wallet: 'Cold Storage' },
      FIXED_NOW,
    );
    expect(text).toContain('Owner: Alice');
    expect(text).toContain('Wallet: Cold Storage');
  });

  it('renders the summary block with grade, score, txs and addresses', () => {
    const text = buildPrivacyTextReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(text).toContain('Grade: C+');
    expect(text).toContain('Score: 72/100');
    // Locale-formatted with a thousands separator.
    expect(text).toContain('Transactions Analyzed: 1,234');
    expect(text).toContain('Addresses Scanned: 56');
  });

  it('omits the fingerprint-coverage line when no re-sync is needed', () => {
    const text = buildPrivacyTextReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);
    expect(text).not.toContain('Fingerprint Coverage');
  });

  it('shows the fingerprint-coverage / re-sync line when coverage is incomplete', () => {
    const text = buildPrivacyTextReport(
      makeResult({ needsResync: true, fingerprintCoverage: 0.42 }),
      { owner: null, wallet: null },
      FIXED_NOW,
    );
    expect(text).toContain('Fingerprint Coverage: 42% — re-sync recommended for complete results.');
  });

  it('renders the severity breakdown with a count per present severity', () => {
    const text = buildPrivacyTextReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(text).toContain('SEVERITY BREAKDOWN');
    // One CRITICAL (entity finding) and one LOW (warning).
    expect(text).toContain('Critical: 1');
    expect(text).toContain('Low: 1');
    // Severities with no findings are omitted.
    expect(text).not.toContain('High:');
    expect(text).not.toContain('Medium:');
  });

  it('shows a clean severity breakdown when there are no findings or warnings', () => {
    const text = buildPrivacyTextReport(
      makeResult({ findings: [], warnings: [], isClean: true }),
      { owner: null, wallet: null },
      FIXED_NOW,
    );
    expect(text).toContain('Clean — no privacy findings.');
    expect(text).toContain('No privacy findings — your transaction history is clean.');
  });

  it('renders the findings list with count, label, description, fix and meta', () => {
    const text = buildPrivacyTextReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    // Section header includes the combined finding+warning count.
    expect(text).toContain('FINDINGS & WARNINGS (2)');
    // Numbered entries with friendly labels (from FINDING_TYPE_LABELS).
    expect(text).toContain('1. [Critical] Scam Address Contact');
    expect(text).toContain('2. [Low] Wallet Fingerprint (nVersion)');
    // Descriptions and corrections render.
    expect(text).toContain('A transaction interacts with a known scam address.');
    expect(text).toContain('Fix: Avoid reusing funds linked to this counterparty.');
    // Finding meta counts.
    expect(text).toContain('1 address(es)');
    expect(text).toContain('1 transaction(s)');
  });

  it('renders source citations for ENTITY_* findings only', () => {
    const text = buildPrivacyTextReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(text).toContain('Source Citations:');
    expect(text).toContain('- Lazarus Group (DPRK, OFAC-sanctioned) (Scam / Fraud)');
    expect(text).toContain('Address: 134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak');
    // Citation source URL passes through as plain text, never linked or fetched.
    expect(text).toContain('Source: OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions');
    // The non-entity warning must not produce its own citations block — only one
    // "Source Citations:" header should appear in the whole report.
    expect(text.match(/Source Citations:/g) ?? []).toHaveLength(1);
  });

  it('renders the footer block', () => {
    const text = buildPrivacyTextReport(makeResult(), { owner: null, wallet: null }, FIXED_NOW);

    expect(text).toContain('KYUTXO Privacy Audit · Offline-first compliance artifact.');
    expect(text).toContain('Citation URLs are shown as plain text and are never fetched.');
  });
});
