// Severity-tier pinning for every privacy finding type emitted by the detectors.
//
// Task #883 pinned the per-severity PENALTY SIZES (first + subsequent for
// LOW/MEDIUM/HIGH/CRITICAL). But the privacy score also depends on WHICH
// severity tier each finding type is assigned inside the detectors in
// runPrivacyAudit. If a detector's severity silently drifts — e.g. ADDRESS_REUSE
// downgraded from HIGH, or the PROXIMITY hop→severity mapping shifts — every
// affected wallet's score and letter grade would move with no test failing.
//
// These tests drive each detector directly with a hand-built AuditContext (no
// Dexie, no React) and assert the exact severity tier of the emitted finding,
// so any silent type→severity reassignment fails a test. This is the companion
// to privacy-audit.computeScore.test.ts: that file pins severity→penalty, this
// file pins type→severity.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  detectScriptTypeMixing,
  detectDustUTXOs,
  detectDustSpending,
  detectConsolidationOrigin,
  detectExchangeOrigin,
  detectTaintedUTXOMerge,
  detectAddressReuse,
  detectRoundAmounts,
  detectCommonInputOwnership,
  detectUnnecessaryInput,
  detectHighActivity,
  detectOpReturn,
  detectMultisigEscrow,
  detectUTXOSetExposure,
  detectCoinJoin,
  detectPostMixSpending,
  detectPeelChain,
  detectEntityContacts,
  detectEntityProximity,
  detectFingerprintingIssues,
  detectRecurringPayments,
  detectCoinbaseOrigin,
  type AuditContext,
  type PrivacyFinding,
} from "./privacy-audit";
import {
  setActiveEntityList,
  resetActiveEntityList,
  type EntityEntry,
} from "./privacy-entity-list";
import type {
  TransactionParticipant,
  BlockchainTransaction,
  ScriptType,
} from "./db-types";

// ─── Fixture builders ─────────────────────────────────────────────────────────

let pid = 0;

interface PartSpec {
  txid: string;
  role: "input" | "output";
  address: string;
  amount?: number;
  vout?: number;
  prevTxid?: string;
  prevVout?: number;
  scriptType?: ScriptType;
}

function mkPart(spec: PartSpec): TransactionParticipant {
  return {
    id: ++pid,
    txid: spec.txid,
    role: spec.role,
    address: spec.address,
    amount: spec.amount ?? 1000,
    vout: spec.vout,
    prevTxid: spec.prevTxid,
    prevVout: spec.prevVout,
    scriptType: spec.scriptType,
  };
}

/**
 * Assemble an AuditContext from a flat participant list, the owned-address set,
 * and an optional map of transaction-level metadata (used by OP_RETURN /
 * fingerprinting / coinbase detectors). Participants are grouped into
 * participantsByTxid in insertion order so detectors that rely on iteration
 * order (e.g. peel-chain) behave deterministically.
 */
function makeCtx(
  parts: TransactionParticipant[],
  owned: string[],
  transactions: Map<string, BlockchainTransaction> = new Map(),
): AuditContext {
  const participantsByTxid = new Map<string, TransactionParticipant[]>();
  for (const p of parts) {
    const list = participantsByTxid.get(p.txid);
    if (list) list.push(p);
    else participantsByTxid.set(p.txid, [p]);
  }
  return {
    userAddresses: new Set(owned),
    participants: parts,
    participantsByTxid,
    transactions,
  };
}

function tx(
  txid: string,
  extra: Partial<BlockchainTransaction> = {},
): [string, BlockchainTransaction] {
  return [
    txid,
    {
      txid,
      blockHeight: 800_000,
      blockTime: 1_700_000_000,
      fee: 1_000,
      feeRate: 5,
      syncedAt: 0,
      ...extra,
    },
  ];
}

function severityOf(
  findings: PrivacyFinding[],
  type: PrivacyFinding["type"],
): PrivacySeverityOrUndefined {
  return findings.find((f) => f.type === type)?.severity;
}

type PrivacySeverityOrUndefined = PrivacyFinding["severity"] | undefined;

const A1 = "bc1qowned1000000000000000000000000000000000a1";
const A2 = "bc1qowned2000000000000000000000000000000000a2";
const A3 = "bc1qowned3000000000000000000000000000000000a3";
const EXT = "bc1qexternal0000000000000000000000000000000ex";

beforeEach(() => {
  pid = 0;
});

// ─── Behavioural / structural detectors ───────────────────────────────────────

describe("privacy finding type → severity tier", () => {
  it("ADDRESS_REUSE is HIGH (single biggest privacy risk)", () => {
    // A1 is received in tx1 (output) and later spent in tx2 (input): reuse.
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "output", address: A1, vout: 0 }),
        mkPart({ txid: "t2", role: "input", address: A1 }),
      ],
      [A1],
    );
    expect(severityOf(detectAddressReuse(ctx), "ADDRESS_REUSE")).toBe("HIGH");
  });

  it("SCRIPT_TYPE_MIXING is HIGH", () => {
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "input", address: A1, scriptType: "v0_p2wpkh" }),
        mkPart({ txid: "t1", role: "input", address: A2, scriptType: "p2pkh" }),
      ],
      [A1, A2],
    );
    expect(severityOf(detectScriptTypeMixing(ctx), "SCRIPT_TYPE_MIXING")).toBe(
      "HIGH",
    );
  });

  it("DUST_SPENDING is HIGH", () => {
    // A dust input (≤1000 sats) co-spent with a normal input actively links them.
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "input", address: A1, amount: 500 }),
        mkPart({ txid: "t1", role: "input", address: A2, amount: 50_000 }),
      ],
      [A1, A2],
    );
    expect(severityOf(detectDustSpending(ctx), "DUST_SPENDING")).toBe("HIGH");
  });

  it("TAINTED_UTXO_MERGE is HIGH", () => {
    // Two owned input addresses from two different funding txids merged in one tx.
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "input", address: A1, prevTxid: "fund-a" }),
        mkPart({ txid: "t1", role: "input", address: A2, prevTxid: "fund-b" }),
      ],
      [A1, A2],
    );
    expect(severityOf(detectTaintedUTXOMerge(ctx), "TAINTED_UTXO_MERGE")).toBe(
      "HIGH",
    );
  });

  it("DUST current unspent below the relay threshold is CRITICAL", () => {
    // ≤546 sats unspent → likely dust attack → CRITICAL.
    const ctx = makeCtx(
      [mkPart({ txid: "t1", role: "output", address: A1, amount: 500, vout: 0 })],
      [A1],
    );
    expect(severityOf(detectDustUTXOs(ctx).findings, "DUST")).toBe("CRITICAL");
  });

  it("DUST current unspent above the relay threshold is MEDIUM", () => {
    // 547..1000 sats unspent → tracking vector but not a relay-threshold attack.
    const ctx = makeCtx(
      [mkPart({ txid: "t1", role: "output", address: A1, amount: 800, vout: 0 })],
      [A1],
    );
    expect(severityOf(detectDustUTXOs(ctx).findings, "DUST")).toBe("MEDIUM");
  });

  it("DUST historical (already-spent) receipt is a LOW warning", () => {
    // A dust output that has since been spent surfaces as a LOW warning, not a
    // finding. t2 spends t1:0 (prevTxid/prevVout), marking the dust historical.
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "output", address: A1, amount: 500, vout: 0 }),
        mkPart({
          txid: "t2",
          role: "input",
          address: A1,
          amount: 500,
          prevTxid: "t1",
          prevVout: 0,
        }),
      ],
      [A1],
    );
    const { warnings } = detectDustUTXOs(ctx);
    expect(severityOf(warnings, "DUST")).toBe("LOW");
  });

  it("CONSOLIDATION_ORIGIN is MEDIUM", () => {
    // 3 owned inputs → 1 output: a consolidation linking all input addresses.
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "input", address: A1, amount: 10_000 }),
        mkPart({ txid: "t1", role: "input", address: A2, amount: 10_000 }),
        mkPart({ txid: "t1", role: "input", address: A3, amount: 10_000 }),
        mkPart({ txid: "t1", role: "output", address: A1, amount: 29_000, vout: 0 }),
      ],
      [A1, A2, A3],
    );
    expect(
      severityOf(detectConsolidationOrigin(ctx), "CONSOLIDATION_ORIGIN"),
    ).toBe("MEDIUM");
  });

  it("COMMON_INPUT_OWNERSHIP is MEDIUM", () => {
    // Two owned addresses co-spent (no external inputs) → CIOH clustering.
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "input", address: A1, amount: 10_000 }),
        mkPart({ txid: "t1", role: "input", address: A2, amount: 10_000 }),
      ],
      [A1, A2],
    );
    expect(
      severityOf(
        detectCommonInputOwnership(ctx, new Set(), new Set()),
        "COMMON_INPUT_OWNERSHIP",
      ),
    ).toBe("MEDIUM");
  });

  it("HIGH_ACTIVITY is MEDIUM", () => {
    // One owned address appearing in 50 distinct transactions.
    const parts: TransactionParticipant[] = [];
    for (let i = 0; i < 50; i++) {
      parts.push(mkPart({ txid: `ha${i}`, role: "output", address: A1, vout: 0 }));
    }
    expect(severityOf(detectHighActivity(makeCtx(parts, [A1])), "HIGH_ACTIVITY")).toBe(
      "MEDIUM",
    );
  });

  it("UTXO_SET_EXPOSURE is MEDIUM", () => {
    // 10 distinct unspent owned output addresses → fragmented UTXO set.
    const parts: TransactionParticipant[] = [];
    const owned: string[] = [];
    for (let i = 0; i < 10; i++) {
      const addr = `bc1qutxo${i}00000000000000000000000000000000000u`;
      owned.push(addr);
      parts.push(mkPart({ txid: `u${i}`, role: "output", address: addr, vout: 0 }));
    }
    expect(
      severityOf(detectUTXOSetExposure(makeCtx(parts, owned)), "UTXO_SET_EXPOSURE"),
    ).toBe("MEDIUM");
  });

  it("PEEL_CHAIN is MEDIUM", () => {
    // Four consecutive peel transactions: each has 2 outputs, exactly one owned
    // (the smaller change), and spends the previous tx's change.
    const parts: TransactionParticipant[] = [];
    const changeAddrs = [A1, A2, A3, "bc1qpeel4000000000000000000000000000000000p4"];
    const prev = [undefined, "p1", "p2", "p3"];
    const ids = ["p1", "p2", "p3", "p4"];
    for (let i = 0; i < ids.length; i++) {
      parts.push(
        mkPart({
          txid: ids[i],
          role: "input",
          address: changeAddrs[i],
          amount: 100_000,
          prevTxid: prev[i],
          prevVout: 0,
        }),
      );
      // External recipient (larger) + owned change (smaller).
      parts.push(mkPart({ txid: ids[i], role: "output", address: EXT, amount: 90_000, vout: 0 }));
      parts.push(
        mkPart({ txid: ids[i], role: "output", address: changeAddrs[i], amount: 9_000, vout: 1 }),
      );
    }
    const ctx = makeCtx(parts, changeAddrs);
    expect(severityOf(detectPeelChain(ctx, new Set()), "PEEL_CHAIN")).toBe("MEDIUM");
  });

  it("ROUND_AMOUNT is LOW", () => {
    const ctx = makeCtx(
      [mkPart({ txid: "t1", role: "output", address: A1, amount: 1_000_000, vout: 0 })],
      [A1],
    );
    expect(severityOf(detectRoundAmounts(ctx, new Set()), "ROUND_AMOUNT")).toBe("LOW");
  });

  it("UNNECESSARY_INPUT is LOW", () => {
    // The largest owned input alone covers the output + fee; the second
    // (negligible) input was unnecessary. Two owned inputs are required to flag.
    const ctx = makeCtx(
      [
        mkPart({ txid: "t1", role: "input", address: A1, amount: 100_000 }),
        mkPart({ txid: "t1", role: "input", address: A2, amount: 0 }),
        mkPart({ txid: "t1", role: "output", address: EXT, amount: 90_000, vout: 0 }),
      ],
      [A1, A2],
    );
    expect(severityOf(detectUnnecessaryInput(ctx, new Set()), "UNNECESSARY_INPUT")).toBe(
      "LOW",
    );
  });

  it("MULTISIG_ESCROW is LOW", () => {
    const ctx = makeCtx(
      [mkPart({ txid: "t1", role: "input", address: A1, scriptType: "p2sh" })],
      [A1],
    );
    expect(
      severityOf(detectMultisigEscrow(ctx).findings, "MULTISIG_ESCROW"),
    ).toBe("LOW");
  });

  it("EXCHANGE_ORIGIN is a LOW warning", () => {
    // ≥5 outputs with ≥10 outputs and ≥5 unique recipients (2 signals), an owned
    // receive output, and no owned inputs (receive-only) → batch-withdrawal warning.
    const parts: TransactionParticipant[] = [];
    for (let i = 0; i < 10; i++) {
      const addr = i === 0 ? A1 : `bc1qrcpt${i}00000000000000000000000000000000000r`;
      parts.push(mkPart({ txid: "t1", role: "output", address: addr, amount: 10_000, vout: i }));
    }
    const { warnings } = detectExchangeOrigin(makeCtx(parts, [A1]));
    expect(severityOf(warnings, "EXCHANGE_ORIGIN")).toBe("LOW");
  });
});

// ─── CoinJoin (privacy-positive, but the tier still feeds the waterfall) ───────

describe("CoinJoin finding type → severity tier", () => {
  it("COINJOIN_WHIRLPOOL is LOW", () => {
    // Exactly 5 equal outputs in a known pool denomination (0.001 BTC).
    const parts: TransactionParticipant[] = [];
    for (let i = 0; i < 5; i++) {
      const addr = i === 0 ? A1 : `bc1qwp${i}0000000000000000000000000000000000000w`;
      parts.push(mkPart({ txid: "cj", role: "output", address: addr, amount: 100_000, vout: i }));
    }
    expect(severityOf(detectCoinJoin(makeCtx(parts, [A1])).whirlpool, "COINJOIN_WHIRLPOOL")).toBe(
      "LOW",
    );
  });

  it("COINJOIN_WASABI is LOW", () => {
    // 20+ inputs and 20+ outputs with clustered (mostly equal) denominations.
    const parts: TransactionParticipant[] = [];
    for (let i = 0; i < 22; i++) {
      const addr = i === 0 ? A1 : `bc1qwsi${i}0000000000000000000000000000000000ws`;
      parts.push(mkPart({ txid: "cj", role: "input", address: addr, amount: 1_000_000 }));
    }
    for (let i = 0; i < 22; i++) {
      const addr = i === 0 ? A1 : `bc1qwso${i}0000000000000000000000000000000000ws`;
      parts.push(mkPart({ txid: "cj", role: "output", address: addr, amount: 500_000, vout: i }));
    }
    expect(severityOf(detectCoinJoin(makeCtx(parts, [A1])).wasabi, "COINJOIN_WASABI")).toBe(
      "LOW",
    );
  });

  it("COINJOIN_JOINMARKET is LOW", () => {
    // 2+ inputs (ours + external), 3+ outputs with an equal pair above 10k sats.
    const ctx = makeCtx(
      [
        mkPart({ txid: "cj", role: "input", address: A1, amount: 200_000 }),
        mkPart({ txid: "cj", role: "input", address: EXT, amount: 200_000 }),
        mkPart({ txid: "cj", role: "output", address: A1, amount: 50_000, vout: 0 }),
        mkPart({ txid: "cj", role: "output", address: EXT, amount: 50_000, vout: 1 }),
        mkPart({ txid: "cj", role: "output", address: A2, amount: 30_000, vout: 2 }),
      ],
      [A1, A2],
    );
    expect(severityOf(detectCoinJoin(ctx).joinmarket, "COINJOIN_JOINMARKET")).toBe("LOW");
  });
});

// ─── Post-mix spending: conditional HIGH vs MEDIUM ────────────────────────────

describe("POST_MIX_SPENDING conditional severity", () => {
  const CJADDR = "bc1qcjout00000000000000000000000000000000000c";

  it("is HIGH when a post-mix UTXO is co-spent with non-mixed coins", () => {
    const ctx = makeCtx(
      [
        // CoinJoin output we own.
        mkPart({ txid: "cj", role: "output", address: CJADDR, vout: 0 }),
        // Later spend: post-mix input + an unmixed owned input → linkage.
        mkPart({ txid: "spend", role: "input", address: CJADDR }),
        mkPart({ txid: "spend", role: "input", address: A1 }),
      ],
      [CJADDR, A1],
    );
    expect(
      severityOf(detectPostMixSpending(ctx, new Set(["cj"])), "POST_MIX_SPENDING"),
    ).toBe("HIGH");
  });

  it("is MEDIUM when a post-mix UTXO is spent without co-spending unmixed coins", () => {
    const ctx = makeCtx(
      [
        mkPart({ txid: "cj", role: "output", address: CJADDR, vout: 0 }),
        mkPart({ txid: "spend", role: "input", address: CJADDR }),
      ],
      [CJADDR],
    );
    expect(
      severityOf(detectPostMixSpending(ctx, new Set(["cj"])), "POST_MIX_SPENDING"),
    ).toBe("MEDIUM");
  });
});

// ─── Transaction-level detectors (OP_RETURN / fingerprinting / coinbase) ───────

describe("transaction-metadata finding type → severity tier", () => {
  it("OP_RETURN_METADATA is LOW", () => {
    const ctx = makeCtx(
      [mkPart({ txid: "t1", role: "output", address: A1, vout: 0 })],
      [A1],
      new Map([
        tx("t1", {
          hasOpReturn: true,
          opReturnData: [{ vout: 1, dataHex: "68656c6c6f", dataText: "hello" }],
        }),
      ]),
    );
    expect(severityOf(detectOpReturn(ctx), "OP_RETURN_METADATA")).toBe("LOW");
  });

  it("COINBASE_ORIGIN is LOW", () => {
    const ctx = makeCtx(
      [mkPart({ txid: "t1", role: "output", address: A1, vout: 0 })],
      [A1],
      new Map([tx("t1", { hasCoinbaseInput: true })]),
    );
    expect(severityOf(detectCoinbaseOrigin(ctx), "COINBASE_ORIGIN")).toBe("LOW");
  });

  it("RECURRING_PAYMENT is LOW", () => {
    // The same external recipient appears as an output in 3 distinct txs.
    const parts: TransactionParticipant[] = [];
    for (let i = 0; i < 3; i++) {
      parts.push(mkPart({ txid: `r${i}`, role: "output", address: EXT, vout: 0 }));
    }
    expect(severityOf(detectRecurringPayments(makeCtx(parts, [A1])), "RECURRING_PAYMENT")).toBe(
      "LOW",
    );
  });

  it("every FINGERPRINT_* type is LOW", () => {
    // A single fully-captured tx exhibiting every fingerprintable anomaly.
    const ctx = makeCtx(
      [mkPart({ txid: "t1", role: "output", address: A1, vout: 0 })],
      [A1],
      new Map([
        tx("t1", {
          blockHeight: 0,
          rawFingerprintCaptured: true,
          nVersion: 1,
          nLockTime: 123_456_789,
          hasRbf: false,
          isBip69Ordered: false,
          hasLowRSig: false,
          hasMixedWitness: true,
        }),
      ]),
    );
    const { findings } = detectFingerprintingIssues(ctx);
    const fpTypes: PrivacyFinding["type"][] = [
      "FINGERPRINT_NVERSION",
      "FINGERPRINT_NLOCKTIME",
      "FINGERPRINT_RBF",
      "FINGERPRINT_BIP69",
      "FINGERPRINT_LOW_R",
      "FINGERPRINT_WITNESS_INCONSISTENCY",
    ];
    for (const type of fpTypes) {
      expect(severityOf(findings, type), `${type} should be LOW`).toBe("LOW");
    }
  });
});

// ─── Entity contacts: severity is driven by the entity CATEGORY ───────────────

describe("entity-contact severity per category", () => {
  // Distinct external addresses, one per category, each touched by an owned tx.
  const ENTITY_BY_CATEGORY: Record<string, string> = {
    exchange: "bc1qent-exchange",
    "payment-service": "bc1qent-payment",
    gambling: "bc1qent-gambling",
    scam: "bc1qent-scam",
    darknet: "bc1qent-darknet",
    "mining-pool": "bc1qent-mining",
    mixer: "bc1qent-mixer",
    "p2p-exchange": "bc1qent-p2p",
  };

  // category → (expected severity, expected emitted finding type)
  const EXPECTED: Array<[string, PrivacyFinding["severity"], PrivacyFinding["type"]]> = [
    ["exchange", "MEDIUM", "ENTITY_EXCHANGE"],
    ["payment-service", "LOW", "ENTITY_EXCHANGE"],
    ["gambling", "MEDIUM", "ENTITY_GAMBLING"],
    ["scam", "CRITICAL", "ENTITY_SCAM"],
    ["darknet", "CRITICAL", "ENTITY_DARKNET"],
    ["mining-pool", "LOW", "ENTITY_MINING_POOL"],
    ["mixer", "LOW", "ENTITY_MIXER"],
    ["p2p-exchange", "LOW", "ENTITY_P2P"],
  ];

  beforeEach(() => {
    const entries: EntityEntry[] = Object.entries(ENTITY_BY_CATEGORY).map(
      ([category, address]) => ({
        address,
        name: `Test ${category}`,
        category: category as EntityEntry["category"],
        sourceNote: "test fixture",
      }),
    );
    setActiveEntityList(entries);
  });

  afterEach(() => {
    resetActiveEntityList();
  });

  it("assigns the pinned severity tier to each entity category", () => {
    // One tx per category linking an owned address to the entity address.
    const parts: TransactionParticipant[] = [];
    let i = 0;
    for (const address of Object.values(ENTITY_BY_CATEGORY)) {
      parts.push(mkPart({ txid: `e${i}`, role: "input", address: A1 }));
      parts.push(mkPart({ txid: `e${i}`, role: "output", address, vout: 0 }));
      i++;
    }
    const findings = detectEntityContacts(makeCtx(parts, [A1]));

    for (const [category, severity, type] of EXPECTED) {
      const finding = findings.find(
        (f) => (f.details as { category?: string }).category === category,
      );
      expect(finding, `expected a finding for category ${category}`).toBeTruthy();
      expect(finding!.type, `${category} finding type`).toBe(type);
      expect(finding!.severity, `${category} severity`).toBe(severity);
    }
  });
});

// ─── Proximity: severity is driven by HOP DISTANCE ────────────────────────────
//
// privacy-audit.proximity.test.ts already exercises the BFS engine in depth.
// This concise re-pin guards the hop→severity mapping itself so a silent shift
// (e.g. demoting hop-2 from HIGH) fails here too, alongside the score-impact
// coverage in privacy-audit.e2e-proximity.test.ts.

describe("proximity severity per hop distance", () => {
  const OWNED = "owned-proximity-1";
  const ENTITY = "exchange-proximity-entity";

  beforeEach(() => {
    setActiveEntityList([
      { address: ENTITY, name: "Test Exchange", category: "exchange", sourceNote: "test" },
    ]);
  });

  afterEach(() => {
    resetActiveEntityList();
  });

  // hop distance → expected pinned severity
  const HOPS: Array<[number, PrivacyFinding["severity"]]> = [
    [2, "HIGH"],
    [3, "MEDIUM"],
    [4, "LOW"],
  ];

  for (const [hop, severity] of HOPS) {
    it(`hop-${hop} proximity is ${severity}`, () => {
      // Build a chain OWNED → I1 → ... → ENTITY spanning `hop` transactions.
      const txs: Record<string, string[]> = {};
      let from = OWNED;
      for (let h = 1; h <= hop; h++) {
        const to = h === hop ? ENTITY : `mid-${hop}-${h}`;
        txs[`tx-${hop}-${h}`] = [from, to];
        from = to;
      }
      const parts: TransactionParticipant[] = [];
      for (const [txid, addrs] of Object.entries(txs)) {
        for (const addr of addrs) {
          parts.push(mkPart({ txid, role: "output", address: addr, vout: 0 }));
        }
      }
      const findings = detectEntityProximity(makeCtx(parts, [OWNED]));
      const finding = findings.find((f) => f.type === "PROXIMITY_EXCHANGE");
      expect(finding, `expected a hop-${hop} proximity finding`).toBeTruthy();
      expect(finding!.details.hopDistance).toBe(hop);
      expect(finding!.severity).toBe(severity);
    });
  }
});
