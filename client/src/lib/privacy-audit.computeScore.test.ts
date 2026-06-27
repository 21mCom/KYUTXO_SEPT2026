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

import { computeScore, type PrivacyFinding } from "./privacy-audit";

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
