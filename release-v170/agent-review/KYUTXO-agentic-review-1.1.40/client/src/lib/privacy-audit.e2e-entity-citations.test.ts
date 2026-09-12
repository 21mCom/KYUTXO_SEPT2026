// End-to-end coverage for entity-contact *source citations* (Task: "Make sure
// users always see why a counterparty was flagged").
//
// privacy-audit.e2e-entity-contacts.test.ts already proves that a direct hop-1
// contact with a known entity surfaces an ENTITY_* finding and lowers the score.
// This sibling test goes one step further and locks down the *attribution* that
// justifies that warning: every flagged counterparty must carry a citation in
// the finding's `details.citations` array (name, categoryLabel, address, and the
// public sourceNote) so the user understands *why* and *based on what public
// source* the counterparty was tagged.
//
// detectEntityContacts() builds that citation list. A regression that drops or
// mangles citations would silently hide the attribution behind the flag, so we
// seed real Dexie records + participants (fake-indexeddb) where an owned address
// pays directly to a known entity address, swap the active entity list with
// setActiveEntityList (so the bundled list never interferes), run the full
// runPrivacyAudit() pipeline, and assert the citation actually flows through.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { db } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { runPrivacyAudit, type EntityCitation } from "./privacy-audit";
import {
  setActiveEntityList,
  resetActiveEntityList,
  type EntityEntry,
} from "./privacy-entity-list";

// OWNED1 pays directly to ENTITY_ADDR in TX1. That is a hop-1 (direct) contact
// captured by detectEntityContacts. We keep the seed minimal and use non-round
// amounts so no other heuristic muddies the finding under test.
const OWNED1 = "bc1qentityowned100000000000000000000000000aa";
const ENTITY_ADDR = "bc1qentitydirect00000000000000000000000000cc";

const TX1 = "1111111111111111111111111111111111111111111111111111111111111111";
// A second transaction with the SAME owned→entity pair. The entity address
// therefore appears across two txids, which lets us assert the citation list is
// deduped by address (one citation, not one per transaction).
const TX2 = "2222222222222222222222222222222222222222222222222222222222222222";

const SOURCE_NOTE =
  "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/example";

async function seedDirectContact(txid: string) {
  await addTransaction(
    { txid, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid, role: "input", address: OWNED1, amount: 250_123, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid, role: "output", address: ENTITY_ADDR, amount: 199_111, vout: 0 },
    { skipNotification: true },
  );
}

function getCitations(details: Record<string, unknown>): EntityCitation[] {
  return (details.citations as EntityCitation[]) ?? [];
}

beforeEach(async () => {
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

afterEach(async () => {
  resetActiveEntityList();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

describe("runPrivacyAudit end-to-end entity-contact citations", () => {
  it("flows the source citation (name, categoryLabel, address, sourceNote) into the ENTITY_* finding", async () => {
    await seedDirectContact(TX1);

    const entry: EntityEntry = {
      address: ENTITY_ADDR,
      name: "Test Exchange",
      category: "exchange",
      sourceNote: SOURCE_NOTE,
    };
    setActiveEntityList([entry]);

    const result = await runPrivacyAudit([OWNED1]);

    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();

    const citations = getCitations(finding!.details);
    expect(citations).toHaveLength(1);

    const citation = citations.find((c) => c.address === ENTITY_ADDR);
    expect(citation).toBeTruthy();
    expect(citation).toEqual({
      name: "Test Exchange",
      address: ENTITY_ADDR,
      categoryLabel: "Exchange",
      sourceNote: SOURCE_NOTE,
    });
  });

  it("dedupes citations by address when multiple matched entities share an address", async () => {
    // The entity address appears in two transactions, and the active list holds
    // two entries for the SAME address. Either path could naively produce two
    // citations; the finding must still carry exactly one per address.
    await seedDirectContact(TX1);
    await seedDirectContact(TX2);

    const duplicateEntries: EntityEntry[] = [
      { address: ENTITY_ADDR, name: "Alias One", category: "exchange", sourceNote: "first source" },
      { address: ENTITY_ADDR, name: "Alias Two", category: "exchange", sourceNote: SOURCE_NOTE },
    ];
    setActiveEntityList(duplicateEntries);

    const result = await runPrivacyAudit([OWNED1]);

    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();
    // The same entity address spans both transactions.
    expect(finding!.txids).toContain(TX1);
    expect(finding!.txids).toContain(TX2);

    const citations = getCitations(finding!.details);
    // Exactly one citation for the shared address despite two list entries and
    // two transactions.
    expect(citations).toHaveLength(1);
    expect(citations.filter((c) => c.address === ENTITY_ADDR)).toHaveLength(1);
    // The surviving entry is the last one to win the address (buildEntityMap
    // keeps the last write), so its sourceNote/name must be the one we see.
    expect(citations[0].name).toBe("Alias Two");
    expect(citations[0].sourceNote).toBe(SOURCE_NOTE);
    expect(citations[0].categoryLabel).toBe("Exchange");
  });
});
