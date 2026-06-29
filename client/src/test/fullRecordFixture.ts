// A single source of truth for a "fully populated" DB record fixture.
//
// It is typed `Required<DbRecord>` on purpose: adding a new field to the
// `Record` schema without populating it here is a COMPILE error. Every test
// that proves "no field is silently dropped" — the shared converter contract
// (recordToPanel.test.ts) AND the per-consumer wiring tests (RecordPreviewContext,
// Records page, AddressLink) — imports this fixture, so a newly added schema
// field is forced through all of them at once.

import type { Record as DbRecord } from "@/lib/database";

export const fullRecord: Required<DbRecord> = {
  id: 42,
  type: "address",
  inputString: "bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxx",
  inputStringLower: "bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxx",
  label: "Cold Storage",
  notes: "Long-term hold",
  amount: 123456,
  date: "2026-01-15",
  tags: ["savings", "cold"],
  categories: ["personal"],
  seedName: "Primary Seed",
  walletSoftware: "Sparrow",
  privateKeyStatus: "secured",
  owner: "Alice",
  walletName: "College Fund",
  source: "manual",
  chainType: "receive",
  derivationPath: "m/84'/0'/0'/0/0",
  xpub: "zpub6exampleexampleexample",
  vault: {
    isVaultXpub: true,
    vaultName: "Family Vault",
    m: 2,
    n: 3,
    vaultNotes: "2-of-3 multisig",
  },
  customFields: { "risk-level": "low" },
  syncDepth: 0,
  maxSyncedDepth: 2,
  discoveredInTxid: "a".repeat(64),
  discoveredFromRecordId: 7,
  addressImportance: "verified",
  firstSeenBlockTime: 1736899200,
  cachedBalanceSats: 500000,
  cachedTxCount: 12,
  cachedLastActivityTime: 1736899200,
  statsComputedAt: 1736899999000,
  cachedUtxoCount: 3,
  flowType: "received",
  acquisitionMethod: "purchase",
  dispositionType: "sale",
  costBasisUsd: 25000,
  counterpartyType: "exchange",
  createdAt: 1736800000000,
  updatedAt: 1736899999000,
};
