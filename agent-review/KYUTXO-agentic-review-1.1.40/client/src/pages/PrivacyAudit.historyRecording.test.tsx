// @vitest-environment jsdom
//
// Coverage for the Privacy Audit history-recording behaviour (Task:
// "Confirm the audit history is recorded each time a Privacy Audit completes").
//
// When an audit finishes, runAudit persists a snapshot via
// addPrivacyAuditHistoryEntry (score, grade, finding counts, owner/wallet
// context) so users can track their score over time. Nothing previously
// verified the page actually writes this entry on completion, so a refactor
// could silently stop history from being recorded. These tests:
//   - run an audit through the real page and assert a history entry lands in
//     the (real Dexie) store with the expected score/grade and the selected
//     owner/wallet context, and
//   - assert NO entry is written when the audit short-circuits because nothing
//     matches (no address records at all, and a filter that excludes them all).
//
// We back the real Dexie database with fake-indexeddb and let the real
// privacy-history-crud / vocabulary / record CRUD run, only mocking
// runPrivacyAudit (deterministic result) and the Radix Select (which does not
// open under jsdom) so the owner/wallet filter selection path stays real.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  screen,
} from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import type { PrivacyAuditResult } from "@/lib/privacy-audit";

// recharts' ResponsiveContainer (used by the score-breakdown chart that renders
// on completion) needs ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// A fixed audit result so the persisted snapshot has known score/grade.
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

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. This keeps the owner/wallet selection state path
// real while staying deterministic.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = () => null;
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("option", { value }, children),
  };
});

const { createRecord } = await import("@/lib/dataFacade");
const { clearAllRecords } = await import("@/lib/data/record-crud");
const { clearAllTransactionData } = await import("@/lib/data/transaction-crud");
const { createOwner, createWalletName } = await import(
  "@/lib/data/vocabulary-crud"
);
const { db } = await import("@/lib/database");
const { clearSettings } = await import("@/lib/data/settings-crud");
const { getPrivacyAuditHistory, clearPrivacyAuditHistory } = await import(
  "@/lib/data/privacy-history-crud"
);
const { default: PrivacyAudit } = await import("./PrivacyAudit");

async function seedAddress(overrides: Record<string, unknown> = {}) {
  await createRecord(
    {
      type: "address",
      inputString: "bc1qauditaddr000000000000000000000000000000xx",
      label: "Audited Address",
      source: "manual",
      tags: [],
      categories: [],
      ...overrides,
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

beforeEach(resetDb);

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await resetDb();
});

describe("Privacy Audit history recording", () => {
  it("persists a history entry with the score/grade and selected owner/wallet on completion", async () => {
    await createOwner("Alice");
    await createWalletName("Cold Storage");
    await seedAddress({ owner: "Alice", walletName: "Cold Storage" });

    const { getByTestId } = renderPage();

    // The owner/wallet options come from the (real) vocabulary live queries;
    // wait for them before selecting.
    await waitFor(() => {
      expect(
        getByTestId("select-owner").querySelector('option[value="Alice"]'),
      ).toBeTruthy();
      expect(
        getByTestId("select-wallet").querySelector(
          'option[value="Cold Storage"]',
        ),
      ).toBeTruthy();
    });

    fireEvent.change(getByTestId("select-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.change(getByTestId("select-wallet"), {
      target: { value: "Cold Storage" },
    });

    fireEvent.click(getByTestId("button-run-audit"));

    // A single history snapshot is written once the audit completes.
    await waitFor(async () => {
      expect((await getPrivacyAuditHistory()).length).toBe(1);
    });

    const [entry] = await getPrivacyAuditHistory();
    expect(entry.score).toBe(88);
    expect(entry.grade).toBe("B");
    expect(entry.owner).toBe("Alice");
    expect(entry.walletName).toBe("Cold Storage");
    expect(entry.transactionsAnalyzed).toBe(MOCK_RESULT.transactionsAnalyzed);
    expect(entry.addressesScanned).toBe(MOCK_RESULT.addressesScanned);
    expect(entry.totalFindings).toBe(0);
    expect(typeof entry.timestamp).toBe("number");
  });

  it("omits owner/wallet context when no filter is selected", async () => {
    await seedAddress();

    const { getByTestId } = renderPage();

    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(async () => {
      expect((await getPrivacyAuditHistory()).length).toBe(1);
    });

    const [entry] = await getPrivacyAuditHistory();
    expect(entry.score).toBe(88);
    expect(entry.grade).toBe("B");
    expect(entry.owner).toBeUndefined();
    expect(entry.walletName).toBeUndefined();
  });

  it("writes no history entry when there are no address records", async () => {
    const { getByTestId } = renderPage();

    fireEvent.click(getByTestId("button-run-audit"));

    // The audit short-circuits with a "No Records" toast.
    await screen.findByText("No address records found to audit.");

    expect((await getPrivacyAuditHistory()).length).toBe(0);
  });

  it("writes no history entry when the selected filter matches no records", async () => {
    await createOwner("Alice");
    await createOwner("Bob");
    // The only record belongs to Alice, but we audit Bob's scope.
    await seedAddress({ owner: "Alice" });

    const { getByTestId } = renderPage();

    await waitFor(() => {
      expect(
        getByTestId("select-owner").querySelector('option[value="Bob"]'),
      ).toBeTruthy();
    });

    fireEvent.change(getByTestId("select-owner"), {
      target: { value: "Bob" },
    });

    fireEvent.click(getByTestId("button-run-audit"));

    // The audit short-circuits with a "No Matching Records" toast.
    await screen.findByText("No address records match the selected filters.");

    expect((await getPrivacyAuditHistory()).length).toBe(0);
  });
});
