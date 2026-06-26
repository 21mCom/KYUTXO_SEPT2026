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
import { FINDING_TYPE_LABELS } from '../privacy-audit';

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
