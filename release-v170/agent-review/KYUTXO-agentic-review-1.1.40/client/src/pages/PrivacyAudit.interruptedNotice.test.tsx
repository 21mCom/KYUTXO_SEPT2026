// @vitest-environment jsdom
//
// Coverage for the interrupted-audit notices on the Privacy Audit page (Task:
// "Catch regressions in the interrupted-audit notice before they ship").
//
// The refresh-persistence rehydrate effect in PrivacyAudit.tsx has three
// paths, keyed off the persisted session in privacy-audit-session-store:
//   1. phase 'auditing'                      → banner-audit-interrupted
//   2. phase 'complete' + adversaryPending   → banner-adversary-interrupted
//   3. phase 'complete' + adversaryResult    → banner-audit-restored
// The browser guard (check-adversary-view-browser.mjs) only exercises path 3.
// These tests seed the real (fake-indexeddb-backed) session store directly and
// assert the correct banner — and only that banner — renders on mount, so a
// regression can't silently drop the notice and leave users with a blank page.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { PrivacyAuditResult } from "@/lib/privacy-audit";
import type { AdversaryViewResult } from "@/lib/adversary-view";

// recharts' ResponsiveContainer (score-breakdown chart rendered when a
// completed result is restored) needs ResizeObserver, absent in jsdom.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const { renderWithProviders } = await import("@/test/testProviders");
const {
  beginAuditSession,
  saveAuditResult,
  saveAdversaryResult,
  clearAuditSession,
} = await import("@/lib/data/privacy-audit-session-store");
const { default: PrivacyAudit } = await import("./PrivacyAudit");

// A minimal completed audit result for the phase-'complete' sessions.
const MOCK_RESULT: PrivacyAuditResult = {
  findings: [],
  warnings: [],
  transactionsAnalyzed: 3,
  addressesScanned: 1,
  isClean: true,
  score: 88,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

const MOCK_ADVERSARY: AdversaryViewResult = {
  exposureFindings: [],
  separationFindings: [],
  confusionFindings: [],
  contextMergeWarnings: [],
  summary: {
    exposureCount: 0,
    separationCount: 0,
    confusionCount: 0,
    contextMergeCount: 0,
    addressesExposed: 0,
    addressesSeparated: 0,
  },
  degradation: null,
  chainTypeCoverage: 1,
};

function renderPage() {
  const { hook } = memoryLocation({ path: "/privacy-audit" });
  return renderWithProviders(
    <Router hook={hook}>
      <PrivacyAudit />
    </Router>,
  );
}

beforeEach(async () => {
  await clearAuditSession();
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await clearAuditSession();
});

describe("Privacy Audit interrupted-session notices", () => {
  it("shows the audit-interrupted banner when the session phase is 'auditing'", async () => {
    await beginAuditSession("all", "all");

    const { getByTestId, queryByTestId } = renderPage();

    await waitFor(() => {
      expect(getByTestId("banner-audit-interrupted")).toBeTruthy();
    });

    const banner = getByTestId("banner-audit-interrupted");
    expect(banner.textContent).toContain("The last audit was interrupted");
    expect(banner.textContent).toContain(
      "The page was refreshed while an audit was still running, so no results were saved. Run the audit again to get fresh results.",
    );

    // The other rehydrate banners must not render.
    expect(queryByTestId("banner-adversary-interrupted")).toBeNull();
    expect(queryByTestId("banner-audit-restored")).toBeNull();
  });

  it("shows the adversary-interrupted banner when the main audit completed but adversaryPending is true", async () => {
    // saveAuditResult persists phase 'complete' with adversaryPending: true —
    // exactly the state left behind by a refresh before the Adversary View
    // analysis finished.
    await saveAuditResult("all", "all", MOCK_RESULT);

    const { getByTestId, queryByTestId } = renderPage();

    await waitFor(() => {
      expect(getByTestId("banner-adversary-interrupted")).toBeTruthy();
    });

    const banner = getByTestId("banner-adversary-interrupted");
    expect(banner.textContent).toContain("Adversary View analysis was interrupted");
    expect(banner.textContent).toContain(
      "The audit results below were restored from your last run, but the page was refreshed before the Adversary View analysis finished. Run the audit again to include it.",
    );

    expect(queryByTestId("banner-audit-interrupted")).toBeNull();
    expect(queryByTestId("banner-audit-restored")).toBeNull();

    // The restored main-audit result itself renders (grade badge present).
    expect(getByTestId("text-privacy-grade").textContent).toContain("B");
  });

  it("shows the restored banner (not an interrupted one) when the adversary result was saved too", async () => {
    await saveAuditResult("all", "all", MOCK_RESULT);
    await saveAdversaryResult(MOCK_ADVERSARY);

    const { getByTestId, queryByTestId } = renderPage();

    await waitFor(() => {
      expect(getByTestId("banner-audit-restored")).toBeTruthy();
    });

    expect(getByTestId("banner-audit-restored").textContent).toContain(
      "Showing results restored from your last audit run",
    );
    expect(queryByTestId("banner-audit-interrupted")).toBeNull();
    expect(queryByTestId("banner-adversary-interrupted")).toBeNull();
  });

  it("shows no rehydrate banner when there is no persisted session", async () => {
    const { queryByTestId, getByTestId } = renderPage();

    // Wait for the page to settle (Run Audit button mounted), then confirm
    // none of the rehydrate banners appeared.
    await waitFor(() => {
      expect(getByTestId("button-run-audit")).toBeTruthy();
    });

    expect(queryByTestId("banner-audit-interrupted")).toBeNull();
    expect(queryByTestId("banner-adversary-interrupted")).toBeNull();
    expect(queryByTestId("banner-audit-restored")).toBeNull();
  });
});
