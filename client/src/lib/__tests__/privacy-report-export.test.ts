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

const USER_ADDRESS = 'bc1quseraddressxxxxxxxxxxxxxxxxxxxxxxxxqqqq';

// Tx 1: user pays the exchange. Tx 2: user pays the scam address.
// Hoisted so the (hoisted) vi.mock factories below can reference them.
const { ALL_PARTICIPANTS, TX_RECORDS } = vi.hoisted(() => {
  const userAddress = 'bc1quseraddressxxxxxxxxxxxxxxxxxxxxxxxxqqqq';
  const exchangeAddr = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
  const scamAddr = '134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak';
  return {
    ALL_PARTICIPANTS: [
      { txid: 'tx_exchange', role: 'input', address: userAddress, amount: 100000, vout: 0 },
      { txid: 'tx_exchange', role: 'output', address: exchangeAddr, amount: 90000, vout: 0 },
      { txid: 'tx_scam', role: 'input', address: userAddress, amount: 50000, vout: 0 },
      { txid: 'tx_scam', role: 'output', address: scamAddr, amount: 45000, vout: 0 },
    ] as TransactionParticipant[],
    TX_RECORDS: [
      // nVersion=1 with captured fingerprint data reliably yields a non-entity
      // FINGERPRINT_NVERSION finding, so we can assert citations are omitted on it.
      { txid: 'tx_exchange', blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_100, rawFingerprintCaptured: true, nVersion: 1 },
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
import { mapFinding } from '../privacy-report-export';

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
});
