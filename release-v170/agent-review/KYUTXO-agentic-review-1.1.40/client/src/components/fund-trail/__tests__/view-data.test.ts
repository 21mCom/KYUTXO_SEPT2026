import { describe, it, expect } from "vitest";
import { buildFundTrailViewData } from "../view-data";
import {
  makeMultiHopFixture,
  makeNoTimeFixture,
  makeEmptyFixture,
  FIXTURE_CENTER_LABEL,
  FIXTURE_DIMENSION,
} from "./fixtures";

describe("buildFundTrailViewData", () => {
  it("center totals use ONLY hop-1 nodes (no double-counting deeper hops)", () => {
    const vd = buildFundTrailViewData(
      makeMultiHopFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    // hop-1 sources: 150M + 60M = 210M (the 999M hop-2 node is excluded).
    expect(vd.center.totalInSats).toBe(210_000_000);
    // hop-1 dests: 130M + 120M = 250M (the 60M hop-2 and 30M hop-3 excluded).
    expect(vd.center.totalOutSats).toBe(250_000_000);
    expect(vd.center.groupLabel).toBe(FIXTURE_CENTER_LABEL);
    expect(vd.center.dimension).toBe(FIXTURE_DIMENSION);
  });

  it("computes per-side max depths and hop slices", () => {
    const vd = buildFundTrailViewData(
      makeMultiHopFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    expect(vd.maxSourceDepth).toBe(2);
    expect(vd.maxDestDepth).toBe(3);
    expect(vd.sourcesAtHop(1).map((n) => n.groupLabel)).toEqual([
      "Exchange A",
      "Unknown Source",
    ]);
    expect(vd.sourcesAtHop(2).map((n) => n.groupLabel)).toEqual(["Cold Storage"]);
    expect(vd.destinationsAtHop(3).map((n) => n.groupLabel)).toEqual(["Service Z"]);
    expect(vd.destinationsAtHop(4)).toEqual([]);
  });

  it("synthesizes deterministic, stable node ids", () => {
    const a = buildFundTrailViewData(
      makeMultiHopFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    const b = buildFundTrailViewData(
      makeMultiHopFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    expect(a.sources.map((n) => n.id)).toEqual([
      "src-h1-0",
      "src-h1-1",
      "src-h2-2",
    ]);
    expect(a.destinations.map((n) => n.id)).toEqual([
      "dst-h1-0",
      "dst-h1-1",
      "dst-h2-2",
      "dst-h3-3",
    ]);
    // Same input => identical ids on every build (deterministic, not random).
    expect(b.sources.map((n) => n.id)).toEqual(a.sources.map((n) => n.id));
    expect(b.destinations.map((n) => n.id)).toEqual(
      a.destinations.map((n) => n.id),
    );
  });

  it("passes caps through and resolves capForHop by depth + direction", () => {
    const fixture = makeMultiHopFixture();
    const vd = buildFundTrailViewData(
      fixture,
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    // Pass-through is by reference to the engine's caps array.
    expect(vd.caps).toBe(fixture.caps);
    const destCap = vd.capForHop(1, "dest");
    expect(destCap).toBeDefined();
    expect(destCap?.isCapped).toBe(true);
    expect(destCap?.shownTxCount).toBe(500);
    expect(destCap?.totalTxCount).toBe(1_250);
    // A non-capped hop is still resolvable; a missing one is undefined.
    expect(vd.capForHop(1, "source")?.isCapped).toBe(false);
    expect(vd.capForHop(2, "dest")).toBeUndefined();
  });

  it("derives a shared time range and a clamped 0..1 timePosition", () => {
    const vd = buildFundTrailViewData(
      makeMultiHopFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    expect(vd.timeRange.startSec).toBe(1_700_000_000);
    expect(vd.timeRange.endSec).toBe(1_700_600_000);
    expect(vd.timePosition(vd.timeRange.startSec)).toBe(0);
    expect(vd.timePosition(vd.timeRange.endSec)).toBe(1);
    // Midpoint of the range maps to ~0.5.
    expect(vd.timePosition(1_700_300_000)).toBeCloseTo(0.5, 5);
    // Out-of-range values clamp.
    expect(vd.timePosition(1_600_000_000)).toBe(0);
    expect(vd.timePosition(1_800_000_000)).toBe(1);
  });

  it("nodeDate returns each node's earliest known detail time", () => {
    const vd = buildFundTrailViewData(
      makeMultiHopFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    const coldStorage = vd.sources.find((n) => n.groupLabel === "Cold Storage")!;
    expect(vd.nodeDate(coldStorage)).toBe(1_700_000_000);
  });

  it("handles a degenerate (no known block times) trail gracefully", () => {
    const vd = buildFundTrailViewData(
      makeNoTimeFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    // No known times => start === end, so the variants treat it as "no time".
    expect(vd.timeRange.startSec).toBe(vd.timeRange.endSec);
    expect(vd.timeRange.endSec).toBe(0);
    expect(vd.timePosition(123)).toBe(0);
    // nodeDate falls back to the (zero) range start when a node has no times.
    expect(vd.nodeDate(vd.sources[0])).toBe(0);
    // Totals still compute from hop-1.
    expect(vd.center.totalInSats).toBe(100_000_000);
    expect(vd.center.totalOutSats).toBe(40_000_000);
  });

  it("handles a fully empty trail without throwing", () => {
    const vd = buildFundTrailViewData(
      makeEmptyFixture(),
      FIXTURE_CENTER_LABEL,
      FIXTURE_DIMENSION,
    );
    expect(vd.sources).toEqual([]);
    expect(vd.destinations).toEqual([]);
    expect(vd.maxSourceDepth).toBe(0);
    expect(vd.maxDestDepth).toBe(0);
    expect(vd.center.totalInSats).toBe(0);
    expect(vd.center.totalOutSats).toBe(0);
    expect(vd.capForHop(1, "source")).toBeUndefined();
  });
});
