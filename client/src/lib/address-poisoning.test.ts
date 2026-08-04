// Unit tests for the address-poisoning scanner: the lookalike similarity
// matcher (boundary match lengths, exact-match exclusion, address families),
// each heuristic, scope filtering, and cancellation — against seeded
// fake-indexeddb fixtures.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  addressFamily,
  computeLookalikeMatch,
  scanAddressPoisoning,
  isSuspectedPoisoningTag,
  getSuspectedPoisoningTags,
  poisoningWarningText,
  SUSPECTED_POISONING_TAG,
  DEFAULT_DUST_THRESHOLD_SATS,
  DEFAULT_MATCH_LENGTH,
} from "./address-poisoning";
import { createRecord, clearAllRecords } from "./data/record-crud";
import { bulkAddParticipants, clearParticipants } from "./data/transaction-crud";

const noopProgress = () => {};
const neverAborted = new AbortController().signal;

const TXID_DUST = "d".repeat(64);
const TXID_DUST2 = "e".repeat(64);
const TXID_NORMAL = "f".repeat(64);
const TXID_OTHER = "0".repeat(64);

// Victim + lookalike share leading "bc1qvictim" and trailing "wxyz9999".
const VICTIM = "bc1qvictimxyz0000000000000000wxyz9999";
const LOOKALIKE = "bc1qvictimabc1111111111111111wxyz9999";
const STRANGER = "bc1qstranger000000000000000000000000";
const LEGACY_VICTIM = "1victimlegacyaddr00000000000000abcd";
const LEGACY_LOOKALIKE = "1victimlegacyaddr9999999999999abcd";

async function seedVault() {
  await createRecord({
    type: "address",
    inputString: VICTIM,
    label: "Victim",
    tags: [],
    categories: [],
    walletName: "WalletA",
  });
}

describe("suspected-poisoning tag detection", () => {
  it("matches the scanner's default suspect tag", () => {
    expect(isSuspectedPoisoningTag(SUSPECTED_POISONING_TAG)).toBe(true);
    expect(isSuspectedPoisoningTag("Suspected-Poisoning")).toBe(true);
    expect(isSuspectedPoisoningTag("  address-poisoning ")).toBe(true);
  });

  it("never matches target/victim tags (the user's own address) or unrelated tags", () => {
    expect(isSuspectedPoisoningTag("poisoning-target")).toBe(false);
    expect(isSuspectedPoisoningTag("poisoning-victim")).toBe(false);
    expect(isSuspectedPoisoningTag("exchange")).toBe(false);
    expect(isSuspectedPoisoningTag("dusted")).toBe(false);
  });

  it("filters a record's tags down to the poisoning subset", () => {
    expect(
      getSuspectedPoisoningTags(["exchange", "suspected-poisoning", "poisoning-target"]),
    ).toEqual(["suspected-poisoning"]);
    expect(getSuspectedPoisoningTags(undefined)).toEqual([]);
    expect(getSuspectedPoisoningTags(null)).toEqual([]);
  });

  it("warning text names the tags and explains the lookalike risk", () => {
    const text = poisoningWarningText(["suspected-poisoning"]);
    expect(text).toContain('"suspected-poisoning"');
    expect(text).toContain("lookalike of one of your own addresses");
  });
});

describe("addressFamily", () => {
  it("classifies common script families", () => {
    expect(addressFamily("bc1qxyz")).toBe("bc1q");
    expect(addressFamily("BC1QXYZ")).toBe("bc1q");
    expect(addressFamily("bc1pxyz")).toBe("bc1p");
    expect(addressFamily("tb1qxyz")).toBe("tb1q");
    expect(addressFamily("1abc")).toBe("p2pkh");
    expect(addressFamily("3abc")).toBe("p2sh");
    expect(addressFamily("mabc")).toBe("testnet-p2pkh");
    expect(addressFamily("2abc")).toBe("testnet-p2sh");
  });
});

describe("computeLookalikeMatch", () => {
  it("returns shared leading/trailing counts for lookalikes", () => {
    const m = computeLookalikeMatch(LOOKALIKE, VICTIM, 4);
    expect(m).not.toBeNull();
    expect(m!.leading).toBe("bc1qvictim".length);
    expect(m!.trailing).toBe("wxyz9999".length);
  });

  it("excludes exact matches", () => {
    expect(computeLookalikeMatch(VICTIM, VICTIM, 1)).toBeNull();
  });

  it("rejects different address families even with shared characters", () => {
    // Same leading "bc1q" + trailing chars but one is taproot.
    const taproot = `bc1pvictimxyz0000000000000000wxyz9999`;
    expect(computeLookalikeMatch(taproot, VICTIM, 1)).toBeNull();
    // bech32 vs legacy
    expect(computeLookalikeMatch(LOOKALIKE, LEGACY_VICTIM, 1)).toBeNull();
  });

  it("enforces the minimum match length on both ends", () => {
    // Boundary: exactly minMatch on both ends passes.
    const a = "bc1qabcdLEFT0000000000000pqrs";
    const b = "bc1qabcdRIGHT000000000000pqrs";
    expect(computeLookalikeMatch(a, b, 8)).not.toBeNull(); // leading 8 ("bc1qabcd"), trailing 4
    expect(computeLookalikeMatch(a, b, 4)).not.toBeNull();
    // One end below minMatch fails.
    expect(computeLookalikeMatch(a, b, 9)).toBeNull();
    // Trailing too short.
    const c = "bc1qabcdLEFT0000000000000wxyz";
    expect(computeLookalikeMatch(a, c, 5)).toBeNull();
  });

  it("returns null for unrelated addresses", () => {
    expect(computeLookalikeMatch(STRANGER, VICTIM, 4)).toBeNull();
  });
});

describe("scanAddressPoisoning", () => {
  beforeEach(async () => {
    await clearAllRecords();
    await clearParticipants();
  });

  it("detects a dust-sized inbound from a lookalike counterparty", async () => {
    await seedVault();
    await bulkAddParticipants([
      { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
      { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 600 },
    ]);

    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: DEFAULT_DUST_THRESHOLD_SATS, matchLength: DEFAULT_MATCH_LENGTH },
      neverAborted,
      noopProgress,
    );

    expect(outcome).not.toBeNull();
    expect(outcome!.results).toHaveLength(1);
    const r = outcome!.results[0];
    expect(r.targetAddress).toBe(VICTIM);
    expect(r.suspectAddress).toBe(LOOKALIKE);
    expect(r.dustRecipient).toBe(VICTIM);
    expect(r.txid).toBe(TXID_DUST);
    expect(r.vout).toBe(0);
    expect(r.amountSats).toBe(546);
    expect(r.heuristics).toEqual(
      expect.arrayContaining(["dust-sized", "lookalike", "unknown-sender", "one-time-counterparty"]),
    );
    expect(r.confidence).toBe("high");
  });

  it("ignores inbound outputs above the dust threshold", async () => {
    await seedVault();
    await bulkAddParticipants([
      { txid: TXID_NORMAL, role: "output", address: VICTIM, amount: 50_000, vout: 0 },
      { txid: TXID_NORMAL, role: "input", address: LOOKALIKE, amount: 60_000 },
    ]);

    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: 1000, matchLength: 4 },
      neverAborted,
      noopProgress,
    );
    expect(outcome!.results).toHaveLength(0);
  });

  it("honours an exact-threshold output (at-or-below semantics)", async () => {
    await seedVault();
    await bulkAddParticipants([
      { txid: TXID_DUST, role: "output", address: VICTIM, amount: 1000, vout: 0 },
      { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 1200 },
    ]);

    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: 1000, matchLength: 4 },
      neverAborted,
      noopProgress,
    );
    expect(outcome!.results).toHaveLength(1);
  });

  it("does not flag lookalikes below the configured match length", async () => {
    await seedVault();
    await bulkAddParticipants([
      { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
      { txid: TXID_DUST, role: "input", address: STRANGER, amount: 600 },
    ]);

    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: 1000, matchLength: 4 },
      neverAborted,
      noopProgress,
    );
    expect(outcome!.results).toHaveLength(0);
  });

  it("marks a sender with a vault record as known (unknown-sender does not fire)", async () => {
    await seedVault();
    await createRecord({
      type: "address",
      inputString: LOOKALIKE,
      label: "Known counterparty",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
      { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 600 },
    ]);

    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: 1000, matchLength: 4 },
      neverAborted,
      noopProgress,
    );
    expect(outcome!.results).toHaveLength(1);
    const r = outcome!.results[0];
    expect(r.heuristics).not.toContain("unknown-sender");
    expect(r.confidence).toBe("medium"); // one-time-counterparty still fires
  });

  it("drops the one-time-counterparty heuristic when the suspect appears in multiple transactions", async () => {
    await seedVault();
    await bulkAddParticipants([
      { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
      { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 600 },
      { txid: TXID_OTHER, role: "output", address: LOOKALIKE, amount: 5000, vout: 0 },
    ]);

    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: 1000, matchLength: 4 },
      neverAborted,
      noopProgress,
    );
    expect(outcome!.results).toHaveLength(1);
    const r = outcome!.results[0];
    expect(r.heuristics).not.toContain("one-time-counterparty");
    expect(r.heuristics).toContain("unknown-sender");
    expect(r.confidence).toBe("medium");
  });

  it("yields low confidence when only dust + lookalike fire", async () => {
    await seedVault();
    await createRecord({
      type: "address",
      inputString: LOOKALIKE,
      label: "Repeat counterparty",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
      { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 600 },
      { txid: TXID_OTHER, role: "input", address: LOOKALIKE, amount: 5000 },
    ]);

    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: 1000, matchLength: 4 },
      neverAborted,
      noopProgress,
    );
    expect(outcome!.results).toHaveLength(1);
    expect(outcome!.results[0].confidence).toBe("low");
  });

  it("restricts dust recipients to the selected wallet scope", async () => {
    await seedVault(); // VICTIM in WalletA
    await createRecord({
      type: "address",
      inputString: LEGACY_VICTIM,
      label: "Other wallet victim",
      tags: [],
      categories: [],
      walletName: "WalletB",
    });
    await bulkAddParticipants([
      { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
      { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 600 },
      { txid: TXID_DUST2, role: "output", address: LEGACY_VICTIM, amount: 546, vout: 0 },
      { txid: TXID_DUST2, role: "input", address: LEGACY_LOOKALIKE, amount: 600 },
    ]);

    const outcome = await scanAddressPoisoning(
      "wallet",
      "WalletA",
      { dustThresholdSats: 1000, matchLength: 4 },
      neverAborted,
      noopProgress,
    );
    expect(outcome!.results).toHaveLength(1);
    expect(outcome!.results[0].dustRecipient).toBe(VICTIM);
    expect(outcome!.scannedAddresses.has(VICTIM)).toBe(true);
    expect(outcome!.scannedAddresses.has(LEGACY_VICTIM)).toBe(false);
  });

  it("returns null when cancelled", async () => {
    await seedVault();
    const ctrl = new AbortController();
    ctrl.abort();
    const outcome = await scanAddressPoisoning(
      "all",
      "",
      { dustThresholdSats: 1000, matchLength: 4 },
      ctrl.signal,
      noopProgress,
    );
    expect(outcome).toBeNull();
  });
});
