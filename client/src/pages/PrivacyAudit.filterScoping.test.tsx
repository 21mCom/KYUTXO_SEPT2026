// @vitest-environment jsdom
//
// Integration coverage for the Privacy Audit owner/wallet scoping filters
// (Task: "Confirm the Privacy Audit owner and wallet filters limit what gets
// scanned").
//
// PrivacyAudit.viewPrefsWiring.test.tsx already proves the two display toggles
// save the user's view choices. What was NOT covered is that the "Owner" and
// "Wallet" dropdowns actually scope which address records are fed into the
// audit. The runAudit loop filters the loaded address records by selectedOwner
// / selectedWallet before handing the survivors to runPrivacyAudit; a refactor
// could silently drop a filter and scan every record regardless of the user's
// selection. These tests assert the exact set of addresses passed to
// runPrivacyAudit for each selection, plus the "No Matching Records" path when
// a filter combination excludes everything.
//
// We back the real Dexie database with fake-indexeddb so the real
// getRecordsPageByTypeIdReverseKeyset / countRecordsByType run against seeded
// rows, and we spy on runPrivacyAudit to capture the addresses it receives
// without running the real (network/worker heavy) audit. The radix Select is
// swapped for a plain native <select> (the same approach used by the other
// page tests in this repo) so an option can be chosen via fireEvent.change.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import type { PrivacyAuditResult } from "@/lib/privacy-audit";

// recharts' ResponsiveContainer (used by the score-breakdown chart that renders
// after a completed audit) needs ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// Swap the radix Select for a native <select> so options can be chosen with
// fireEvent.change. The mock mirrors the Select API the page relies on:
// `value` + `onValueChange` on <Select>, the trigger's data-testid (so the
// rendered <select> keeps the same test id), and <SelectItem> → <option>.
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

// A fixed audit result so the page completes without running the real audit.
const MOCK_RESULT: PrivacyAuditResult = {
  findings: [],
  warnings: [],
  transactionsAnalyzed: 0,
  addressesScanned: 0,
  isClean: true,
  score: 100,
  grade: "A",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

const runPrivacyAuditSpy = vi.fn(
  async (_addresses: string[], _onProgress?: (msg: string) => void) => MOCK_RESULT,
);

vi.mock("@/lib/privacy-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/privacy-audit")>(
    "@/lib/privacy-audit",
  );
  return {
    ...actual,
    runPrivacyAudit: (...args: unknown[]) =>
      (runPrivacyAuditSpy as unknown as (...a: unknown[]) => Promise<PrivacyAuditResult>)(
        ...args,
      ),
  };
});

const { createRecord } = await import("@/lib/dataFacade");
const { createOwner, createWalletName } = await import(
  "@/lib/data/vocabulary-crud"
);
const { clearAllRecords } = await import("@/lib/data/record-crud");
const { clearAllTransactionData } = await import("@/lib/data/transaction-crud");
const { clearPrivacyAuditHistory, getPrivacyAuditHistory } = await import(
  "@/lib/data/privacy-history-crud"
);
const { clearSettings } = await import("@/lib/data/settings-crud");
const { db } = await import("@/lib/database");
const { default: PrivacyAudit } = await import("./PrivacyAudit");

// Distinct addresses, owners and wallets so each filter selects a known subset.
const ADDR_ALICE_COLD = "bc1qalicecold0000000000000000000000000000xx";
const ADDR_ALICE_HOT = "bc1qalicehot00000000000000000000000000000xx";
const ADDR_BOB_HOT = "bc1qbobhot0000000000000000000000000000000xx";

async function seedFixture() {
  await createOwner("Alice");
  await createOwner("Bob");
  await createWalletName("Cold");
  await createWalletName("Hot");

  await createRecord(
    {
      type: "address",
      inputString: ADDR_ALICE_COLD,
      label: "Alice Cold",
      source: "manual",
      tags: [],
      categories: [],
      owner: "Alice",
      walletName: "Cold",
    },
    { skipVocabularySync: true },
  );
  await createRecord(
    {
      type: "address",
      inputString: ADDR_ALICE_HOT,
      label: "Alice Hot",
      source: "manual",
      tags: [],
      categories: [],
      owner: "Alice",
      walletName: "Hot",
    },
    { skipVocabularySync: true },
  );
  await createRecord(
    {
      type: "address",
      inputString: ADDR_BOB_HOT,
      label: "Bob Hot",
      source: "manual",
      tags: [],
      categories: [],
      owner: "Bob",
      walletName: "Hot",
    },
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

// The addresses passed into the most recent runPrivacyAudit call, sorted so the
// assertions don't depend on the (reverse-keyset) scan order.
function lastAuditedAddresses(): string[] {
  const call = runPrivacyAuditSpy.mock.calls.at(-1);
  return [...((call?.[0] as string[]) ?? [])].sort();
}

async function clearAll() {
  await clearAllRecords({ skipNotification: true });
  await clearAllTransactionData({ skipNotification: true });
  await clearPrivacyAuditHistory();
  await clearSettings({ skipNotification: true });
  await db.owners.clear();
  await db.walletNames.clear();
}

beforeEach(async () => {
  await clearAll();
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await clearAll();
});

describe("Privacy Audit owner/wallet filter scoping", () => {
  it("scans every address when no filter is selected", async () => {
    await seedFixture();
    const { getByTestId } = renderPage();

    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => expect(runPrivacyAuditSpy).toHaveBeenCalledTimes(1));
    expect(lastAuditedAddresses()).toEqual(
      [ADDR_ALICE_COLD, ADDR_ALICE_HOT, ADDR_BOB_HOT].sort(),
    );
  });

  it("passes only the selected owner's addresses to runPrivacyAudit", async () => {
    await seedFixture();
    const { getByTestId } = renderPage();

    // Wait for the owner options (driven by the live db.owners query) to load.
    await waitFor(() => {
      const select = getByTestId("select-owner") as HTMLSelectElement;
      expect(
        Array.from(select.options).some((o) => o.value === "Alice"),
      ).toBe(true);
    });

    fireEvent.change(getByTestId("select-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => expect(runPrivacyAuditSpy).toHaveBeenCalledTimes(1));
    // Bob's address must be excluded; only Alice's two addresses are scanned.
    expect(lastAuditedAddresses()).toEqual(
      [ADDR_ALICE_COLD, ADDR_ALICE_HOT].sort(),
    );
  });

  it("passes only the selected wallet's addresses to runPrivacyAudit", async () => {
    await seedFixture();
    const { getByTestId } = renderPage();

    await waitFor(() => {
      const select = getByTestId("select-wallet") as HTMLSelectElement;
      expect(
        Array.from(select.options).some((o) => o.value === "Cold"),
      ).toBe(true);
    });

    fireEvent.change(getByTestId("select-wallet"), {
      target: { value: "Cold" },
    });
    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => expect(runPrivacyAuditSpy).toHaveBeenCalledTimes(1));
    // Only the single "Cold" wallet address survives the filter.
    expect(lastAuditedAddresses()).toEqual([ADDR_ALICE_COLD]);
  });

  it("combines owner and wallet filters when both are selected", async () => {
    await seedFixture();
    const { getByTestId } = renderPage();

    await waitFor(() => {
      const owner = getByTestId("select-owner") as HTMLSelectElement;
      const wallet = getByTestId("select-wallet") as HTMLSelectElement;
      expect(Array.from(owner.options).some((o) => o.value === "Alice")).toBe(true);
      expect(Array.from(wallet.options).some((o) => o.value === "Hot")).toBe(true);
    });

    fireEvent.change(getByTestId("select-owner"), { target: { value: "Alice" } });
    fireEvent.change(getByTestId("select-wallet"), { target: { value: "Hot" } });
    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => expect(runPrivacyAuditSpy).toHaveBeenCalledTimes(1));
    // Alice + Hot matches exactly one record.
    expect(lastAuditedAddresses()).toEqual([ADDR_ALICE_HOT]);
  });

  it("shows 'No Matching Records' and never runs the audit when a filter combination excludes everything", async () => {
    await seedFixture();
    const { getByTestId, findByText } = renderPage();

    await waitFor(() => {
      const owner = getByTestId("select-owner") as HTMLSelectElement;
      const wallet = getByTestId("select-wallet") as HTMLSelectElement;
      expect(Array.from(owner.options).some((o) => o.value === "Bob")).toBe(true);
      expect(Array.from(wallet.options).some((o) => o.value === "Cold")).toBe(true);
    });

    // Bob only owns a "Hot" wallet address, so Bob + Cold matches nothing.
    fireEvent.change(getByTestId("select-owner"), { target: { value: "Bob" } });
    fireEvent.change(getByTestId("select-wallet"), { target: { value: "Cold" } });
    fireEvent.click(getByTestId("button-run-audit"));

    await findByText("No Matching Records");
    expect(runPrivacyAuditSpy).not.toHaveBeenCalled();
  });
});

describe("Privacy Audit history entry owner/wallet tagging", () => {
  it("tags the saved history entry with the selected owner (wallet left undefined)", async () => {
    await seedFixture();
    const { getByTestId } = renderPage();

    await waitFor(() => {
      const select = getByTestId("select-owner") as HTMLSelectElement;
      expect(
        Array.from(select.options).some((o) => o.value === "Alice"),
      ).toBe(true);
    });

    fireEvent.change(getByTestId("select-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => expect(runPrivacyAuditSpy).toHaveBeenCalledTimes(1));

    await waitFor(async () => {
      const history = await getPrivacyAuditHistory();
      expect(history).toHaveLength(1);
    });
    const history = await getPrivacyAuditHistory();
    expect(history[0].owner).toBe("Alice");
    expect(history[0].walletName).toBeUndefined();
  });

  it("tags the saved history entry with the selected wallet (owner left undefined)", async () => {
    await seedFixture();
    const { getByTestId } = renderPage();

    await waitFor(() => {
      const select = getByTestId("select-wallet") as HTMLSelectElement;
      expect(
        Array.from(select.options).some((o) => o.value === "Cold"),
      ).toBe(true);
    });

    fireEvent.change(getByTestId("select-wallet"), {
      target: { value: "Cold" },
    });
    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => expect(runPrivacyAuditSpy).toHaveBeenCalledTimes(1));

    await waitFor(async () => {
      const history = await getPrivacyAuditHistory();
      expect(history).toHaveLength(1);
    });
    const history = await getPrivacyAuditHistory();
    expect(history[0].walletName).toBe("Cold");
    expect(history[0].owner).toBeUndefined();
  });

  it("leaves owner and walletName undefined on the history entry when no filter is selected", async () => {
    await seedFixture();
    const { getByTestId } = renderPage();

    fireEvent.click(getByTestId("button-run-audit"));

    await waitFor(() => expect(runPrivacyAuditSpy).toHaveBeenCalledTimes(1));

    await waitFor(async () => {
      const history = await getPrivacyAuditHistory();
      expect(history).toHaveLength(1);
    });
    const history = await getPrivacyAuditHistory();
    expect(history[0].owner).toBeUndefined();
    expect(history[0].walletName).toBeUndefined();
  });
});
