// @vitest-environment jsdom
//
// Render smoke tests for the four alternate Fund Trail layout variants
// (horizontal, vertical, breakout, sankey). The "classic" layout is rendered
// directly by FundTrail.tsx and is intentionally not routed through
// MultiHopVariantLayout, so it is not covered here.
//
// These tests do not assert pixel geometry (the variants are pure functions of
// deterministic coordinates, already covered by the view-data adapter tests).
// They verify each variant mounts against a real multi-hop fixture without
// throwing or logging console errors, surfaces the SAME center + hop-1 nodes by
// their shared synthesized ids, and shows the hop-level cap notice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { MultiHopVariantLayout } from "../MultiHopVariantLayout";
import { buildFundTrailViewData, type FundTrailLayout } from "../view-data";
import {
  makeMultiHopFixture,
  makeNoTimeFixture,
  FIXTURE_CENTER_LABEL,
  FIXTURE_DIMENSION,
} from "./fixtures";

const VARIANTS: Exclude<FundTrailLayout, "classic">[] = [
  "horizontal",
  "vertical",
  "breakout",
  "sankey",
];

function viewData(result = makeMultiHopFixture()) {
  return buildFundTrailViewData(result, FIXTURE_CENTER_LABEL, FIXTURE_DIMENSION);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe.each(VARIANTS)("MultiHopVariantLayout — %s", (layout) => {
  it("renders a multi-hop trail without console errors", () => {
    renderWithProviders(
      <MultiHopVariantLayout layout={layout} data={viewData()} />,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("surfaces hop-1 source + destination nodes by their shared ids", () => {
    renderWithProviders(
      <MultiHopVariantLayout layout={layout} data={viewData()} />,
    );
    // Same synthesized ids across every variant (from the one adapter).
    expect(screen.getByTestId("ft-node-src-h1-0")).toBeTruthy();
    expect(screen.getByTestId("ft-node-dst-h1-0")).toBeTruthy();
  });

  it("renders the traced-entity center label", () => {
    renderWithProviders(
      <MultiHopVariantLayout layout={layout} data={viewData()} />,
    );
    expect(screen.getAllByText(FIXTURE_CENTER_LABEL).length).toBeGreaterThan(0);
  });

  it("surfaces a capped hop (overlay notice or per-column banner)", () => {
    renderWithProviders(
      <MultiHopVariantLayout layout={layout} data={viewData()} />,
    );
    // Column layouts (horizontal) surface caps via a per-column banner; the
    // others use the overlay HopCapNotice. Either way a capped hop must show.
    const notice = screen.queryAllByTestId("ft-cap-notice");
    const banner = screen.queryAllByTestId("ft-cap-banner");
    expect(notice.length + banner.length).toBeGreaterThan(0);
  });

  it("renders a degenerate (no block times) trail without errors", () => {
    renderWithProviders(
      <MultiHopVariantLayout layout={layout} data={viewData(makeNoTimeFixture())} />,
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("ft-node-src-h1-0")).toBeTruthy();
  });
});

// The Sankey layout draws every node inside a single fixed-viewBox <svg>, so a
// deep trail (source hop-2, destination hop-3 in the fixture) is the case most
// at risk of a node being dropped or laid out past the viewBox. Assert the
// deepest nodes on BOTH sides — and the center — are actually emitted.
describe("MultiHopVariantLayout — sankey deep-trail / clipping coverage", () => {
  it("emits the deepest source + destination nodes and the center", () => {
    const data = viewData();
    expect(data.maxSourceDepth).toBe(2);
    expect(data.maxDestDepth).toBe(3);

    renderWithProviders(<MultiHopVariantLayout layout="sankey" data={data} />);

    // Shared synthesized ids for the deepest fixture nodes on each side.
    expect(screen.getByTestId("ft-node-src-h2-2")).toBeTruthy();
    expect(screen.getByTestId("ft-node-dst-h3-3")).toBeTruthy();
    expect(screen.getByTestId("ft-node-center")).toBeTruthy();
  });
});
