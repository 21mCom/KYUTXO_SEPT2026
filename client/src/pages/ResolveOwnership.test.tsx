// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const { repository, decide, undo } = vi.hoisted(() => ({
  repository: { list: vi.fn(), get: vi.fn().mockResolvedValue(undefined) },
  decide: vi.fn(),
  undo: vi.fn(),
}));

vi.mock("@/lib/repository", () => ({ getVaultRepository: () => repository }));
vi.mock("@/hooks/use-db-change-signal", () => ({ useDbChangeSignal: () => 0 }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/ownership-resolution", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/ownership-resolution")>();
  return { ...actual, decideOwnership: decide, undoOwnershipDecision: undo };
});

import { OWNERSHIP_REVIEW_LIMITS } from "@/lib/ownership-resolution";
import ResolveOwnership, { ownershipSuggestionValue } from "./ResolveOwnership";

const address = (id: number, inputString: string, cachedBalanceSats = 0) => ({
  id, type: "address" as const, inputString, label: "", tags: [], categories: [], cachedBalanceSats,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe("ResolveOwnership", () => {
  afterEach(() => cleanup());

  it("ranks review evidence by cached value, exposes evidence, and requires cluster confirmation", async () => {
    const records = [address(1, "bc1low", 10), address(2, "bc1high", 200), address(3, "bc1known", 0)];
    repository.list.mockImplementation((table: string) => Promise.resolve({
      rows: table === "records" ? records : table === "addressOwnership"
        ? [{ id: 1, recordId: 2, state: "undetermined", walletId: 12, createdAt: 1, updatedAt: 1 }, { id: 2, recordId: 3, state: "assigned", entityId: 7, createdAt: 1, updatedAt: 1 }]
        : table === "transactionParticipants"
          ? [{ txid: "tx-evidence", role: "input", recordId: 2 }, { txid: "tx-evidence", role: "input", recordId: 3 }]
          : table === "entities" ? [{ id: 7, name: "Alice", naturalKey: "self:alice", kind: "self", createdAt: 1, updatedAt: 1 }] : [],
    }));
    const { getAllByTestId, getByTestId } = render(<ResolveOwnership />);
    await waitFor(() => expect(getAllByTestId(/ownership-suggestion-/).length).toBeGreaterThan(0));
    expect(getAllByTestId(/ownership-suggestion-/)[0].getAttribute("data-testid")).toBe("ownership-suggestion-2");
    fireEvent.click(getByTestId("button-ownership-inspect-2"));
    expect(getByTestId("ownership-evidence-2").textContent).toContain("tx-evidence");
    fireEvent.click(getByTestId("button-ownership-cluster-2"));
    expect(getByTestId("button-ownership-confirm-action")).toBeTruthy();
  });

  it("offers a wallet cascade with an exact bounded affected-address count", async () => {
    const records = [address(1, "bc1wallet", 50), address(2, "bc1known")];
    repository.list.mockImplementation((table: string) => Promise.resolve({
      rows: table === "records" ? records : table === "addressOwnership"
        ? [{ id: 1, recordId: 1, state: "undetermined", walletId: 44, createdAt: 1, updatedAt: 1 }, { id: 2, recordId: 2, state: "assigned", entityId: 7, createdAt: 1, updatedAt: 1 }]
        : table === "transactionParticipants" ? [{ txid: "wallet-tx", role: "input", recordId: 1 }, { txid: "wallet-tx", role: "input", recordId: 2 }]
          : table === "entities" ? [{ id: 7, name: "Alice", naturalKey: "self:alice", kind: "self", createdAt: 1, updatedAt: 1 }] : [],
    }));
    const { getByTestId } = render(<ResolveOwnership />);
    await waitFor(() => expect(getByTestId("button-ownership-wallet-1")).toBeTruthy());
    fireEvent.click(getByTestId("button-ownership-wallet-1"));
    expect(getByTestId("button-ownership-confirm-action").parentElement?.parentElement?.textContent).toContain("exactly 1 unresolved addresses");
    expect(getByTestId("ownership-scope-notice").textContent).toContain("bounded");
  });

  it("does not offer an atomic wallet action beyond the disclosed limit", async () => {
    const unresolved = Array.from({ length: 2_001 }, (_, index) => ({
      id: index + 1,
      recordId: index + 1,
      state: "undetermined",
      walletId: 44,
      createdAt: 1,
      updatedAt: 1,
    }));
    repository.list.mockImplementation((table: string) => Promise.resolve({
      rows: table === "records" ? [address(1, "bc1large-wallet", 50), address(3_000, "bc1known")]
        : table === "addressOwnership" ? [...unresolved, { id: 3_000, recordId: 3_000, state: "assigned", entityId: 7, createdAt: 1, updatedAt: 1 }]
          : table === "transactionParticipants" ? [{ txid: "wallet-tx", role: "input", recordId: 1 }, { txid: "wallet-tx", role: "input", recordId: 3_000 }]
            : table === "entities" ? [{ id: 7, name: "Alice", naturalKey: "self:alice", kind: "self", createdAt: 1, updatedAt: 1 }] : [],
    }));
    const { getByTestId } = render(<ResolveOwnership />);
    const button = await waitFor(() => getByTestId("button-ownership-wallet-1") as HTMLButtonElement);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("exceeds atomic limit");
    expect(button.title).toContain("2,000-address atomic review limit");
  });

  it("keeps an unknown proposed owner visibly Unassigned and filters it", async () => {
    repository.list.mockImplementation((table: string) => Promise.resolve({
      rows: table === "records" ? [address(1, "bc1unknown", 12), address(2, "bc1source")]
        : table === "addressOwnership" ? [{ id: 1, recordId: 2, state: "assigned", entityId: 99, createdAt: 1, updatedAt: 1 }]
          : table === "transactionParticipants" ? [{ txid: "tx", role: "input", recordId: 1 }, { txid: "tx", role: "input", recordId: 2 }] : [],
    }));
    const { getByTestId } = render(<ResolveOwnership />);
    await waitFor(() => expect(getByTestId("ownership-owner-1").textContent).toContain("Unassigned"));
    fireEvent.change(getByTestId("input-ownership-search"), { target: { value: "does-not-match" } });
    await waitFor(() => expect(getByTestId("ownership-empty")).toBeTruthy());
  });

  it("confirms and undoes a decision without reloading the bounded evidence scope", async () => {
    const records = [address(1, "bc1target", 12), address(2, "bc1source")];
    repository.list.mockImplementation((table: string) => Promise.resolve({
      rows: table === "records" ? records
        : table === "addressOwnership" ? [{ id: 2, recordId: 2, state: "assigned", entityId: 7, createdAt: 1, updatedAt: 1 }]
          : table === "transactionParticipants" ? [{ txid: "tx", role: "input", recordId: 1, amount: 1 }, { txid: "tx", role: "input", recordId: 2, amount: 1 }]
            : [],
      cursor: undefined,
    }));
    decide.mockResolvedValue({
      id: "ownership-v1:local-state",
      evidenceFingerprint: "ownership-v1:local-state",
      state: "accepted",
      action: "assign",
      recordIds: [1],
      entityId: 7,
      previousOwnership: [],
      createdOwnershipRecordIds: [1],
      undoToken: "ownership-v1:local-state:10",
      createdAt: 10,
      updatedAt: 10,
    });
    undo.mockResolvedValue(true);
    const { getByTestId } = render(<ResolveOwnership />);
    await waitFor(() => expect(getByTestId("button-ownership-assign-1")).toBeTruthy());
    const readsAfterInitialLoad = repository.list.mock.calls.length;

    fireEvent.click(getByTestId("button-ownership-assign-1"));
    await waitFor(() => expect(getByTestId("button-ownership-undo")).toBeTruthy());
    expect(repository.list).toHaveBeenCalledTimes(readsAfterInitialLoad);
    fireEvent.click(getByTestId("button-ownership-undo"));
    await waitFor(() => expect(undo).toHaveBeenCalled());
    expect(repository.list).toHaveBeenCalledTimes(readsAfterInitialLoad);
  });

  it("does not commit an older scope load after a newer load completes", async () => {
    const loads = Array.from({ length: 8 }, () => deferred<{ rows: unknown[]; cursor?: number }>());
    let loadCall = 0;
    repository.list.mockClear();
    repository.list.mockImplementation(() => loads[loadCall++].promise);
    const oldRecords = [address(1, "bc1old-target"), address(2, "bc1old-source")];
    const newRecords = [address(11, "bc1new-target"), address(12, "bc1new-source")];
    const response = (records: ReturnType<typeof address>[]) => (table: string) => ({
      rows: table === "records" ? records
        : table === "addressOwnership" ? [{ id: 1, recordId: records[1].id, state: "assigned", entityId: 7, createdAt: 1, updatedAt: 1 }]
          : table === "transactionParticipants" ? [{ txid: `${records[0].inputString}-tx`, role: "input", recordId: records[0].id }, { txid: `${records[0].inputString}-tx`, role: "input", recordId: records[1].id }]
            : [],
    });

    const { getByTestId, queryByTestId } = render(<ResolveOwnership />);
    await waitFor(() => expect(repository.list).toHaveBeenCalledTimes(4));
    const oldResponse = response(oldRecords);
    const newResponse = response(newRecords);
    fireEvent.click(getByTestId("button-ownership-load-more-scope"));
    await waitFor(() => expect(repository.list).toHaveBeenCalledTimes(8));

    [4, 5, 6, 7].forEach((index, offset) => loads[index].resolve(newResponse(["records", "addressOwnership", "transactionParticipants", "ownershipReviewDecisions"][offset])));
    await waitFor(() => expect(getByTestId("ownership-suggestion-11")).toBeTruthy());
    [0, 1, 2, 3].forEach((index, offset) => loads[index].resolve(oldResponse(["records", "addressOwnership", "transactionParticipants", "ownershipReviewDecisions"][offset])));
    await waitFor(() => expect(queryByTestId("ownership-suggestion-11")).toBeTruthy());
    expect(queryByTestId("ownership-suggestion-1")).toBeNull();
  });

  it("renders and filters the maximum local evidence scope within the UI budget", async () => {
    const records = Array.from({ length: OWNERSHIP_REVIEW_LIMITS.records }, (_, index) =>
      address(index + 1, `bc1quiscale${index}`, index));
    records.slice(1).forEach((record, index) => {
      Object.assign(record, { discoveredFromRecordId: 1, discoveredInTxid: `ui-scale-tx-${index}` });
    });
    const ownership = records.map((record, index) => ({
      id: index + 1,
      recordId: record.id,
      state: index === 0 ? "assigned" : "undetermined",
      entityId: index === 0 ? 7 : undefined,
      createdAt: 1,
      updatedAt: 1,
    }));
    const participants = Array.from({ length: OWNERSHIP_REVIEW_LIMITS.participants }, (_, index) => ({
      id: index + 1,
      txid: `ui-scale-tx-${Math.floor(index / 2)}`,
      role: "input",
      recordId: (index % OWNERSHIP_REVIEW_LIMITS.records) + 1,
      amount: 1,
    }));
    const rowsByTable: Record<string, any[]> = {
      records,
      addressOwnership: ownership,
      transactionParticipants: participants,
      ownershipReviewDecisions: [],
    };
    repository.list.mockImplementation((table: string, options: { cursor?: number; limit: number }) => {
      const rows = rowsByTable[table] ?? [];
      const start = options.cursor ?? 0;
      const page = rows.slice(start, start + options.limit);
      return Promise.resolve({ rows: page, cursor: start + page.length < rows.length ? start + page.length : undefined });
    });

    const renderStarted = performance.now();
    const { getAllByTestId, getByTestId } = render(<ResolveOwnership />);
    await waitFor(() => expect(getAllByTestId(/ownership-suggestion-/)).toHaveLength(OWNERSHIP_REVIEW_LIMITS.suggestions), { timeout: 10_000 });
    expect(performance.now() - renderStarted).toBeLessThan(10_000);

    const filterStarted = performance.now();
    fireEvent.change(getByTestId("input-ownership-search"), { target: { value: "bc1quiscale1999" } });
    await waitFor(() => expect(getAllByTestId(/ownership-suggestion-/)).toHaveLength(1), { timeout: 2_000 });
    expect(performance.now() - filterStarted).toBeLessThan(2_000);
    expect(repository.list.mock.calls.every(([, options]) => options.limit <= 500)).toBe(true);
  }, 15_000);

  it("sums only positive cached sats for ranking", () => {
    expect(ownershipSuggestionValue({ recordIds: [1, 2] } as any, [address(1, "a", -5), address(2, "b", 9)])).toBe(9);
  });
});