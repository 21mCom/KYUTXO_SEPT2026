// @vitest-environment jsdom
//
// Coverage for the stale-adversary-history guard (Task: "Prevent an old audit
// run from receiving a newer run's adversary numbers").
//
// The adversary summary is attached to a history entry asynchronously after
// the audit completes. If a user starts a second audit before the first
// adversary analysis finishes, both analyses run concurrently and each writes
// to its own captured history id. Without a guard, a slow first analysis
// writes stale exposure numbers (computed against a possibly different
// filter/scope) onto the old entry after the user has moved on — and even the
// abort-signal check at the top of the .then handler can be slipped past when
// the new audit starts while the handler is awaiting saveAdversaryResult.
//
// runAudit now bumps a run-generation counter and the adversary .then handler
// re-checks it (plus the abort signal) immediately before calling
// setPrivacyAuditHistoryAdversary. These tests drive the real page with a
// real Dexie store (fake-indexeddb), mocking only runPrivacyAudit (instant,
// deterministic), runAdversaryView (deferred, per-call resolvable) and
// saveAdversaryResult (deferred) so the overlap timing is fully controlled:
//   - a superseded run that resolves mid-persist of a newer audit must NOT
//     write its adversary summary onto its (old) history entry, and
//   - the newer run's summary still lands on the newer entry.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import type { PrivacyAuditResult } from "@/lib/privacy-audit";
import type { AdversaryViewResult } from "@/lib/adversary-view";

// recharts' ResponsiveContainer (score-breakdown chart on completion) needs
// ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

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

function makeAdversaryResult(exposureCount: number): AdversaryViewResult {
  return {
    exposureFindings: [],
    separationFindings: [],
    confusionFindings: [],
    contextMergeWarnings: [],
    summary: {
      exposureCount,
      addressesExposed: exposureCount,
      addressesSeparated: 0,
      separationCount: 0,
      confusionCount: 0,
      contextMergeCount: 0,
    },
    degradation: null,
  } as unknown as AdversaryViewResult;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// Per-call deferreds so the test controls exactly when each adversary run
// finishes and when each saveAdversaryResult persist completes.
const adversaryDeferreds: Deferred<AdversaryViewResult>[] = [];
const saveDeferreds: Deferred<void>[] = [];

vi.mock("@/lib/privacy-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/privacy-audit")>(
    "@/lib/privacy-audit",
  );
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => MOCK_RESULT),
  };
});

vi.mock("@/lib/adversary-view", async () => {
  const actual = await vi.importActual<typeof import("@/lib/adversary-view")>(
    "@/lib/adversary-view",
  );
  return {
    ...actual,
    // Deliberately ignores the abort signal: simulates a slow analysis that
    // resolves after it has been superseded.
    runAdversaryView: vi.fn(() => {
      const d = deferred<AdversaryViewResult>();
      adversaryDeferreds.push(d);
      return d.promise;
    }),
  };
});

vi.mock("@/lib/data/privacy-audit-session-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/data/privacy-audit-session-store")
  >("@/lib/data/privacy-audit-session-store");
  return {
    ...actual,
    saveAdversaryResult: vi.fn(() => {
      const d = deferred<void>();
      saveDeferreds.push(d);
      return d.promise;
    }),
  };
});

const { createRecord } = await import("@/lib/dataFacade");
const { clearAllRecords } = await import("@/lib/data/record-crud");
const { clearAllTransactionData } = await import("@/lib/data/transaction-crud");
const { db } = await import("@/lib/database");
const { clearSettings } = await import("@/lib/data/settings-crud");
const { getPrivacyAuditHistory, clearPrivacyAuditHistory } = await import(
  "@/lib/data/privacy-history-crud"
);
const { default: PrivacyAudit } = await import("./PrivacyAudit");

async function seedAddress() {
  await createRecord(
    {
      type: "address",
      inputString: "bc1qstaleadvaddr00000000000000000000000000xx",
      label: "Audited Address",
      source: "manual",
      tags: [],
      categories: [],
    } as any,
    { skipVocabularySync: true },
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

async function resetDb() {
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
  await clearPrivacyAuditHistory();
  await clearSettings({ skipNotification: true });
  await db.owners.clear();
  await db.walletNames.clear();
}

beforeEach(async () => {
  adversaryDeferreds.length = 0;
  saveDeferreds.length = 0;
  await resetDb();
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await resetDb();
});

describe("stale adversary write invalidation across overlapping audits", () => {
  it("a superseded run never writes its adversary summary; the new run's still lands", async () => {
    await seedAddress();
    const { getByTestId } = renderPage();

    // ── Audit #1 completes; its adversary analysis is still running ────────
    fireEvent.click(getByTestId("button-run-audit"));
    await waitFor(async () => {
      expect((await getPrivacyAuditHistory()).length).toBe(1);
      expect(adversaryDeferreds.length).toBe(1);
    });
    const [firstEntry] = await getPrivacyAuditHistory();

    // Resolve adversary #1 → its .then handler passes the initial abort check
    // (no new audit yet) and blocks awaiting saveAdversaryResult.
    adversaryDeferreds[0].resolve(makeAdversaryResult(7));
    await waitFor(() => {
      expect(saveDeferreds.length).toBe(1);
    });

    // ── Audit #2 starts while run #1 is mid-persist ─────────────────────────
    fireEvent.click(getByTestId("button-run-audit"));
    await waitFor(async () => {
      expect((await getPrivacyAuditHistory()).length).toBe(2);
      expect(adversaryDeferreds.length).toBe(2);
    });

    // Now unblock run #1's persist. Its generation is stale, so the guard
    // must skip setPrivacyAuditHistoryAdversary for the old entry.
    saveDeferreds[0].resolve();
    // Let the handler's microtasks run to completion.
    await new Promise((r) => setTimeout(r, 20));

    let history = await getPrivacyAuditHistory();
    const oldEntry = history.find((e) => e.id === firstEntry.id);
    expect(oldEntry).toBeTruthy();
    expect(oldEntry!.adversary).toBeUndefined();

    // ── Run #2 finishes normally and attaches to its own (new) entry ────────
    adversaryDeferreds[1].resolve(makeAdversaryResult(3));
    await waitFor(() => {
      expect(saveDeferreds.length).toBe(2);
    });
    saveDeferreds[1].resolve();

    await waitFor(async () => {
      const entries = await getPrivacyAuditHistory();
      const newEntry = entries.find((e) => e.id !== firstEntry.id);
      expect(newEntry?.adversary?.exposureCount).toBe(3);
    });

    // The old entry stayed untouched throughout.
    history = await getPrivacyAuditHistory();
    expect(history.find((e) => e.id === firstEntry.id)!.adversary).toBeUndefined();
  });

  it("a superseded run that resolves after the new audit has already started does not write", async () => {
    await seedAddress();
    const { getByTestId } = renderPage();

    fireEvent.click(getByTestId("button-run-audit"));
    await waitFor(async () => {
      expect((await getPrivacyAuditHistory()).length).toBe(1);
      expect(adversaryDeferreds.length).toBe(1);
    });
    const [firstEntry] = await getPrivacyAuditHistory();

    // Second audit starts before adversary #1 has resolved at all.
    fireEvent.click(getByTestId("button-run-audit"));
    await waitFor(async () => {
      expect((await getPrivacyAuditHistory()).length).toBe(2);
      expect(adversaryDeferreds.length).toBe(2);
    });

    // The slow first analysis finally resolves — superseded, must not write.
    adversaryDeferreds[0].resolve(makeAdversaryResult(9));
    await new Promise((r) => setTimeout(r, 20));

    const history = await getPrivacyAuditHistory();
    // Starting audit #2 marks the superseded run's entry "cancelled"; the
    // stale exposure numbers must never land on it.
    const staleAdversary = history.find((e) => e.id === firstEntry.id)!.adversary;
    expect(staleAdversary).toEqual({ status: "cancelled" });
    expect(staleAdversary!.exposureCount).toBeUndefined();
    // It must not have reached the persist step either.
    expect(saveDeferreds.length).toBe(0);
  });
});
