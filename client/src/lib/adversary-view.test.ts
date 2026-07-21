/**
 * Unit tests for the adversary-view engine.
 *
 * Uses runAdversaryViewFromContext (the testable variant that accepts a
 * pre-built AdversaryContext) so tests can inject synthetic data without
 * hitting Dexie. getRecordsByInputStrings is mocked to supply record fixtures.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TransactionParticipant, BlockchainTransaction } from "@/lib/db-types";

// ── Mock DB-dependent imports before importing the module under test ───────────
vi.mock("@/lib/database", () => ({
  db: {
    transactionParticipants: { where: vi.fn() },
  },
}));

vi.mock("@/lib/data/record-queries", () => ({
  getParticipantsByAddresses: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByInputStrings: vi.fn(),
}));

import { getRecordsByInputStrings } from "@/lib/data/record-crud";
import { runAdversaryViewFromContext } from "./adversary-view";
import type { AdversaryViewResult } from "./adversary-view";

// ── Type for the internal context accepted by runAdversaryViewFromContext ──────
interface AdversaryContext {
  userAddresses: Set<string>;
  participantsByTxid: Map<string, TransactionParticipant[]>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePart(
  txid: string,
  role: "input" | "output",
  address: string,
  amount = 100_000,
): TransactionParticipant {
  return {
    id: undefined,
    txid,
    role,
    address,
    amount,
    vout: role === "output" ? 0 : undefined,
    prevTxid: role === "input" ? "prev" : undefined,
    prevVout: role === "input" ? 0 : undefined,
  } as unknown as TransactionParticipant;
}

function makeCtx(
  userAddresses: string[],
  participantsByTxid: Map<string, TransactionParticipant[]>,
): AdversaryContext {
  return {
    userAddresses: new Set(userAddresses),
    participantsByTxid,
  };
}

function makeRecord(
  inputString: string,
  opts: {
    chainType?: "receive" | "change";
    xpub?: string;
    acquisitionMethod?: string;
    counterpartyName?: string;
  } = {},
) {
  return {
    id: 1,
    type: "address" as const,
    inputString,
    label: "",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
    ...opts,
  };
}

const mockGetRecords = getRecordsByInputStrings as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGetRecords.mockReset();
  mockGetRecords.mockResolvedValue([]);
});

// ── Exposure: CIO clustering ──────────────────────────────────────────────────

describe("Exposure — common-input-ownership clustering", () => {
  it("produces one exposure finding when two owned addresses co-appear as inputs", async () => {
    const A = "bc1qaaaaaaaa0000000000000000000000000000aa";
    const B = "bc1qbbbbbbbb0000000000000000000000000000bb";

    const byTxid = new Map([
      [
        "tx1",
        [
          makePart("tx1", "input", A),
          makePart("tx1", "input", B),
          makePart("tx1", "output", "bc1qexternal000000000000000000000000000ext"),
        ],
      ],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    mockGetRecords.mockResolvedValue([makeRecord(A), makeRecord(B)]);

    const result: AdversaryViewResult = await runAdversaryViewFromContext(ctx);

    expect(result.exposureFindings).toHaveLength(1);
    const f = result.exposureFindings[0];
    expect(f.category).toBe("exposure");
    expect(f.confidence).toBe("certain");
    expect(f.txids).toContain("tx1");
    expect(f.addresses).toContain(A);
    expect(f.addresses).toContain(B);
    expect(result.summary.exposureCount).toBe(1);
    expect(result.summary.addressesExposed).toBe(2);
  });

  it("groups three co-spent owned addresses into one exposure cluster", async () => {
    const A = "bc1qaaaa0000000000000000000000000000000aa1";
    const B = "bc1qbbbb0000000000000000000000000000000bb2";
    const C = "bc1qcccc0000000000000000000000000000000cc3";

    const byTxid = new Map([
      [
        "tx2",
        [
          makePart("tx2", "input", A),
          makePart("tx2", "input", B),
          makePart("tx2", "input", C),
          makePart("tx2", "output", "bc1qext"),
        ],
      ],
    ]);

    const ctx = makeCtx([A, B, C], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(A),
      makeRecord(B),
      makeRecord(C),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.exposureFindings).toHaveLength(1);
    expect(result.exposureFindings[0].addresses).toHaveLength(3);
    expect(result.summary.addressesExposed).toBe(3);
  });

  it("produces no exposure finding when owned addresses are never co-spent", async () => {
    const A = "bc1qaaaa0000000000000000000000000000000aa1";
    const B = "bc1qbbbb0000000000000000000000000000000bb2";

    const byTxid = new Map([
      ["txA", [makePart("txA", "input", A), makePart("txA", "output", "ext1")]],
      ["txB", [makePart("txB", "input", B), makePart("txB", "output", "ext2")]],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    mockGetRecords.mockResolvedValue([makeRecord(A), makeRecord(B)]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.exposureFindings).toHaveLength(0);
    expect(result.summary.exposureCount).toBe(0);
  });
});

// ── Preserved separation ──────────────────────────────────────────────────────

describe("Preserved separation", () => {
  it("produces a separation finding when two address groups share no co-spend", async () => {
    const A = "bc1qaaaa0000000000000000000000000000000aa1";
    const B = "bc1qbbbb0000000000000000000000000000000bb2";

    const byTxid = new Map([
      ["txA", [makePart("txA", "input", A), makePart("txA", "output", "ext1")]],
      ["txB", [makePart("txB", "input", B), makePart("txB", "output", "ext2")]],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    // Different xpubs → two wallet groups
    mockGetRecords.mockResolvedValue([
      makeRecord(A, { xpub: "xpub1111" }),
      makeRecord(B, { xpub: "xpub2222" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.separationFindings.length).toBeGreaterThan(0);
    const f = result.separationFindings[0];
    expect(f.category).toBe("preserved-separation");
    expect(f.addresses).toContain(A);
    expect(f.addresses).toContain(B);
  });

  it("produces no separation finding when all owned addresses are in the same wallet group", async () => {
    const A = "bc1qaaaa0000000000000000000000000000000aa1";
    const B = "bc1qbbbb0000000000000000000000000000000bb2";

    const byTxid = new Map([
      ["txA", [makePart("txA", "input", A), makePart("txA", "output", "ext")]],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    // Same xpub → one wallet group → no pair to compare
    mockGetRecords.mockResolvedValue([
      makeRecord(A, { xpub: "xpub_shared" }),
      makeRecord(B, { xpub: "xpub_shared" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.separationFindings).toHaveLength(0);
  });

  it("produces no separation finding for manually-added addresses with no xpub", async () => {
    // Two separate addresses that were never co-spent, but neither has an xpub.
    // Without descriptor/xpub data we cannot prove they are different wallets,
    // so no separation claim should be emitted.
    const A = "bc1qaaaa0000000000000000000000000000000aa1";
    const B = "bc1qbbbb0000000000000000000000000000000bb2";

    const byTxid = new Map([
      ["txA", [makePart("txA", "input", A), makePart("txA", "output", "ext1")]],
      ["txB", [makePart("txB", "input", B), makePart("txB", "output", "ext2")]],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    // No xpub on either record → cannot verify they belong to different wallets
    mockGetRecords.mockResolvedValue([makeRecord(A), makeRecord(B)]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.separationFindings).toHaveLength(0);
    expect(result.summary.separationCount).toBe(0);
  });
});

// ── Protective confusion ──────────────────────────────────────────────────────

describe("Protective confusion — change-guess heuristic", () => {
  it("detects confusion when adversary guesses change but chainType says receive", async () => {
    const ownedReceive = "bc1qrrrr0000000000000000000000000000000rr1";
    const extPayment = "bc1qpppp0000000000000000000000000000000pp2";

    const byTxid = new Map([
      [
        "txConfuse",
        [
          makePart("txConfuse", "input", "bc1qinput000000000000000000000000000000in"),
          // smaller output = adversary's guessed change, but it is actually a receive
          makePart("txConfuse", "output", ownedReceive, 50_000),
          makePart("txConfuse", "output", extPayment, 200_000),
        ],
      ],
    ]);

    const ctx = makeCtx([ownedReceive], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(ownedReceive, { chainType: "receive" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(1);
    const f = result.confusionFindings[0];
    expect(f.category).toBe("protective-confusion");
    expect(f.confidence).toBe("likely");
    expect(f.txids).toContain("txConfuse");
    expect(f.addresses).toContain(ownedReceive);
    expect(f.groundTruthAvailable).toBe(true);
  });

  it("detects confusion when adversary guesses payment but chainType says change", async () => {
    const ownedChange = "bc1qchng0000000000000000000000000000000ch1";
    const extAddr = "bc1qsmll0000000000000000000000000000000sm2";

    const byTxid = new Map([
      [
        "txChange",
        [
          makePart("txChange", "input", "bc1qinp00000000000000000000000000000000in"),
          // adversary guesses the smaller (extAddr) is change; our larger output IS the change
          makePart("txChange", "output", extAddr, 30_000),
          makePart("txChange", "output", ownedChange, 180_000),
        ],
      ],
    ]);

    const ctx = makeCtx([ownedChange], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(ownedChange, { chainType: "change" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(1);
    const f = result.confusionFindings[0];
    expect(f.category).toBe("protective-confusion");
    expect(f.addresses).toContain(ownedChange);
  });

  it("produces no confusion finding when tx has more than 2 outputs", async () => {
    const owned = "bc1qown000000000000000000000000000000000o1";

    const byTxid = new Map([
      [
        "txMulti",
        [
          makePart("txMulti", "input", "bc1qinp0"),
          makePart("txMulti", "output", owned, 50_000),
          makePart("txMulti", "output", "bc1qext1", 100_000),
          makePart("txMulti", "output", "bc1qext2", 80_000),
        ],
      ],
    ]);

    const ctx = makeCtx([owned], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(owned, { chainType: "receive" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(0);
  });

  it("produces no confusion finding when chainType data is absent", async () => {
    const owned = "bc1qnoct0000000000000000000000000000000no";

    const byTxid = new Map([
      [
        "txNoCT",
        [
          makePart("txNoCT", "input", "bc1qinp0"),
          makePart("txNoCT", "output", owned, 40_000),
          makePart("txNoCT", "output", "bc1qext1", 90_000),
        ],
      ],
    ]);

    const ctx = makeCtx([owned], byTxid);
    // Record has no chainType
    mockGetRecords.mockResolvedValue([makeRecord(owned)]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(0);
  });
});

// ── Protective confusion: script-type heuristic ───────────────────────────────

describe("Protective confusion — script-type matching heuristic", () => {
  it("upgrades confidence to certain when script-type and amount guesses agree", async () => {
    const ownedReceive = "bc1qagree000000000000000000000000000000rr1"; // P2WPKH, matches inputs
    const extPayment = "1PaymentP2pkhAddress0000000000000pp"; // P2PKH, differs

    const byTxid = new Map([
      [
        "txAgree",
        [
          makePart("txAgree", "input", "bc1qin1000000000000000000000000000000000i1"),
          makePart("txAgree", "input", "bc1qin2000000000000000000000000000000000i2"),
          // smaller AND P2WPKH-matching output → both heuristics say change,
          // but ground truth says receive → confusion at "certain" tier
          makePart("txAgree", "output", ownedReceive, 50_000),
          makePart("txAgree", "output", extPayment, 200_000),
        ],
      ],
    ]);

    const ctx = makeCtx([ownedReceive], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(ownedReceive, { chainType: "receive" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(1);
    expect(result.confusionFindings[0].confidence).toBe("certain");
  });

  it("downgrades confidence to speculative when script-type and amount guesses disagree", async () => {
    const ownedReceive = "1OwnedP2pkhReceiveAddr0000000000000oo"; // P2PKH, differs from inputs
    const extLarger = "bc1qextlarger00000000000000000000000000ex1"; // P2WPKH, matches inputs

    const byTxid = new Map([
      [
        "txDisagree",
        [
          makePart("txDisagree", "input", "bc1qin1000000000000000000000000000000000i1"),
          makePart("txDisagree", "input", "bc1qin2000000000000000000000000000000000i2"),
          // amount heuristic: smaller owned P2PKH output = change
          // script heuristic: larger P2WPKH output matches inputs = change
          makePart("txDisagree", "output", ownedReceive, 50_000),
          makePart("txDisagree", "output", extLarger, 200_000),
        ],
      ],
    ]);

    const ctx = makeCtx([ownedReceive], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(ownedReceive, { chainType: "receive" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(1);
    expect(result.confusionFindings[0].confidence).toBe("speculative");
  });

  it("keeps confidence at likely when both outputs share the input script type (no signal)", async () => {
    const ownedReceive = "bc1qnosig000000000000000000000000000000ns1";
    const extPayment = "bc1qnosigext0000000000000000000000000000e2";

    const byTxid = new Map([
      [
        "txNoSignal",
        [
          makePart("txNoSignal", "input", "bc1qin1000000000000000000000000000000000i1"),
          makePart("txNoSignal", "output", ownedReceive, 50_000),
          makePart("txNoSignal", "output", extPayment, 200_000),
        ],
      ],
    ]);

    const ctx = makeCtx([ownedReceive], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(ownedReceive, { chainType: "receive" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(1);
    expect(result.confusionFindings[0].confidence).toBe("likely");
  });

  it("keeps confidence at likely when input script types are tied (no majority)", async () => {
    const ownedReceive = "bc1qtied0000000000000000000000000000000td1";
    const extPayment = "1TiedP2pkhPayment000000000000000000tp";

    const byTxid = new Map([
      [
        "txTied",
        [
          makePart("txTied", "input", "bc1qin1000000000000000000000000000000000i1"),
          makePart("txTied", "input", "1P2pkhInput000000000000000000000000in2"),
          makePart("txTied", "output", ownedReceive, 50_000),
          makePart("txTied", "output", extPayment, 200_000),
        ],
      ],
    ]);

    const ctx = makeCtx([ownedReceive], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(ownedReceive, { chainType: "receive" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(1);
    expect(result.confusionFindings[0].confidence).toBe("likely");
  });

  it("applies script-type confidence to the missed-change direction too", async () => {
    // Ground truth: the larger owned P2WPKH output IS the change.
    // Amount heuristic guesses the smaller P2PKH output is change (wrong),
    // and the script heuristic points at the owned P2WPKH output → disagree → speculative.
    const ownedChange = "bc1qchspec00000000000000000000000000000cs1";
    const extSmaller = "1SmallP2pkhExt0000000000000000000000se";

    const byTxid = new Map([
      [
        "txMissedChange",
        [
          makePart("txMissedChange", "input", "bc1qin1000000000000000000000000000000000i1"),
          makePart("txMissedChange", "input", "bc1qin2000000000000000000000000000000000i2"),
          makePart("txMissedChange", "output", extSmaller, 30_000),
          makePart("txMissedChange", "output", ownedChange, 180_000),
        ],
      ],
    ]);

    const ctx = makeCtx([ownedChange], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(ownedChange, { chainType: "change" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.confusionFindings).toHaveLength(1);
    expect(result.confusionFindings[0].confidence).toBe("speculative");
  });
});

// ── Context-merge warnings ────────────────────────────────────────────────────

describe("Context-merge warnings", () => {
  it("flags a tx that combines inputs from different acquisition methods", async () => {
    const A = "bc1qaaa000000000000000000000000000000000a1";
    const B = "bc1qbbb000000000000000000000000000000000b2";

    const byTxid = new Map([
      [
        "txMerge",
        [
          makePart("txMerge", "input", A),
          makePart("txMerge", "input", B),
          makePart("txMerge", "output", "bc1qext"),
        ],
      ],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(A, { acquisitionMethod: "mining" }),
      makeRecord(B, { acquisitionMethod: "purchase" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.contextMergeWarnings).toHaveLength(1);
    const w = result.contextMergeWarnings[0];
    expect(w.txid).toBe("txMerge");
    expect(w.narrative).toContain("mining");
    expect(w.narrative).toContain("purchase");
    expect(w.hasUnknownContext).toBe(false);
    expect(result.summary.contextMergeCount).toBe(1);
  });

  it("flags a tx that combines inputs from different counterparty names", async () => {
    const A = "bc1qaaa000000000000000000000000000000000a1";
    const B = "bc1qbbb000000000000000000000000000000000b2";

    const byTxid = new Map([
      [
        "txCP",
        [
          makePart("txCP", "input", A),
          makePart("txCP", "input", B),
          makePart("txCP", "output", "ext"),
        ],
      ],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(A, { counterpartyName: "Coinbase" }),
      makeRecord(B, { counterpartyName: "Kraken" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.contextMergeWarnings).toHaveLength(1);
    expect(result.contextMergeWarnings[0].narrative).toContain("Coinbase");
  });

  it("marks hasUnknownContext true when some inputs lack labels", async () => {
    const A = "bc1qaaa000000000000000000000000000000000a1";
    const B = "bc1qbbb000000000000000000000000000000000b2";
    const C = "bc1qccc000000000000000000000000000000000c3";

    const byTxid = new Map([
      [
        "txPartial",
        [
          makePart("txPartial", "input", A),
          makePart("txPartial", "input", B),
          makePart("txPartial", "input", C),
          makePart("txPartial", "output", "ext"),
        ],
      ],
    ]);

    const ctx = makeCtx([A, B, C], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(A, { acquisitionMethod: "mining" }),
      makeRecord(B, { acquisitionMethod: "purchase" }),
      makeRecord(C), // no context
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.contextMergeWarnings).toHaveLength(1);
    expect(result.contextMergeWarnings[0].hasUnknownContext).toBe(true);
  });

  it("does not flag a tx where all inputs have the same acquisition context", async () => {
    const A = "bc1qaaa000000000000000000000000000000000a1";
    const B = "bc1qbbb000000000000000000000000000000000b2";

    const byTxid = new Map([
      [
        "txSame",
        [
          makePart("txSame", "input", A),
          makePart("txSame", "input", B),
          makePart("txSame", "output", "ext"),
        ],
      ],
    ]);

    const ctx = makeCtx([A, B], byTxid);
    mockGetRecords.mockResolvedValue([
      makeRecord(A, { acquisitionMethod: "mining" }),
      makeRecord(B, { acquisitionMethod: "mining" }),
    ]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.contextMergeWarnings).toHaveLength(0);
  });
});

// ── Degradation note ──────────────────────────────────────────────────────────

describe("Ground-truth degradation note", () => {
  it("sets degradation to no-xpub-import when no addresses have chainType", async () => {
    const A = "bc1qaaa000000000000000000000000000000000a1";
    const byTxid = new Map([
      ["tx1", [makePart("tx1", "input", A), makePart("tx1", "output", "ext")]],
    ]);

    const ctx = makeCtx([A], byTxid);
    mockGetRecords.mockResolvedValue([makeRecord(A)]); // no chainType

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.degradation).not.toBeNull();
    expect(result.degradation?.reason).toBe("no-xpub-import");
    expect(result.chainTypeCoverage).toBe(0);
  });

  it("reports full chainType coverage when all addresses have chainType", async () => {
    const A = "bc1qaaa000000000000000000000000000000000a1";
    const byTxid = new Map([
      ["tx1", [makePart("tx1", "input", A), makePart("tx1", "output", "ext")]],
    ]);

    const ctx = makeCtx([A], byTxid);
    mockGetRecords.mockResolvedValue([makeRecord(A, { chainType: "receive" })]);

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.chainTypeCoverage).toBe(1);
    expect(result.degradation).toBeNull();
  });
});

// ── Empty context ─────────────────────────────────────────────────────────────

describe("Empty context", () => {
  it("returns a safe empty result when there are no user addresses", async () => {
    const ctx = makeCtx([], new Map());

    const result = await runAdversaryViewFromContext(ctx);

    expect(result.exposureFindings).toHaveLength(0);
    expect(result.separationFindings).toHaveLength(0);
    expect(result.confusionFindings).toHaveLength(0);
    expect(result.contextMergeWarnings).toHaveLength(0);
    expect(result.degradation).toBeNull();
  });
});
