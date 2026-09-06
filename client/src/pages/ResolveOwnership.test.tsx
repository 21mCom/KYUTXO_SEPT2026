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

import ResolveOwnership, { ownershipSuggestionValue } from "./ResolveOwnership";

const address = (id: number, inputString: string, cachedBalanceSats = 0) => ({
  id, type: "address" as const, inputString, label: "", tags: [], categories: [], cachedBalanceSats,
});

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

  it("sums only positive cached sats for ranking", () => {
    expect(ownershipSuggestionValue({ recordIds: [1, 2] } as any, [address(1, "a", -5), address(2, "b", 9)])).toBe(9);
  });
});