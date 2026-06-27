// Unit-level coverage for the LOW (-3) proximity first-penalty in computeScore.
//
// privacy-audit.e2e-proximity.test.ts drives the full runPrivacyAudit()
// pipeline and proves the hop-2 (HIGH, -15) and hop-3 (MEDIUM, -8) first
// penalties end-to-end. It can only assert that a hop-4 path *resolves to LOW
// severity* — not that LOW applies its exact -3 first-penalty — because any
// Dexie seed that reaches hop 4 also creates closer same-type proximity
// findings that merge into a single waterfall entry (KYUTXO only loads
// transactions that touch an owned address, so the weakest tier can never be
// the sole entry of its severity in an end-to-end seed).
//
// This test therefore intentionally bypasses Dexie seeding and exercises the
// smallest accessible scoring entry point — computeScore — directly with a
// single synthetic LOW-severity proximity finding, guaranteeing the LOW (-3)
// first-penalty is wired correctly even when it IS the first finding of its
// severity tier.

import { describe, it, expect } from "vitest";

import { computeScore, scoreToGrade, type PrivacyFinding } from "./privacy-audit";

function makeLowProximityFinding(): PrivacyFinding {
  return {
    type: "PROXIMITY_EXCHANGE",
    severity: "LOW",
    description: "Synthetic hop-4 distant-exchange proximity finding",
    details: { isProximity: true, hopDistance: 4 },
    correction: "n/a",
    txids: ["tx-low-proximity"],
    addresses: ["bc1qlowproxowned00000000000000000000000000aa"],
  };
}

describe("computeScore LOW proximity first-penalty", () => {
  it("applies the -3 LOW first-penalty when a LOW finding is first of its tier", () => {
    const finding = makeLowProximityFinding();

    const { score, waterfall } = computeScore([finding], []);

    const entry = waterfall.find((w) => w.findingType === "PROXIMITY_EXCHANGE");
    expect(entry).toBeTruthy();
    expect(entry!.count).toBe(1);
    // The crux: the weakest proximity tier (LOW) must apply exactly -3 when it
    // is the first finding of its severity tier.
    expect(entry!.delta).toBe(-3);

    // The penalty must also flow through to the overall score and back onto the
    // finding itself.
    expect(score).toBe(97);
    expect(finding.scoreDelta).toBe(-3);
  });
});

// Builds N findings that share a type (so computeScore groups them into a single
// waterfall entry) and a severity (so they stack within the same tier). The
// first finding of the tier pays SEVERITY_FIRST_PENALTY; every additional one
// pays the intentionally smaller SEVERITY_SUBSEQUENT_PENALTY.
function makeFindings(
  type: PrivacyFinding["type"],
  severity: PrivacyFinding["severity"],
  count: number
): PrivacyFinding[] {
  return Array.from({ length: count }, (_, i) => ({
    type,
    severity,
    description: `Synthetic ${severity} ${type} finding #${i + 1}`,
    details: {},
    correction: "n/a",
    txids: [`tx-${type}-${i + 1}`],
    addresses: [`bc1q${type.toLowerCase()}${i}0000000000000000000000000000aa`],
  }));
}

describe("computeScore subsequent (stacking) penalties", () => {
  it("stacks LOW findings as first + N × subsequent: -3 + -1 = -4", () => {
    const findings = makeFindings("ADDRESS_REUSE", "LOW", 2);

    const { score, waterfall } = computeScore(findings, []);

    const entry = waterfall.find((w) => w.findingType === "ADDRESS_REUSE");
    expect(entry).toBeTruthy();
    expect(entry!.count).toBe(2);
    // First LOW finding pays -3, the second pays the smaller -1 subsequent penalty.
    expect(entry!.delta).toBe(-4);

    expect(score).toBe(96);
    // Each finding records its share of the grouped delta.
    for (const f of findings) {
      expect(f.scoreDelta).toBe(-2);
    }
  });

  it("stacks MEDIUM findings as first + N × subsequent: -8 + -3 = -11", () => {
    const findings = makeFindings("ROUND_AMOUNT", "MEDIUM", 2);

    const { score, waterfall } = computeScore(findings, []);

    const entry = waterfall.find((w) => w.findingType === "ROUND_AMOUNT");
    expect(entry).toBeTruthy();
    expect(entry!.count).toBe(2);
    // First MEDIUM finding pays -8, the second pays the smaller -3 subsequent
    // penalty. A tier-swap regression (e.g. using LOW's -1) would break this.
    expect(entry!.delta).toBe(-11);

    expect(score).toBe(89);
  });

  it("keeps shrinking penalties for three+ findings: -8 + 2 × -3 = -14", () => {
    const findings = makeFindings("ROUND_AMOUNT", "MEDIUM", 3);

    const { waterfall } = computeScore(findings, []);

    const entry = waterfall.find((w) => w.findingType === "ROUND_AMOUNT");
    expect(entry).toBeTruthy();
    expect(entry!.count).toBe(3);
    expect(entry!.delta).toBe(-14);
  });
});

// Builds a CoinJoin (privacy-positive) finding. Using CoinJoin is GOOD privacy
// behaviour: such findings must surface in the waterfall for visibility but must
// never subtract from the score. severity is intentionally set to a penalising
// tier to prove the positive-type carve-out wins regardless of severity.
function makeCoinJoinFinding(
  type: Extract<
    PrivacyFinding["type"],
    "COINJOIN_WHIRLPOOL" | "COINJOIN_WASABI" | "COINJOIN_JOINMARKET"
  >
): PrivacyFinding {
  return {
    type,
    severity: "HIGH",
    description: `Synthetic ${type} privacy-positive finding`,
    details: {},
    correction: "n/a",
    txids: [`tx-${type.toLowerCase()}`],
    addresses: [`bc1q${type.toLowerCase()}0000000000000000000000000000aa`],
  };
}

describe("computeScore privacy-positive (CoinJoin) findings", () => {
  it("never penalises CoinJoin findings: delta 0 and unchanged overall score", () => {
    const whirlpool = makeCoinJoinFinding("COINJOIN_WHIRLPOOL");
    const wasabi = makeCoinJoinFinding("COINJOIN_WASABI");
    const joinmarket = makeCoinJoinFinding("COINJOIN_JOINMARKET");

    const { score, waterfall } = computeScore(
      [whirlpool, wasabi, joinmarket],
      []
    );

    // Score is untouched by privacy-positive findings.
    expect(score).toBe(100);

    // Each CoinJoin type appears in the waterfall with delta 0...
    for (const positive of [whirlpool, wasabi, joinmarket]) {
      const entry = waterfall.find((w) => w.findingType === positive.type);
      expect(entry).toBeTruthy();
      expect(entry!.count).toBe(1);
      expect(entry!.delta).toBe(0);
      // ...and the finding records a zero score delta.
      expect(positive.scoreDelta).toBe(0);
    }
  });

  it("scores penalised findings only, leaving CoinJoin findings at delta 0", () => {
    // One penalised MEDIUM finding (-8) mixed with a privacy-positive CoinJoin.
    const penalised = makeFindings("ROUND_AMOUNT", "MEDIUM", 1);
    const coinjoin = makeCoinJoinFinding("COINJOIN_WHIRLPOOL");

    const { score, waterfall } = computeScore([...penalised, coinjoin], []);

    // The overall score reflects ONLY the penalised finding (-8), unaffected by
    // the positive one. A regression that penalised CoinJoin would drop this
    // below 92.
    expect(score).toBe(92);

    const penalisedEntry = waterfall.find(
      (w) => w.findingType === "ROUND_AMOUNT"
    );
    expect(penalisedEntry).toBeTruthy();
    expect(penalisedEntry!.delta).toBe(-8);
    expect(penalised[0].scoreDelta).toBe(-8);

    // The CoinJoin finding is still present in the waterfall and stays neutral.
    const positiveEntry = waterfall.find(
      (w) => w.findingType === "COINJOIN_WHIRLPOOL"
    );
    expect(positiveEntry).toBeTruthy();
    expect(positiveEntry!.delta).toBe(0);
    expect(coinjoin.scoreDelta).toBe(0);
  });
});

// Heavy wallets can accumulate enough severe findings that the raw penalty total
// would push the running score far below zero. computeScore clamps the running
// score with Math.max(0, ...) so the final report can never show a negative or
// nonsensical value. This guards that floor directly, bypassing Dexie seeding.
describe("computeScore zero floor on heavy wallets", () => {
  it("clamps the score to exactly 0 (never negative) under many severe findings", () => {
    // Spread severe findings across multiple types so each becomes its own
    // waterfall entry, and stack many within each so subsequent penalties pile
    // on. The raw total here is far below zero:
    //   CRITICAL: -25 + 9 × -12 = -133
    //   HIGH:     -15 + 9 × -6  = -69
    //   MEDIUM:   -8  + 9 × -3  = -35
    //   raw running total ≈ 100 - 237 = -137 before clamping.
    const findings: PrivacyFinding[] = [
      ...makeFindings("ADDRESS_REUSE", "CRITICAL", 10),
      ...makeFindings("ROUND_AMOUNT", "HIGH", 10),
      ...makeFindings("PROXIMITY_EXCHANGE", "MEDIUM", 10),
    ];

    const { score, grade, waterfall } = computeScore(findings, []);

    // The crux: even with a deeply negative raw total, the score floors at 0.
    expect(score).toBe(0);
    expect(score).toBeGreaterThanOrEqual(0);

    // The grade maps accordingly — the lowest grade once the score bottoms out.
    expect(grade).toBe("F");

    // No running score in the waterfall is allowed to dip below zero either.
    for (const entry of waterfall) {
      expect(entry.runningScore).toBeGreaterThanOrEqual(0);
    }
  });

  it("clamps to 0 even when a single overwhelming type exceeds the base score", () => {
    // A single type with enough CRITICAL findings to blow past 100 on its own:
    //   -25 + 19 × -12 = -253, well below the base score of 100.
    const findings = makeFindings("ADDRESS_REUSE", "CRITICAL", 20);

    const { score, grade } = computeScore(findings, []);

    expect(score).toBe(0);
    expect(grade).toBe("F");
  });
});

// The mirror image of the zero-floor guard above: computeScore starts at a base
// of 100 and only ever subtracts penalties, while privacy-positive findings
// (CoinJoin) are intentionally neutral (delta 0). A clean or privacy-positive-only
// wallet must therefore land at exactly 100 — never above it. If a future change
// ever let a finding type ADD points, the report could show a nonsensical >100
// score; these tests pin the upper bound directly, bypassing Dexie seeding.
describe("computeScore upper bound (never exceeds 100)", () => {
  it("scores a completely clean wallet at exactly 100 with grade A+", () => {
    const { score, grade, waterfall } = computeScore([], []);

    expect(score).toBe(100);
    expect(score).toBeLessThanOrEqual(100);
    expect(grade).toBe("A+");

    // The only entry is the base score; nothing ever pushes the running score up.
    for (const entry of waterfall) {
      expect(entry.runningScore).toBeLessThanOrEqual(100);
    }
  });

  it("caps at 100 for a privacy-positive-only wallet (many CoinJoins, no penalties)", () => {
    // A heap of privacy-positive findings across every CoinJoin type. Good
    // privacy behaviour must never be rewarded with bonus points beyond 100.
    const findings: PrivacyFinding[] = [
      makeCoinJoinFinding("COINJOIN_WHIRLPOOL"),
      makeCoinJoinFinding("COINJOIN_WHIRLPOOL"),
      makeCoinJoinFinding("COINJOIN_WASABI"),
      makeCoinJoinFinding("COINJOIN_WASABI"),
      makeCoinJoinFinding("COINJOIN_JOINMARKET"),
      makeCoinJoinFinding("COINJOIN_JOINMARKET"),
    ];

    const { score, grade, waterfall } = computeScore(findings, []);

    // The crux: even with many privacy-positive findings, the score caps at 100.
    expect(score).toBe(100);
    expect(score).toBeLessThanOrEqual(100);
    expect(grade).toBe("A+");

    // Every privacy-positive entry stays neutral and never lifts the running
    // score above the 100 base.
    for (const entry of waterfall) {
      expect(entry.delta).toBeLessThanOrEqual(0);
      expect(entry.runningScore).toBeLessThanOrEqual(100);
    }
  });
});

// scoreToGrade maps a 0–100 score to one of 13 letter grades across 12
// numeric thresholds (A+ from 97 down to D- at 60, with F below). An off-by-one
// regression on any cutoff would silently mislabel a user's privacy grade, so we
// pin every boundary directly: a score exactly AT the threshold must earn the
// higher grade, and one point BELOW must drop to the next-lower grade.
describe("scoreToGrade letter-grade boundaries", () => {
  // [boundary score, grade at boundary, grade one point below boundary]
  const boundaries: Array<[number, string, string]> = [
    [97, "A+", "A"],
    [93, "A", "A-"],
    [90, "A-", "B+"],
    [87, "B+", "B"],
    [83, "B", "B-"],
    [80, "B-", "C+"],
    [77, "C+", "C"],
    [73, "C", "C-"],
    [70, "C-", "D+"],
    [67, "D+", "D"],
    [63, "D", "D-"],
    [60, "D-", "F"],
  ];

  for (const [score, atGrade, belowGrade] of boundaries) {
    it(`maps ${score} → ${atGrade} and ${score - 1} → ${belowGrade}`, () => {
      expect(scoreToGrade(score)).toBe(atGrade);
      expect(scoreToGrade(score - 1)).toBe(belowGrade);
    });
  }

  it("maps the perfect and zero extremes", () => {
    expect(scoreToGrade(100)).toBe("A+");
    expect(scoreToGrade(0)).toBe("F");
  });
});
