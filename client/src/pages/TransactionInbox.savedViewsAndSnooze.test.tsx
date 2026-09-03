// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/lib/db-types";

const TXID = "a".repeat(64);
const mockUpdateTransactionCuration = vi.fn(async () => true);
const mockUpdateSettings = vi.fn(async (_id: string, changes: Partial<Settings>) => {
  mockSettings = { ...mockSettings, ...changes } as Settings;
});
let mockSettings: Settings;

vi.mock("dexie-react-hooks", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useLiveQuery: (query: () => unknown, deps: unknown[], defaultValue?: unknown) => {
      const [value, setValue] = React.useState(defaultValue);
      React.useEffect(() => {
        let active = true;
        void Promise.resolve(query()).then(result => {
          if (active) setValue(result);
        });
        return () => { active = false; };
      }, deps);
      return value;
    },
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      start: index * 100,
    })),
    measureElement: () => undefined,
  }),
}));

vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => 0,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: vi.fn(async () => mockSettings),
  ensureSettings: vi.fn(async () => mockSettings),
  updateSettings: (...args: Parameters<typeof mockUpdateSettings>) => mockUpdateSettings(...args),
}));

vi.mock("@/lib/data/record-crud", () => ({
  bulkGetRecords: vi.fn(async () => []),
  createRecord: vi.fn(),
  getRecordsByInputStrings: vi.fn(async () => []),
  updateRecord: vi.fn(),
}));

vi.mock("@/lib/participant-repo", () => ({
  fetchParticipantsByTxids: vi.fn(async () => []),
}));

vi.mock("@/lib/data/transaction-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/transaction-crud")>();
  return {
    ...actual,
    countTransactionCurations: vi.fn(async () => 1),
    getTransactionsByCurationState: vi.fn(async () => [{
      id: 1,
      txid: TXID,
      curationState: "new",
      blockTime: 1_700_000_000,
    }]),
    updateTransactionCuration: (...args: Parameters<typeof mockUpdateTransactionCuration>) =>
      mockUpdateTransactionCuration(...args),
  };
});

vi.mock("@/pages/Transactions", () => ({
  TransactionCard: ({ tx }: { tx: { txid: string } }) => <div>{tx.txid}</div>,
}));

vi.mock("@/components/TransactionSearchFilters", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const defaultFilters = { dateMode: "any", amountMode: "any" };
  return {
    defaultFilters,
    filterByDateAndAmount: (rows: unknown[]) => rows,
    TransactionSearchFilters: ({
      filters,
      onChange,
    }: {
      filters: Record<string, unknown>;
      onChange: (next: Record<string, unknown>) => void;
    }) => (
      <div>
        <button onClick={() => onChange({
          ...filters,
          amountMode: "range",
          amountMinBtc: 2,
        })}>Set amount filter</button>
        <span data-testid="inbox-filter-state">{JSON.stringify(filters)}</span>
      </div>
    ),
  };
});

const { default: TransactionInbox } = await import("./TransactionInbox");

beforeEach(() => {
  mockUpdateSettings.mockClear();
  mockUpdateTransactionCuration.mockClear();
  mockSettings = {
    id: "default",
    fieldVisibility: {
      seedName: true,
      walletSoftware: true,
      privateKeyStatus: false,
      owner: true,
      walletName: true,
      source: true,
    },
    tableColumns: {
      tags: true,
      categories: false,
      walletSoftware: false,
      seedName: false,
      privateKeyStatus: false,
      hasAttachments: true,
      owner: false,
      walletName: false,
      source: false,
      firstSeen: true,
      balance: false,
      lastTxDate: false,
      txCount: false,
    },
    customFieldColumns: {},
    theme: "light",
    defaultView: "table",
    cancelConfirmThreshold: 75,
    savedInboxViews: [{
      id: "existing-view",
      name: "Invoices",
      tab: "new",
      search: "restored search",
      filters: { dateMode: "any", amountMode: "exact", amountExactBtc: 1 },
      createdAt: 1,
    }],
  };
});

afterEach(() => cleanup());

describe("Transaction Inbox saved views and snooze choices", () => {
  it("restores and saves named filter views", async () => {
    render(<TransactionInbox />);

    const select = await screen.findByTestId("select-inbox-saved-view");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    fireEvent.change(select, { target: { value: "existing-view" } });

    expect((screen.getByTestId("input-inbox-search") as HTMLInputElement).value)
      .toBe("restored search");
    expect(screen.getByTestId("inbox-filter-state").textContent)
      .toContain('"amountExactBtc":1');

    fireEvent.click(screen.getByText("Set amount filter"));
    fireEvent.change(screen.getByTestId("input-inbox-view-name"), {
      target: { value: "Large invoices" },
    });
    fireEvent.click(screen.getByTestId("button-inbox-save-view"));

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
    const changes = mockUpdateSettings.mock.calls.at(-1)?.[1];
    expect(changes?.savedInboxViews).toHaveLength(2);
    expect(changes?.savedInboxViews?.[1]).toMatchObject({
      name: "Large invoices",
      search: "restored search",
      filters: { amountMode: "range", amountMinBtc: 2 },
    });
  });

  it("offers presets and applies a one-week snooze without removing the row", async () => {
    render(<TransactionInbox />);

    fireEvent.click(await screen.findByLabelText(`Select ${TXID}`));
    const trigger = screen.getByTestId("button-inbox-snooze");
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);

    const before = Date.now();
    fireEvent.click(await screen.findByTestId("button-inbox-snooze-week"));
    await waitFor(() => expect(mockUpdateTransactionCuration).toHaveBeenCalled());

    const [txid, state, options] = mockUpdateTransactionCuration.mock.calls[0];
    expect(txid).toBe(TXID);
    expect(state).toBe("snoozed");
    expect(options.snoozedUntil).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000);
    expect(options.snoozedUntil).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000);
  });

  it("accepts a custom snooze date", async () => {
    render(<TransactionInbox />);

    fireEvent.click(await screen.findByLabelText(`Select ${TXID}`));
    const trigger = screen.getByTestId("button-inbox-snooze");
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    fireEvent.change(await screen.findByTestId("button-inbox-snooze-date"), {
      target: { value: "2099-12-31" },
    });
    fireEvent.click(screen.getByTestId("button-inbox-snooze-custom"));

    await waitFor(() => expect(mockUpdateTransactionCuration).toHaveBeenCalled());
    expect(mockUpdateTransactionCuration.mock.calls[0][2].snoozedUntil)
      .toBe(new Date(2099, 11, 31, 23, 59, 59, 999).getTime());
  });
});