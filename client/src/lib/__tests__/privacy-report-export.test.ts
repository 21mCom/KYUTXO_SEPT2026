import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TransactionParticipant, BlockchainTransaction } from '../db-types';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Two real entries from the curated entity list (client/src/lib/privacy-entity-list.ts)
// so the audit produces genuine ENTITY_* findings with citations carrying the
// real categoryLabel and sourceNote. sourceNote contains a URL — it must pass
// through unchanged (plain text, never fetched).
const EXCHANGE_ENTITY = {
  address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',
  name: 'Binance',
  categoryLabel: 'Exchange',
  sourceNote:
    'Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)',
};
const SCAM_ENTITY = {
  address: '134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak',
  name: 'Lazarus Group (DPRK, OFAC-sanctioned)',
  categoryLabel: 'Scam / Fraud',
  sourceNote:
    'OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx',
};
// A second, distinct exchange entity (different address & name) that shares the
// ENTITY_EXCHANGE finding with Binance — used to prove every distinct entity in
// a category is cited, not just the first.
const COINBASE_ENTITY = {
  address: '3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r',
  name: 'Coinbase (custody)',
  categoryLabel: 'Exchange',
  sourceNote:
    'Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)',
};

const USER_ADDRESS = 'bc1quseraddressxxxxxxxxxxxxxxxxxxxxxxxxqqqq';

// Tx 1: user pays the exchange. Tx 2: user pays the scam address.
// Hoisted so the (hoisted) vi.mock factories below can reference them.
const { ALL_PARTICIPANTS, TX_RECORDS } = vi.hoisted(() => {
  const userAddress = 'bc1quseraddressxxxxxxxxxxxxxxxxxxxxxxxxqqqq';
  const exchangeAddr = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
  const coinbaseAddr = '3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r';
  const scamAddr = '134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak';
  return {
    ALL_PARTICIPANTS: [
      // The exchange address (Binance) appears as an output in TWO separate
      // transactions, so its citation must still be emitted exactly once.
      { txid: 'tx_exchange', role: 'input', address: userAddress, amount: 100000, vout: 0 },
      { txid: 'tx_exchange', role: 'output', address: exchangeAddr, amount: 90000, vout: 0 },
      { txid: 'tx_exchange2', role: 'input', address: userAddress, amount: 70000, vout: 0 },
      { txid: 'tx_exchange2', role: 'output', address: exchangeAddr, amount: 60000, vout: 0 },
      // A second, distinct exchange entity (Coinbase) in the same category.
      { txid: 'tx_coinbase', role: 'input', address: userAddress, amount: 30000, vout: 0 },
      { txid: 'tx_coinbase', role: 'output', address: coinbaseAddr, amount: 25000, vout: 0 },
      { txid: 'tx_scam', role: 'input', address: userAddress, amount: 50000, vout: 0 },
      { txid: 'tx_scam', role: 'output', address: scamAddr, amount: 45000, vout: 0 },
    ] as TransactionParticipant[],
    TX_RECORDS: [
      // nVersion=1 with captured fingerprint data reliably yields a non-entity
      // FINGERPRINT_NVERSION finding, so we can assert citations are omitted on it.
      { txid: 'tx_exchange', blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_100, rawFingerprintCaptured: true, nVersion: 1 },
      { txid: 'tx_exchange2', blockHeight: 800002, blockTime: 1_700_000_400, fee: 1000, feeRate: 5, syncedAt: 1_700_000_500, rawFingerprintCaptured: true, nVersion: 2 },
      { txid: 'tx_coinbase', blockHeight: 800003, blockTime: 1_700_000_600, fee: 1000, feeRate: 5, syncedAt: 1_700_000_700, rawFingerprintCaptured: true, nVersion: 2 },
      { txid: 'tx_scam', blockHeight: 800001, blockTime: 1_700_000_200, fee: 1000, feeRate: 5, syncedAt: 1_700_000_300, rawFingerprintCaptured: true, nVersion: 2 },
    ] as BlockchainTransaction[],
  };
});

vi.mock('../database', () => ({
  db: {
    transactionParticipants: {
      where: () => ({ anyOf: () => ({ toArray: () => Promise.resolve([...ALL_PARTICIPANTS]) }) }),
    },
    blockchainTransactions: {
      where: () => ({ anyOf: () => ({ toArray: () => Promise.resolve([...TX_RECORDS]) }) }),
    },
  },
}));

vi.mock('../data/record-queries', () => ({
  getParticipantsByAddresses: vi.fn(() =>
    Promise.resolve(
      ALL_PARTICIPANTS.filter((p) => p.address === USER_ADDRESS),
    ),
  ),
}));

import { runPrivacyAudit } from '../privacy-audit';
// buildPrivacyReport is the SAME function Reports.tsx (exportJson) uses to
// assemble the export, so these tests guard the real production shape — not a
// copy. If the export adds, drops, or renames a top-level key, summary field,
// or finding field, the assertions below catch it.
import { mapFinding, buildPrivacyReport, buildPrivacyTextReport } from '../privacy-report-export';
import { FINDING_TYPE_LABELS, type PrivacyAuditResult } from '../privacy-audit';
// buildPrintableReport is the SAME function Reports.tsx (exportPdf) feeds into the
// print window, so these tests guard the real printable HTML — not a copy. If the
// HTML drops the header, summary, severity chips, scope, or any per-finding field,
// or stops escaping user-controlled text, the assertions below catch it.
import { buildPrintableReport, escapeHtml, severityLabel } from '../privacy-report-html';

describe('privacy report export — entity citations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes a citations array on every ENTITY_* finding in the exported report', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);

    // Build the exported report the same way Reports.tsx does, then round-trip
    // through JSON so we assert against the actual serialized export shape.
    const exported = JSON.parse(
      JSON.stringify({
        findings: result.findings.map(mapFinding),
        warnings: result.warnings.map(mapFinding),
      }),
    ) as {
      findings: Array<Record<string, unknown>>;
      warnings: Array<Record<string, unknown>>;
    };

    const allExported = [...exported.findings, ...exported.warnings];
    const entityFindings = allExported.filter((f) =>
      String(f.type).startsWith('ENTITY_'),
    );

    // Sanity: the audit actually produced entity findings.
    expect(entityFindings.length).toBeGreaterThanOrEqual(2);

    for (const f of entityFindings) {
      expect(Array.isArray(f.citations)).toBe(true);
      const citations = f.citations as Array<Record<string, unknown>>;
      expect(citations.length).toBeGreaterThan(0);
      for (const c of citations) {
        expect(typeof c.name).toBe('string');
        expect(typeof c.address).toBe('string');
        expect(typeof c.categoryLabel).toBe('string');
        expect(typeof c.sourceNote).toBe('string');
      }
    }
  });

  it('carries the correct citation fields for a specific entity', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const exported = [...result.findings, ...result.warnings].map(mapFinding);

    const scamFinding = exported.find((f) => f.type === 'ENTITY_SCAM');
    expect(scamFinding).toBeDefined();
    const citation = scamFinding!.citations?.find(
      (c) => c.address === SCAM_ENTITY.address,
    );
    expect(citation).toEqual({
      name: SCAM_ENTITY.name,
      address: SCAM_ENTITY.address,
      categoryLabel: SCAM_ENTITY.categoryLabel,
      sourceNote: SCAM_ENTITY.sourceNote,
    });

    const exchangeFinding = exported.find((f) => f.type === 'ENTITY_EXCHANGE');
    expect(exchangeFinding).toBeDefined();
    const exchangeCitation = exchangeFinding!.citations?.find(
      (c) => c.address === EXCHANGE_ENTITY.address,
    );
    expect(exchangeCitation).toEqual({
      name: EXCHANGE_ENTITY.name,
      address: EXCHANGE_ENTITY.address,
      categoryLabel: EXCHANGE_ENTITY.categoryLabel,
      sourceNote: EXCHANGE_ENTITY.sourceNote,
    });
  });

  it('passes citation sourceNote URLs through as plain text, unchanged', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const exported = [...result.findings, ...result.warnings].map(mapFinding);

    const scamCitation = exported
      .find((f) => f.type === 'ENTITY_SCAM')
      ?.citations?.find((c) => c.address === SCAM_ENTITY.address);

    // The exact URL is preserved verbatim — no encoding, escaping, or fetching.
    expect(scamCitation?.sourceNote).toBe(SCAM_ENTITY.sourceNote);
    expect(scamCitation?.sourceNote).toContain('https://www.treasury.gov/');
  });

  it('omits the citations field entirely on non-entity findings', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);

    // Round-trip through JSON: a property whose value is `undefined` is dropped
    // during serialization, so the exported non-entity findings must have no
    // `citations` key at all.
    const exported = JSON.parse(
      JSON.stringify(
        [...result.findings, ...result.warnings].map(mapFinding),
      ),
    ) as Array<Record<string, unknown>>;

    const nonEntityFindings = exported.filter(
      (f) => !String(f.type).startsWith('ENTITY_'),
    );

    // Sanity: there is at least one non-entity finding to check against.
    expect(nonEntityFindings.length).toBeGreaterThan(0);

    for (const f of nonEntityFindings) {
      expect('citations' in f).toBe(false);
    }
  });

  it('cites a repeated entity address only once across multiple transactions', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const exported = [...result.findings, ...result.warnings].map(mapFinding);

    const exchangeFinding = exported.find((f) => f.type === 'ENTITY_EXCHANGE');
    expect(exchangeFinding).toBeDefined();

    // Binance appears as an output in both tx_exchange and tx_exchange2 (and so
    // is flagged across two transactions), but its citation must be deduped by
    // address — listed exactly once, never repeated per transaction.
    const binanceCitations = exchangeFinding!.citations!.filter(
      (c) => c.address === EXCHANGE_ENTITY.address,
    );
    expect(binanceCitations).toHaveLength(1);

    // No citation address may appear more than once in the entire finding.
    const allAddrs = exchangeFinding!.citations!.map((c) => c.address);
    expect(allAddrs.length).toBe(new Set(allAddrs).size);
  });

  it('cites every distinct entity in the same category', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const exported = [...result.findings, ...result.warnings].map(mapFinding);

    const exchangeFinding = exported.find((f) => f.type === 'ENTITY_EXCHANGE');
    expect(exchangeFinding).toBeDefined();

    // Both distinct exchange entities (Binance and Coinbase) must each be cited,
    // proving dedup-by-address does not collapse separate counterparties.
    const citedAddrs = new Set(
      exchangeFinding!.citations!.map((c) => c.address),
    );
    expect(citedAddrs.has(EXCHANGE_ENTITY.address)).toBe(true);
    expect(citedAddrs.has(COINBASE_ENTITY.address)).toBe(true);

    const coinbaseCitation = exchangeFinding!.citations!.find(
      (c) => c.address === COINBASE_ENTITY.address,
    );
    expect(coinbaseCitation).toEqual({
      name: COINBASE_ENTITY.name,
      address: COINBASE_ENTITY.address,
      categoryLabel: COINBASE_ENTITY.categoryLabel,
      sourceNote: COINBASE_ENTITY.sourceNote,
    });
  });
});

describe('privacy report export — full report shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('contains all expected top-level keys after serialization', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, { owner: null, wallet: null })),
    ) as Record<string, unknown>;

    expect(Object.keys(report).sort()).toEqual(
      [
        'findings',
        'generatedAt',
        'scope',
        'scoreWaterfall',
        'summary',
        'warnings',
      ].sort(),
    );
    expect(typeof report.generatedAt).toBe('string');
    expect(Array.isArray(report.scoreWaterfall)).toBe(true);
    expect(Array.isArray(report.findings)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it('carries the scope chosen for the export', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const report = buildPrivacyReport(result, { owner: 'Alice', wallet: 'Cold Storage' });
    expect(report.scope).toEqual({ owner: 'Alice', wallet: 'Cold Storage' });
  });

  it('summary block matches the audit result', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const report = buildPrivacyReport(result, { owner: null, wallet: null });

    expect(report.summary).toEqual({
      score: result.score,
      grade: result.grade,
      transactionsAnalyzed: result.transactionsAnalyzed,
      addressesScanned: result.addressesScanned,
      isClean: result.isClean,
      fingerprintCoverage: result.fingerprintCoverage,
      needsResync: result.needsResync,
      findingsCount: result.findings.length,
      warningsCount: result.warnings.length,
    });
    // Spot-check the coverage flags are genuine booleans/numbers, not undefined.
    expect(typeof report.summary.isClean).toBe('boolean');
    expect(typeof report.summary.needsResync).toBe('boolean');
    expect(typeof report.summary.fingerprintCoverage).toBe('number');
  });

  it('preserves the scoreWaterfall from the audit result', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, { owner: null, wallet: null })),
    ) as { scoreWaterfall: unknown };

    expect(report.scoreWaterfall).toEqual(
      JSON.parse(JSON.stringify(result.scoreWaterfall)),
    );
  });

  it('each mapped finding carries label/severity/description/correction/txids/addresses', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, { owner: null, wallet: null })),
    ) as {
      findings: Array<Record<string, unknown>>;
      warnings: Array<Record<string, unknown>>;
    };

    const allFindings = [...report.findings, ...report.warnings];
    // Sanity: the audit produced findings to assert against.
    expect(allFindings.length).toBeGreaterThan(0);

    for (const f of allFindings) {
      expect(typeof f.type).toBe('string');
      expect(typeof f.label).toBe('string');
      expect((f.label as string).length).toBeGreaterThan(0);
      expect(typeof f.severity).toBe('string');
      expect(typeof f.description).toBe('string');
      expect(typeof f.correction).toBe('string');
      expect(Array.isArray(f.txids)).toBe(true);
      expect(Array.isArray(f.addresses)).toBe(true);
      expect(typeof f.details).toBe('object');
    }
  });

  it('carries the per-finding scoreDelta through to the JSON export', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, { owner: null, wallet: null })),
    ) as {
      findings: Array<Record<string, unknown>>;
      warnings: Array<Record<string, unknown>>;
    };

    // Match the exported findings back to the audit result so we can assert the
    // scoreDelta survives serialization unchanged for every penalised finding.
    const audited = [...result.findings, ...result.warnings];
    const exported = [...report.findings, ...report.warnings];

    // Sanity: the audit produced at least one finding with a real penalty.
    const penalised = audited.filter(
      (f) => typeof f.scoreDelta === 'number' && f.scoreDelta < 0,
    );
    expect(penalised.length).toBeGreaterThan(0);

    audited.forEach((f, i) => {
      if (typeof f.scoreDelta === 'number') {
        expect(exported[i].scoreDelta).toBe(f.scoreDelta);
      } else {
        // undefined deltas are dropped during JSON serialization.
        expect('scoreDelta' in exported[i]).toBe(false);
      }
    });
  });

  it('maps the human-readable label, not just the raw finding type', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const exported = [...result.findings, ...result.warnings].map(mapFinding);

    const entity = exported.find((f) => f.type === 'ENTITY_SCAM');
    expect(entity).toBeDefined();
    // mapFinding resolves the friendly label via FINDING_TYPE_LABELS.
    expect(entity!.label).not.toBe(entity!.type);
    expect(entity!.txids.length).toBeGreaterThan(0);
    expect(entity!.addresses.length).toBeGreaterThan(0);
  });
});

// buildPrivacyTextReport is the SAME function Reports.tsx (exportText) uses to
// assemble the plain-text (.txt) export, so these tests guard the real text
// layout — not a copy. If the export drops the header, summary, scope, severity
// breakdown, or any per-finding field, the assertions below catch it.
describe('privacy report export — plain text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A fixed timestamp keeps the header line deterministic in the test.
  const FIXED_GENERATED_AT = 'Jan 1, 2026, 12:00:00 PM';

  it('emits the header, offline note, and scope lines', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(
      result,
      { owner: 'Alice', wallet: 'Cold Storage' },
      FIXED_GENERATED_AT,
    );
    const lines = text.split('\n');

    expect(lines[0]).toBe('='.repeat(60));
    expect(lines[1]).toBe('PRIVACY AUDIT REPORT');
    expect(lines[2]).toBe('='.repeat(60));
    expect(text).toContain(`Generated: ${FIXED_GENERATED_AT}`);
    expect(text).toContain('All analysis ran fully offline.');
    expect(text).toContain('Owner: Alice');
    expect(text).toContain('Wallet: Cold Storage');

    // Closing footer is present.
    expect(text).toContain('KYUTXO Privacy Audit · Offline-first compliance artifact.');
    expect(text).toContain('Citation URLs are shown as plain text and are never fetched.');
    expect(lines[lines.length - 1]).toBe('='.repeat(60));
  });

  it('renders "All" for an unscoped (null owner/wallet) export', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(result, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    expect(text).toContain('Owner: All');
    expect(text).toContain('Wallet: All');
  });

  it('uses the human-readable locale format for the default "Generated" timestamp, not epoch/ISO', async () => {
    // When no generatedAt override is passed, the report stamps `new Date()` via
    // toLocaleString(). Pin the wall clock so the default branch is deterministic
    // and lock the format: a regression that swapped it for an ISO string or a
    // raw epoch number would no longer match.
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const fixedNow = new Date(Date.UTC(2026, 5, 27, 9, 30, 0));
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    let text: string;
    try {
      text = buildPrivacyTextReport(result, { owner: null, wallet: null });
    } finally {
      vi.useRealTimers();
    }
    const line = text.split('\n').find((l) => l.startsWith('Generated: '));
    expect(line).toBe(`Generated: ${fixedNow.toLocaleString()}`);
    expect(line).not.toBe(`Generated: ${fixedNow.toISOString()}`);
    expect(line).not.toBe(`Generated: ${fixedNow.getTime()}`);
  });

  it('emits the summary lines from the audit result', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(result, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    expect(text).toContain(`Grade: ${result.grade}`);
    expect(text).toContain(`Score: ${result.score}/100`);
    expect(text).toContain(
      `Transactions Analyzed: ${result.transactionsAnalyzed.toLocaleString()}`,
    );
    expect(text).toContain(
      `Addresses Scanned: ${result.addressesScanned.toLocaleString()}`,
    );
  });

  it('renders the severity breakdown section with each present severity', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(result, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    expect(text).toContain('SEVERITY BREAKDOWN');

    const allFindings = [...result.findings, ...result.warnings];
    for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
      const count = allFindings.filter((f) => f.severity === sev).length;
      if (count > 0) {
        const label = sev.charAt(0) + sev.slice(1).toLowerCase();
        expect(text).toContain(`  ${label}: ${count}`);
      }
    }
  });

  it('renders the score breakdown section with each waterfall entry', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(result, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    expect(text).toContain('SCORE BREAKDOWN');

    // Sanity: the audit produced a waterfall to assert against.
    expect(result.scoreWaterfall.length).toBeGreaterThan(0);

    for (const entry of result.scoreWaterfall) {
      const count = entry.count > 0 ? entry.count.toLocaleString() : '—';
      const delta = entry.delta === 0 ? '—' : (entry.delta > 0 ? '+' : '') + entry.delta;
      // Label line and the count/delta/score detail line, matching the printed report.
      expect(text).toContain(`  ${entry.label}`);
      expect(text).toContain(
        `    Count: ${count}  ·  Delta: ${delta}  ·  Score: ${entry.runningScore}`,
      );
    }
  });

  it('omits the score breakdown section when the waterfall is empty', () => {
    const cleanResult = {
      grade: 'A+',
      score: 100,
      transactionsAnalyzed: 0,
      addressesScanned: 0,
      isClean: true,
      fingerprintCoverage: 1,
      needsResync: false,
      findings: [],
      warnings: [],
      scoreWaterfall: [],
    } as unknown as PrivacyAuditResult;

    const text = buildPrivacyTextReport(cleanResult, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    expect(text).not.toContain('SCORE BREAKDOWN');
  });

  it('lists every finding with its label, severity, description, and metadata', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(result, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    const allFindings = [...result.findings, ...result.warnings];
    expect(allFindings.length).toBeGreaterThan(0);
    expect(text).toContain(`FINDINGS & WARNINGS (${allFindings.length})`);

    allFindings.forEach((f, i) => {
      const label = FINDING_TYPE_LABELS[f.type] ?? f.type;
      const sevLabel = f.severity.charAt(0) + f.severity.slice(1).toLowerCase();
      // Numbered header line: "N. [Severity] Label"
      expect(text).toContain(`${i + 1}. [${sevLabel}] ${label}`);
      // Description line.
      expect(text).toContain(`   ${f.description}`);
      if (f.correction) {
        expect(text).toContain(`   Fix: ${f.correction}`);
      }
      // Address/transaction metadata line.
      const meta: string[] = [];
      if (f.addresses.length > 0) meta.push(`${f.addresses.length} address(es)`);
      if (f.txids.length > 0) meta.push(`${f.txids.length} transaction(s)`);
      if (meta.length > 0) {
        expect(text).toContain(`   ${meta.join('  ·  ')}`);
      }
    });
  });

  it('includes source citations (name, address, source URL) for entity findings', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(result, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    expect(text).toContain('Source Citations:');
    // Scam entity citation block, with the URL passed through verbatim.
    expect(text).toContain(`     - ${SCAM_ENTITY.name} (${SCAM_ENTITY.categoryLabel})`);
    expect(text).toContain(`       Address: ${SCAM_ENTITY.address}`);
    expect(text).toContain(`       Source: ${SCAM_ENTITY.sourceNote}`);
    expect(text).toContain('https://www.treasury.gov/');

    // Both distinct exchange entities are cited.
    expect(text).toContain(`     - ${EXCHANGE_ENTITY.name} (${EXCHANGE_ENTITY.categoryLabel})`);
    expect(text).toContain(`       Address: ${EXCHANGE_ENTITY.address}`);
    expect(text).toContain(`     - ${COINBASE_ENTITY.name} (${COINBASE_ENTITY.categoryLabel})`);
    expect(text).toContain(`       Address: ${COINBASE_ENTITY.address}`);
  });

  it('shows the re-sync notice only when fingerprint coverage is incomplete', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const text = buildPrivacyTextReport(result, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    if (result.needsResync) {
      expect(text).toContain(
        `Fingerprint Coverage: ${Math.round(result.fingerprintCoverage * 100)}% — re-sync recommended for complete results.`,
      );
    } else {
      expect(text).not.toContain('re-sync recommended');
    }
  });

  it('renders a clean report when there are no findings', () => {
    const cleanResult = {
      grade: 'A+',
      score: 100,
      transactionsAnalyzed: 0,
      addressesScanned: 0,
      isClean: true,
      fingerprintCoverage: 1,
      needsResync: false,
      findings: [],
      warnings: [],
      scoreWaterfall: [],
    } as unknown as PrivacyAuditResult;

    const text = buildPrivacyTextReport(cleanResult, { owner: null, wallet: null }, FIXED_GENERATED_AT);

    expect(text).toContain('Clean — no privacy findings.');
    expect(text).toContain('FINDINGS & WARNINGS (0)');
    expect(text).toContain('No privacy findings — your transaction history is clean.');
  });
});

// buildPrintableReport is the SAME function Reports.tsx (exportPdf) writes into
// the print window for "Print / PDF", so these tests guard the real printable
// HTML — not a copy. If the HTML drops the header, summary, severity chips,
// scope, or any per-finding field (label/severity/description/correction/
// address+transaction counts/citations), or stops escaping user-controlled
// text, the assertions below catch it.
describe('privacy report export — printable HTML', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A fixed Date keeps the "Generated …" line and the <title> date deterministic.
  const FIXED_NOW = new Date('2026-01-15T09:30:00.000Z');

  it('renders the header, offline note, and chosen scope', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(
      result,
      { owner: 'Alice', wallet: 'Cold Storage' },
      FIXED_NOW,
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<h1>Privacy Audit Report</h1>');
    expect(html).toContain('All analysis ran fully offline.');
    expect(html).toContain(`Generated ${escapeHtml(FIXED_NOW.toLocaleString())}`);
    // The <title> carries the ISO date (YYYY-MM-DD).
    expect(html).toContain('Privacy Audit Report — 2026-01-15');
    // Scope line reflects the chosen owner/wallet.
    expect(html).toContain('Owner: Alice');
    expect(html).toContain('Wallet: Cold Storage');
    // Offline footer is present.
    expect(html).toContain(
      'KYUTXO Privacy Audit · Offline-first compliance artifact.',
    );
    expect(html).toContain(
      'Citation URLs are shown as plain text and are never fetched.',
    );
  });

  it('renders "All" scope for an unscoped (null owner/wallet) export', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(result, { owner: null, wallet: null }, FIXED_NOW);

    expect(html).toContain('Owner: All');
    expect(html).toContain('Wallet: All');
  });

  it('renders the "Generated" line in locale format, never the raw epoch or a second ISO copy', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(result, { owner: null, wallet: null }, FIXED_NOW);

    // The <title> legitimately carries an ISO *date* (YYYY-MM-DD); the body
    // "Generated …" subtitle must be the human-readable locale string instead.
    expect(html).toContain(`Generated ${escapeHtml(FIXED_NOW.toLocaleString())}`);
    expect(html).not.toContain(`Generated ${FIXED_NOW.toISOString()}`);
    expect(html).not.toContain(`Generated ${FIXED_NOW.getTime()}`);
  });

  it('renders the summary boxes from the audit result', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(result, { owner: null, wallet: null }, FIXED_NOW);

    expect(html).toContain(`<div class="value">${escapeHtml(result.grade)}</div><div class="label">Grade</div>`);
    expect(html).toContain(`<div class="value">${result.score}/100</div><div class="label">Score</div>`);
    expect(html).toContain(`<div class="value">${result.transactionsAnalyzed.toLocaleString()}</div><div class="label">Txs Analyzed</div>`);
    expect(html).toContain(`<div class="value">${result.addressesScanned.toLocaleString()}</div><div class="label">Addresses</div>`);
  });

  it('renders a severity chip for each present severity', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(result, { owner: null, wallet: null }, FIXED_NOW);

    const allFindings = [...result.findings, ...result.warnings];
    expect(allFindings.length).toBeGreaterThan(0);

    for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
      const count = allFindings.filter((f) => f.severity === sev).length;
      if (count > 0) {
        expect(html).toContain(`${count} ${severityLabel(sev)}`);
      }
    }
  });

  it('renders every finding with label/severity/description/correction and counts', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(result, { owner: null, wallet: null }, FIXED_NOW);

    const allFindings = [...result.findings, ...result.warnings];
    expect(allFindings.length).toBeGreaterThan(0);
    expect(html).toContain(`Findings &amp; Warnings (${allFindings.length})`);

    for (const f of allFindings) {
      const label = FINDING_TYPE_LABELS[f.type] ?? f.type;
      expect(html).toContain(escapeHtml(label));
      expect(html).toContain(`>${escapeHtml(severityLabel(f.severity))}</span>`);
      expect(html).toContain(escapeHtml(f.description));
      if (f.correction) {
        expect(html).toContain(`<strong>Fix:</strong> ${escapeHtml(f.correction)}`);
      }
      if (f.addresses.length > 0) {
        expect(html).toContain(`${f.addresses.length} address(es)`);
      }
      if (f.txids.length > 0) {
        expect(html).toContain(`${f.txids.length} transaction(s)`);
      }
    }
  });

  it('renders entity source citations in the printable HTML', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(result, { owner: null, wallet: null }, FIXED_NOW);

    expect(html).toContain('Source Citations');
    // Scam entity citation row, with its public-attribution URL as plain text.
    expect(html).toContain(escapeHtml(SCAM_ENTITY.name));
    expect(html).toContain(escapeHtml(SCAM_ENTITY.address));
    expect(html).toContain(escapeHtml(SCAM_ENTITY.categoryLabel));
    expect(html).toContain(escapeHtml(SCAM_ENTITY.sourceNote));
    expect(html).toContain('https://www.treasury.gov/');

    // Both distinct exchange entities are cited.
    expect(html).toContain(escapeHtml(EXCHANGE_ENTITY.name));
    expect(html).toContain(escapeHtml(EXCHANGE_ENTITY.address));
    expect(html).toContain(escapeHtml(COINBASE_ENTITY.name));
    expect(html).toContain(escapeHtml(COINBASE_ENTITY.address));
  });

  it('renders the score-waterfall rows when present', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const html = buildPrintableReport(result, { owner: null, wallet: null }, FIXED_NOW);

    if (result.scoreWaterfall.length > 0) {
      expect(html).toContain('Score Breakdown');
      for (const entry of result.scoreWaterfall) {
        expect(html).toContain(escapeHtml(entry.label));
      }
    }
  });

  it('escapes user-controlled text and leaves citation URLs as plain text', () => {
    const xssCitation = {
      name: 'Evil <script>alert("x")</script> & Co',
      address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      categoryLabel: 'Scam & <Fraud>',
      sourceNote: 'Reported at https://example.com/report?a=1&b=2 <ref>',
    };
    const syntheticResult = {
      findings: [
        {
          type: 'ENTITY_SCAM',
          severity: 'CRITICAL',
          description: 'Linked to a flagged entity <bad> & risky',
          details: { citations: [xssCitation] },
          correction: 'Rotate <keys> & stop using this address',
          txids: ['tx1'],
          addresses: [xssCitation.address],
        },
      ],
      warnings: [],
      transactionsAnalyzed: 1,
      addressesScanned: 1,
      isClean: false,
      score: 30,
      grade: 'D',
      scoreWaterfall: [],
      needsResync: false,
      fingerprintCoverage: 1,
    } as unknown as PrivacyAuditResult;

    const html = buildPrintableReport(
      syntheticResult,
      { owner: 'Bob & <Friends>', wallet: 'Hot <Wallet>' },
      FIXED_NOW,
    );

    // No raw user-controlled angle brackets survive into the HTML body.
    expect(html).toContain('Evil &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co');
    expect(html).toContain('Scam &amp; &lt;Fraud&gt;');
    expect(html).toContain('Linked to a flagged entity &lt;bad&gt; &amp; risky');
    expect(html).toContain('Rotate &lt;keys&gt; &amp; stop using this address');
    expect(html).toContain('Owner: Bob &amp; &lt;Friends&gt;');
    expect(html).toContain('Wallet: Hot &lt;Wallet&gt;');

    // The raw, unescaped attacker markup must never appear verbatim.
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<Fraud>');
    expect(html).not.toContain('<bad>');

    // The citation URL is preserved (the &-escaped query string is still the
    // same URL text), shown as plain text — never turned into a fetched <a>.
    expect(html).toContain('https://example.com/report?a=1&amp;b=2');
    expect(html).not.toContain('<a href');
  });

  it('renders a clean report when there are no findings', () => {
    const cleanResult = {
      grade: 'A+',
      score: 100,
      transactionsAnalyzed: 0,
      addressesScanned: 0,
      isClean: true,
      fingerprintCoverage: 1,
      needsResync: false,
      findings: [],
      warnings: [],
      scoreWaterfall: [],
    } as unknown as PrivacyAuditResult;

    const html = buildPrintableReport(cleanResult, { owner: null, wallet: null }, FIXED_NOW);

    expect(html).toContain('Findings &amp; Warnings (0)');
    expect(html).toContain('No privacy findings — your transaction history is clean.');
    // The severity summary collapses to a single "Clean" chip.
    expect(html).toContain('>Clean</span>');
  });

  it('escapeHtml encodes the five HTML-sensitive characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>& </a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp; &lt;/a&gt;',
    );
  });
});
