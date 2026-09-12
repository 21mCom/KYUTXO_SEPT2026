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
    records: {
      where: () => ({
        anyOf: () => ({ toArray: () => Promise.resolve([]) }),
      }),
    },
    transactionParticipants: {
      where: () => ({
        anyOf: () => ({ limit: () => ({ toArray: () => Promise.resolve([...ALL_PARTICIPANTS]) }) }),
        equals: () => ({ limit: () => ({ toArray: () => Promise.resolve([...ALL_PARTICIPANTS]) }) }),
      }),
    },
    blockchainTransactions: {
      where: () => ({
        anyOf: () => ({ limit: () => ({ toArray: () => Promise.resolve([...TX_RECORDS]) }) }),
        equals: () => ({ limit: () => ({ toArray: () => Promise.resolve([...TX_RECORDS]) }) }),
      }),
    },
    dustFlags: {
      toArray: () => Promise.resolve([]),
    },
  },
}));

vi.mock('../data/record-queries', () => ({
  getParticipantsByAddresses: vi.fn(() =>
    Promise.resolve(
      ALL_PARTICIPANTS.filter((p) => p.address === USER_ADDRESS),
    ),
  ),
  // Privacy audits now use the outpoint-aware query so blank-address Electrum
  // inputs are not missed. This fixture has no such extra rows, so return the
  // same address-scoped participants while preserving the production call path.
  getParticipantsByAddressesWithOutpointSpends: vi.fn(() =>
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
import { FINDING_TYPE_LABELS, type PrivacyAuditResult, type PrivacyFinding } from '../privacy-audit';
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

  it('preserves the scoreWaterfall from the audit result and nests its findings', async () => {
    const result = await runPrivacyAudit([USER_ADDRESS]);
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, { owner: null, wallet: null })),
    ) as {
      scoreWaterfall: Array<Record<string, unknown> & {
        findingType: string;
        findings: Array<Record<string, unknown>>;
      }>;
    };

    // Sanity: the audit produced a waterfall to assert against.
    expect(result.scoreWaterfall.length).toBeGreaterThan(0);
    expect(report.scoreWaterfall).toHaveLength(result.scoreWaterfall.length);

    report.scoreWaterfall.forEach((entry, i) => {
      const source = result.scoreWaterfall[i];
      // Every original waterfall field is preserved verbatim.
      expect(entry.label).toBe(source.label);
      expect(entry.findingType).toBe(source.findingType);
      expect(entry.delta).toBe(source.delta);
      expect(entry.runningScore).toBe(source.runningScore);
      expect(entry.count).toBe(source.count);

      // Each entry additionally enumerates its individual same-type findings,
      // grouping them under the aggregated category, in the same flat order the
      // on-screen navigator uses. BASE carries none.
      const members =
        source.findingType === 'BASE'
          ? []
          : [...result.findings, ...result.warnings].filter(
              (f) => f.type === source.findingType,
            );
      expect(Array.isArray(entry.findings)).toBe(true);
      expect(entry.findings).toHaveLength(members.length);
      entry.findings.forEach((m, j) => {
        expect(m.severity).toBe(members[j].severity);
        expect(m.addresses).toEqual(members[j].addresses);
        expect(m.txids).toEqual(members[j].txids);
        if (typeof members[j].scoreDelta === 'number') {
          expect(m.scoreDelta).toBe(members[j].scoreDelta);
        } else {
          expect('scoreDelta' in m).toBe(false);
        }
      });
    });

    // At least one non-BASE category actually enumerated findings (proves the
    // nesting is exercised, not vacuously empty).
    const enumerated = report.scoreWaterfall.filter(
      (e) => e.findingType !== 'BASE' && e.findings.length > 0,
    );
    expect(enumerated.length).toBeGreaterThan(0);
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

// The printable HTML report escapes HTML-special characters so attacker-supplied
// entity names can't break out of the markup. The JSON export takes the opposite
// (and equally important) contract: it must carry the user/data-controlled
// strings VERBATIM. JSON has its own escaping needs — quotes, backslashes — and a
// regression that double-escaped, stripped, or otherwise mangled those values
// would silently corrupt the exported compliance artifact. These tests build the
// report with buildPrivacyReport (the SAME function Reports.tsx uses) from a
// finding/citation payload stuffed with quotes, backslashes, and angle brackets,
// then prove every field survives a JSON.stringify + JSON.parse round-trip byte
// for byte.
describe('privacy report export — JSON preserves malicious entity strings verbatim', () => {
  // Every nasty character JSON itself has to escape or that an HTML-minded
  // regression might try to neutralise: double/single quotes, backslashes,
  // angle brackets, ampersands, newlines, tabs, and a literal backslash-quote.
  const NASTY = String.raw`Evil"Corp\Inc <b>x</b> & 'co' ` + '\n\ttab \\" end';
  const NASTY_URL = String.raw`https://example.com/p?a=1&b=2&q="<x>"\z`;

  // A direct ENTITY_* finding whose every text field — description, correction,
  // and each citation field — is the nasty payload.
  const ENTITY_FINDING = {
    type: 'ENTITY_SCAM',
    severity: 'CRITICAL',
    description: `desc ${NASTY}`,
    correction: `fix ${NASTY}`,
    txids: ['tx_scam'],
    addresses: [`addr ${NASTY}`],
    scoreDelta: -28,
    details: {
      citations: [
        {
          name: `name ${NASTY}`,
          address: `caddr ${NASTY}`,
          categoryLabel: `cat ${NASTY}`,
          sourceNote: NASTY_URL,
        },
      ],
    },
  } as unknown as PrivacyFinding;

  // A non-entity warning (no citations) whose description/correction also carry
  // the payload, so both the `findings` and `warnings` arrays are covered.
  const FINGERPRINT_WARNING = {
    type: 'FINGERPRINT_NVERSION',
    severity: 'LOW',
    description: `warn desc ${NASTY}`,
    correction: `warn fix ${NASTY}`,
    txids: ['tx_fp'],
    addresses: [],
    scoreDelta: -0.4,
    details: {},
  } as unknown as PrivacyFinding;

  const maliciousResult = {
    grade: 'C+',
    score: 72,
    transactionsAnalyzed: 1234,
    addressesScanned: 56,
    isClean: false,
    fingerprintCoverage: 1,
    needsResync: false,
    findings: [ENTITY_FINDING],
    warnings: [FINGERPRINT_WARNING],
    scoreWaterfall: [
      { label: 'Base Score', findingType: 'BASE', delta: 0, runningScore: 100, count: 0 },
      { label: 'Known Scam', findingType: 'ENTITY_SCAM', delta: -28, runningScore: 72, count: 1 },
    ],
  } as unknown as PrivacyAuditResult;

  function roundTrip() {
    return JSON.parse(
      JSON.stringify(buildPrivacyReport(maliciousResult, { owner: null, wallet: null })),
    ) as {
      findings: Array<Record<string, unknown>>;
      warnings: Array<Record<string, unknown>>;
    };
  }

  it('preserves entity finding description, correction, addresses verbatim after a JSON round-trip', () => {
    const report = roundTrip();
    const finding = report.findings.find((f) => f.type === 'ENTITY_SCAM');
    expect(finding).toBeDefined();

    expect(finding!.description).toBe(`desc ${NASTY}`);
    expect(finding!.correction).toBe(`fix ${NASTY}`);
    expect(finding!.addresses).toEqual([`addr ${NASTY}`]);
  });

  it('preserves every citation field verbatim after a JSON round-trip', () => {
    const report = roundTrip();
    const finding = report.findings.find((f) => f.type === 'ENTITY_SCAM');
    const citations = finding!.citations as Array<Record<string, unknown>>;

    expect(citations).toHaveLength(1);
    expect(citations[0]).toEqual({
      name: `name ${NASTY}`,
      address: `caddr ${NASTY}`,
      categoryLabel: `cat ${NASTY}`,
      sourceNote: NASTY_URL,
    });
    // The source URL's quotes, ampersands, angle brackets, and backslash survive
    // untouched — never HTML-escaped, percent-encoded, or otherwise mangled.
    expect(citations[0].sourceNote).toBe(NASTY_URL);
  });

  it('preserves warning description and correction verbatim after a JSON round-trip', () => {
    const report = roundTrip();
    const warning = report.warnings.find((f) => f.type === 'FINGERPRINT_NVERSION');
    expect(warning).toBeDefined();

    expect(warning!.description).toBe(`warn desc ${NASTY}`);
    expect(warning!.correction).toBe(`warn fix ${NASTY}`);
  });

  it('does not HTML-escape any field — the raw special characters are present', () => {
    const report = roundTrip();
    const finding = report.findings.find((f) => f.type === 'ENTITY_SCAM');
    const citations = finding!.citations as Array<Record<string, unknown>>;

    // A regression that ran the JSON values through the HTML escaper would turn
    // these into &lt; / &quot; / &amp; entities. Assert the raw characters remain.
    expect(finding!.description).toContain('<b>');
    expect(finding!.description).toContain('"');
    expect(finding!.description).toContain('\\');
    expect(citations[0].name).toContain('<b>');
    expect(citations[0].categoryLabel).toContain('&');

    const serialized = JSON.stringify(report);
    // No HTML entities leaked into the serialized artifact.
    expect(serialized).not.toContain('&lt;');
    expect(serialized).not.toContain('&quot;');
    expect(serialized).not.toContain('&amp;');
  });
});

// The plain-text (.txt) report is line-based: every section marker, header, and
// per-finding field is pushed as its own line and joined with "\n". Like the JSON
// export it must carry user/data-controlled strings VERBATIM (it never escapes),
// but it has a layout contract the other exports don't: an attacker-supplied
// field that contains quotes, backslashes, angle brackets, ampersands — or, most
// dangerously, an embedded newline — must not corrupt the surrounding structure
// (e.g. an injected newline shifting subsequent lines or forging a section
// marker). These tests build the report with buildPrivacyTextReport (the SAME
// function Reports.tsx uses) from a finding/citation payload stuffed with those
// characters and prove (a) each field's text survives verbatim and (b) the fixed
// header/severity/score/findings/citation/footer scaffolding stays intact.
describe('privacy report export — plain text preserves malicious entity strings without corrupting layout', () => {
  // Every special character: double/single quotes, backslashes, angle brackets,
  // ampersands, a tab, a literal backslash-quote, AND embedded newlines — the
  // line-based layout's worst case, since a stray "\n" would shift later lines.
  const NASTY =
    String.raw`Evil"Corp\Inc <b>x</b> & 'co' ` + '\n\ttab \\" end\nINJECTED LINE';
  const NASTY_URL = String.raw`https://example.com/p?a=1&b=2&q="<x>"\z`;

  // A direct ENTITY_* finding (so it carries a Source Citations block) whose
  // every text field — description, correction, address, and each citation
  // field — is the nasty payload.
  const ENTITY_FINDING = {
    type: 'ENTITY_SCAM',
    severity: 'CRITICAL',
    description: `desc ${NASTY}`,
    correction: `fix ${NASTY}`,
    txids: ['tx_scam'],
    addresses: [`addr ${NASTY}`],
    scoreDelta: -28,
    details: {
      citations: [
        {
          name: `name ${NASTY}`,
          address: `caddr ${NASTY}`,
          categoryLabel: `cat ${NASTY}`,
          sourceNote: NASTY_URL,
        },
      ],
    },
  } as unknown as PrivacyFinding;

  // A non-entity warning (no citations) whose description/correction also carry
  // the payload, so both the `findings` and `warnings` paths are covered.
  const FINGERPRINT_WARNING = {
    type: 'FINGERPRINT_NVERSION',
    severity: 'LOW',
    description: `warn desc ${NASTY}`,
    correction: `warn fix ${NASTY}`,
    txids: ['tx_fp'],
    addresses: [],
    scoreDelta: -0.4,
    details: {},
  } as unknown as PrivacyFinding;

  const maliciousResult = {
    grade: 'C+',
    score: 72,
    transactionsAnalyzed: 1234,
    addressesScanned: 56,
    isClean: false,
    fingerprintCoverage: 1,
    needsResync: false,
    findings: [ENTITY_FINDING],
    warnings: [FINGERPRINT_WARNING],
    scoreWaterfall: [
      { label: 'Base Score', findingType: 'BASE', delta: 0, runningScore: 100, count: 0 },
      { label: 'Known Scam', findingType: 'ENTITY_SCAM', delta: -28, runningScore: 72, count: 1 },
    ],
  } as unknown as PrivacyAuditResult;

  const FIXED_GENERATED_AT = 'Jan 1, 2026, 12:00:00 PM';

  function build() {
    return buildPrivacyTextReport(
      maliciousResult,
      { owner: null, wallet: null },
      FIXED_GENERATED_AT,
    );
  }

  it('passes the entity finding description, correction, and address through verbatim', () => {
    const text = build();
    // Each field — newlines, quotes, backslashes, angle brackets and all — is
    // present byte-for-byte. No escaping, stripping, or newline-flattening.
    expect(text).toContain(`desc ${NASTY}`);
    expect(text).toContain(`fix ${NASTY}`);
    expect(text).toContain(`addr ${NASTY}`);
  });

  it('passes every citation field through verbatim, URL included', () => {
    const text = build();
    expect(text).toContain(`name ${NASTY}`);
    expect(text).toContain(`cat ${NASTY}`);
    expect(text).toContain(`caddr ${NASTY}`);
    // The source URL's quotes, ampersands, angle brackets and backslash survive
    // untouched — never HTML-escaped, percent-encoded, or otherwise mangled.
    expect(text).toContain(NASTY_URL);
  });

  it('passes the warning description and correction through verbatim', () => {
    const text = build();
    expect(text).toContain(`warn desc ${NASTY}`);
    expect(text).toContain(`warn fix ${NASTY}`);
  });

  it('does not HTML-escape any field — the raw special characters remain', () => {
    const text = build();
    // A regression that ran the text values through the HTML escaper would turn
    // these into &lt; / &quot; / &amp; entities. Assert the raw characters remain
    // and no HTML entity leaked into the plain-text artifact.
    expect(text).toContain('<b>');
    expect(text).toContain('"');
    expect(text).toContain('\\');
    expect(text).toContain('&');
    expect(text).not.toContain('&lt;');
    expect(text).not.toContain('&quot;');
    expect(text).not.toContain('&amp;');
  });

  it('keeps the fixed section scaffolding intact as whole lines despite injected newlines', () => {
    const text = build();
    const lines = text.split('\n');
    const sep = '='.repeat(60);
    const sub = '-'.repeat(60);

    // Header block: the two separator rules bracket the title, in order, as exact
    // whole lines — an injected "\n…" inside a field cannot forge or displace them.
    expect(lines[0]).toBe(sep);
    expect(lines[1]).toBe('PRIVACY AUDIT REPORT');
    expect(lines[2]).toBe(sep);
    expect(lines[3]).toBe(`Generated: ${FIXED_GENERATED_AT}`);

    // Every fixed section marker still exists as its own untouched whole line.
    for (const marker of [
      'SEVERITY BREAKDOWN',
      'SCORE BREAKDOWN',
      `FINDINGS & WARNINGS (2)`,
      '   Source Citations:',
      'KYUTXO Privacy Audit · Offline-first compliance artifact.',
      'Citation URLs are shown as plain text and are never fetched.',
    ]) {
      expect(lines).toContain(marker);
    }
    // The separator rule appears as a whole line the expected number of times
    // (two header + section dividers + footer), proving the injected payload did
    // not introduce or swallow any structural rule.
    expect(lines.filter((l) => l === sep).length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((l) => l === sub).length).toBeGreaterThanOrEqual(3);

    // The numbered finding/warning headers are still well-formed whole lines,
    // not merged into a neighbouring field by a stray newline.
    expect(lines).toContain('1. [Critical] Scam Address Contact');
    expect(lines).toContain('2. [Low] Wallet Fingerprint (nVersion)');

    // The closing footer separator is the final line — proof nothing after the
    // payload shifted the document's end.
    expect(lines[lines.length - 1]).toBe(sep);
  });

  it('emits the attacker-injected newline as an extra body line but never as a forged section marker', () => {
    const text = build();
    const lines = text.split('\n');
    // The payload's embedded "INJECTED LINE" does appear (verbatim pass-through),
    // but only ever as ordinary indented body content — it never collides with or
    // impersonates a real structural marker line.
    expect(text).toContain('INJECTED LINE');
    expect(lines).not.toContain('PRIVACY AUDIT REPORT INJECTED LINE');
    // No structural marker line was corrupted into carrying the injected text.
    const markerLines = ['PRIVACY AUDIT REPORT', 'SEVERITY BREAKDOWN', 'SCORE BREAKDOWN'];
    for (const m of markerLines) {
      expect(lines.filter((l) => l === m)).toHaveLength(1);
    }
  });
});
