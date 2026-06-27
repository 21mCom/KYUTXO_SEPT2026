// @vitest-environment jsdom
//
// Parity coverage for ENTITY_* source citations across the two report exports.
// The same per-entity citations (name, category, address, source) are surfaced
// in two places and must never drift apart:
//   - the Print/PDF HTML export (buildPrintableReport renderCitations), and
//   - the plain-text export (buildPrivacyTextReport "Source Citations:" block).
//
// Both renderers pull their rows from the SAME extractCitations helper, so this
// test feeds one ENTITY_* finding through both exporters and asserts the emitted
// citation rows match cell-for-cell. The exporters are left REAL so the
// comparison is against production output, not a copy.
//
// The fixture deliberately covers both the with-sourceNote and without-sourceNote
// branches: HTML renders a missing source as an em dash ("—") while the text
// export omits the "Source:" line entirely. It also confirms a sourceNote that
// contains a URL is emitted verbatim as plain text (offline-first — never linked
// or fetched).

import { describe, it, expect } from 'vitest';
import { buildPrivacyTextReport } from '../privacy-report-export';
import { buildPrintableReport } from '../privacy-report-html';
import type { PrivacyAuditResult, PrivacyFinding } from '../privacy-audit';

// One ENTITY_* finding carrying two citations:
//   - the first has a sourceNote that embeds a URL,
//   - the second has NO sourceNote (the "—" / omitted-Source branch).
const ENTITY_FINDING: PrivacyFinding = {
  type: 'ENTITY_SCAM',
  severity: 'CRITICAL',
  description: 'A transaction interacts with known counterparties.',
  correction: 'Avoid reusing funds linked to these counterparties.',
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
      {
        name: 'WalletExplorer cluster (no public source note)',
        address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        categoryLabel: 'Exchange',
        // No sourceNote on purpose — exercises the missing-source branch.
      },
    ],
  },
} as unknown as PrivacyFinding;

function makeResult(): PrivacyAuditResult {
  return {
    findings: [ENTITY_FINDING],
    warnings: [],
    transactionsAnalyzed: 10,
    addressesScanned: 5,
    isClean: false,
    score: 72,
    grade: 'C+',
    scoreWaterfall: [],
    needsResync: false,
    fingerprintCoverage: 1,
  } as PrivacyAuditResult;
}

const SCOPE = { owner: null, wallet: null };
const FIXED_NOW = new Date('2026-06-26T12:00:00Z');
const FIXED_TEXT_NOW = 'Jun 26, 2026, 12:00:00 PM';

interface CitationRow {
  name: string;
  category: string;
  address: string;
  // null means the surface emitted no source value at all (text omits the line);
  // the HTML em-dash placeholder is normalised to null too so both compare equal.
  source: string | null;
}

/** Pull citation rows out of the printable HTML export's citations table. */
function readHtmlCitations(html: string): CitationRow[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = Array.from(
    doc.querySelectorAll<HTMLElement>('.citations-table tbody tr'),
  );
  return rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll('td'));
    const source = cells[3].textContent!.trim();
    return {
      name: cells[0].textContent!.trim(),
      category: cells[1].textContent!.trim(),
      address: cells[2].textContent!.trim(),
      source: source === '—' ? null : source,
    };
  });
}

/** Parse the "Source Citations:" block out of the plain-text export. */
function readTextCitations(text: string): CitationRow[] {
  const lines = text.split('\n');
  const start = lines.indexOf('   Source Citations:');
  expect(start).toBeGreaterThanOrEqual(0);
  const rows: CitationRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Each citation begins with "     - <name> (<category>)". The block ends at
    // the trailing blank line the builder appends after the finding.
    const head = line.match(/^ {5}- (.+) \((.+)\)$/);
    if (!head) {
      if (line.trim() === '') break;
      continue;
    }
    const addressLine = lines[i + 1] ?? '';
    const addrMatch = addressLine.match(/^ {7}Address: (.+)$/);
    expect(addrMatch).not.toBeNull();
    // The "Source:" line is optional — present only when the citation has a
    // sourceNote. Peek at the line after the address.
    const maybeSourceLine = lines[i + 2] ?? '';
    const sourceMatch = maybeSourceLine.match(/^ {7}Source: (.+)$/);
    rows.push({
      name: head[1],
      category: head[2],
      address: addrMatch![1],
      source: sourceMatch ? sourceMatch[1] : null,
    });
    i += sourceMatch ? 2 : 1;
  }
  return rows;
}

describe('ENTITY_* citation parity — HTML vs. text exports', () => {
  it('emits the same citation rows (name/category/address/source) on both surfaces', () => {
    const html = readHtmlCitations(buildPrintableReport(makeResult(), SCOPE, FIXED_NOW));
    const text = readTextCitations(
      buildPrivacyTextReport(makeResult(), SCOPE, FIXED_TEXT_NOW),
    );

    // Both surfaces produced one row per citation in the finding.
    expect(html).toHaveLength(2);
    expect(text).toHaveLength(2);

    // The two renderings agree cell-for-cell.
    expect(text).toEqual(html);

    // And both match the source citations exactly as authored.
    expect(html).toEqual([
      {
        name: 'Lazarus Group (DPRK, OFAC-sanctioned)',
        category: 'Scam / Fraud',
        address: '134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak',
        source:
          'OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions',
      },
      {
        name: 'WalletExplorer cluster (no public source note)',
        category: 'Exchange',
        address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        source: null,
      },
    ]);
  });

  it('represents a missing sourceNote as "—" in HTML and an omitted line in text', () => {
    const htmlStr = buildPrintableReport(makeResult(), SCOPE, FIXED_NOW);
    const textStr = buildPrivacyTextReport(makeResult(), SCOPE, FIXED_TEXT_NOW);

    // HTML renders the empty-source cell as an em dash placeholder.
    const htmlRows = readHtmlCitations(htmlStr);
    expect(htmlRows[1].source).toBeNull(); // normalised from "—"
    expect(htmlStr).toContain('<td>—</td>');

    // The text export emits exactly one "Source:" line — only the cited entity
    // with a sourceNote gets one; the no-source entity omits it entirely.
    expect(textStr.match(/^ {7}Source: /gm) ?? []).toHaveLength(1);
  });

  it('passes citation sourceNote URLs through as plain text on both surfaces', () => {
    const url = 'https://www.treasury.gov/resource-center/sanctions';
    const htmlStr = buildPrintableReport(makeResult(), SCOPE, FIXED_NOW);
    const textStr = buildPrivacyTextReport(makeResult(), SCOPE, FIXED_TEXT_NOW);

    // The URL appears verbatim and is never wrapped in an anchor (offline-first).
    expect(htmlStr).toContain(url);
    expect(htmlStr).not.toContain(`href="${url}"`);
    expect(htmlStr).not.toContain(`<a href`);
    expect(textStr).toContain(url);
  });
});
