// @vitest-environment jsdom
//
// UI-wiring coverage for the two Privacy Audit display preferences (Task:
// "Confirm the Privacy Audit toggles actually save your view choices").
//
// The store/hook layer is already covered by settings-privacy-view-prefs.test.ts
// (the helpers round-trip through the settings store). What was NOT covered is
// the wiring inside the PrivacyAudit page: that clicking the peel-chain
// Graph/List control invokes updatePeelChainViewMode and the score-breakdown
// Show/Hide control invokes updateShowScoreBreakdown, and that each control
// renders according to the persisted value on initial load. A page refactor
// could silently stop calling the save helpers; these tests catch that.
//
// We back the real Dexie database with fake-indexeddb and let the real
// useSettings (via useLiveQuery) read the persisted value, while wrapping the
// two save helpers in spies that STILL run the real persistence. That way each
// assertion proves both that the page called the helper with the right value
// and that the value actually landed in the settings store.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import type { Settings } from "@/lib/db-types";
import type { PrivacyAuditResult } from "@/lib/privacy-audit";

// recharts' ResponsiveContainer (used by the score-breakdown chart) needs
// ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// Wrap the two save helpers in spies that still delegate to the real
// persistence, so we can assert both the call and the resulting store value.
vi.mock("@/hooks/use-settings", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-settings")>(
    "@/hooks/use-settings",
  );
  return {
    ...actual,
    updatePeelChainViewMode: vi.fn(actual.updatePeelChainViewMode),
    updateShowScoreBreakdown: vi.fn(actual.updateShowScoreBreakdown),
  };
});

// A fixed audit result with a multi-entry score waterfall so the
// "Show/Hide Score Breakdown" toggle renders (it only appears when
// scoreWaterfall.length > 1).
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
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -12, runningScore: 88, count: 1 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

vi.mock("@/lib/privacy-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/privacy-audit")>(
    "@/lib/privacy-audit",
  );
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => MOCK_RESULT),
  };
});

const { updatePeelChainViewMode, updateShowScoreBreakdown } = await import(
  "@/hooks/use-settings"
);
const { getSettings, putSettings, clearSettings } = await import(
  "@/lib/data/settings-crud"
);
const { createRecord } = await import("@/lib/dataFacade");
const { clearAllRecords } = await import("@/lib/data/record-crud");
const { clearAllTransactionData } = await import("@/lib/data/transaction-crud");
const { clearPrivacyAuditHistory } = await import(
  "@/lib/data/privacy-history-crud"
);
const { PeelChainView, default: PrivacyAudit } = await import("./PrivacyAudit");

const PEEL_TXID =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc01";

// Seed the "default" settings row so the update helpers (no-ops without a row)
// can persist. Optionally pre-set the two view preferences.
async function seedSettings(overrides: Partial<Settings> = {}) {
  await putSettings({ id: "default", ...overrides } as Settings, {
    skipNotification: true,
  });
}

function renderPeelChain() {
  const { hook } = memoryLocation({ path: "/privacy-audit" });
  return render(
    <Router hook={hook}>
      <TooltipProvider>
        <RecordPreviewProvider>
          <PeelChainView
            txids={[PEEL_TXID]}
            changeAddresses={[]}
            coinjoinTxids={new Set<string>()}
          />
        </RecordPreviewProvider>
      </TooltipProvider>
    </Router>,
  );
}

function renderPage() {
  const { hook } = memoryLocation({ path: "/privacy-audit" });
  return render(
    <Router hook={hook}>
      <TooltipProvider>
        <RecordPreviewProvider>
          <PrivacyAudit />
          <Toaster />
        </RecordPreviewProvider>
      </TooltipProvider>
    </Router>,
  );
}

beforeEach(async () => {
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
  await clearPrivacyAuditHistory();
  await clearSettings({ skipNotification: true });
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
  await clearPrivacyAuditHistory();
  await clearSettings({ skipNotification: true });
});

describe("Peel-chain Graph/List toggle wiring", () => {
  it("renders in the persisted view mode on initial load (list)", async () => {
    await seedSettings({ peelChainViewMode: "list" });

    const { getByTestId, queryByTestId } = renderPeelChain();

    // The persisted "list" value drives the initial render: the list cards show
    // and the graph container does not.
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });
    expect(queryByTestId("container-peel-graph")).toBeNull();
  });

  it("renders in the persisted view mode on initial load (graph)", async () => {
    await seedSettings({ peelChainViewMode: "graph" });

    const { getByTestId, queryByTestId } = renderPeelChain();

    await waitFor(() => {
      expect(getByTestId("container-peel-graph")).toBeTruthy();
    });
    expect(queryByTestId("card-peel-step-0")).toBeNull();
  });

  it("calls updatePeelChainViewMode('list') and persists when List is clicked", async () => {
    await seedSettings({ peelChainViewMode: "graph" });

    const { getByTestId } = renderPeelChain();
    await waitFor(() => {
      expect(getByTestId("container-peel-graph")).toBeTruthy();
    });

    fireEvent.click(getByTestId("button-peel-view-list"));

    expect(updatePeelChainViewMode).toHaveBeenCalledWith("list");
    await waitFor(async () => {
      expect((await getSettings("default"))?.peelChainViewMode).toBe("list");
    });
    // The live query re-renders the page into list mode.
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });
  });

  it("calls updatePeelChainViewMode('graph') and persists when Graph is clicked", async () => {
    await seedSettings({ peelChainViewMode: "list" });

    const { getByTestId } = renderPeelChain();
    await waitFor(() => {
      expect(getByTestId("card-peel-step-0")).toBeTruthy();
    });

    fireEvent.click(getByTestId("button-peel-view-graph"));

    expect(updatePeelChainViewMode).toHaveBeenCalledWith("graph");
    await waitFor(async () => {
      expect((await getSettings("default"))?.peelChainViewMode).toBe("graph");
    });
    await waitFor(() => {
      expect(getByTestId("container-peel-graph")).toBeTruthy();
    });
  });
});

describe("Score-breakdown Show/Hide toggle wiring", () => {
  // The toggle only appears after an audit completes, so seed one address
  // record and run the (mocked) audit before interacting with it.
  async function runAuditAndGetToggle(getByTestId: (id: string) => HTMLElement) {
    await createRecord(
      {
        type: "address",
        inputString: "bc1qauditaddr000000000000000000000000000000xx",
        label: "Audited Address",
        source: "manual",
        tags: [],
        categories: [],
      },
      { skipVocabularySync: true },
    );

    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => {
      expect(getByTestId("button-toggle-waterfall")).toBeTruthy();
    });
    return getByTestId("button-toggle-waterfall");
  }

  it("reflects the persisted hidden value on initial render", async () => {
    await seedSettings({ showScoreBreakdown: false });

    const { getByTestId, queryByTestId } = renderPage();
    const toggle = await runAuditAndGetToggle(getByTestId);

    expect(toggle.textContent).toContain("Show Score Breakdown");
    expect(queryByTestId("container-waterfall-chart")).toBeNull();
  });

  it("reflects the persisted shown value on initial render", async () => {
    await seedSettings({ showScoreBreakdown: true });

    const { getByTestId } = renderPage();
    const toggle = await runAuditAndGetToggle(getByTestId);

    expect(toggle.textContent).toContain("Hide Score Breakdown");
    await waitFor(() => {
      expect(getByTestId("container-waterfall-chart")).toBeTruthy();
    });
  });

  it("calls updateShowScoreBreakdown(true) and persists when the toggle is clicked", async () => {
    await seedSettings({ showScoreBreakdown: false });

    const { getByTestId } = renderPage();
    const toggle = await runAuditAndGetToggle(getByTestId);

    fireEvent.click(toggle);

    expect(updateShowScoreBreakdown).toHaveBeenCalledWith(true);
    await waitFor(async () => {
      expect((await getSettings("default"))?.showScoreBreakdown).toBe(true);
    });
    // The live query re-renders the toggle into its "Hide" state.
    await waitFor(() => {
      expect(getByTestId("button-toggle-waterfall").textContent).toContain(
        "Hide Score Breakdown",
      );
    });
  });

  it("calls updateShowScoreBreakdown(false) and persists when toggled off", async () => {
    await seedSettings({ showScoreBreakdown: true });

    const { getByTestId } = renderPage();
    const toggle = await runAuditAndGetToggle(getByTestId);

    fireEvent.click(toggle);

    expect(updateShowScoreBreakdown).toHaveBeenCalledWith(false);
    await waitFor(async () => {
      expect((await getSettings("default"))?.showScoreBreakdown).toBe(false);
    });
    await waitFor(() => {
      expect(getByTestId("button-toggle-waterfall").textContent).toContain(
        "Show Score Breakdown",
      );
    });
  });
});
