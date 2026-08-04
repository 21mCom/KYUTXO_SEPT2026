// @vitest-environment jsdom
//
// Tests for the "In Vault" column in the Address Checker: rows whose address
// matches a saved `type: 'address'` record (case-insensitive) show a "Saved"
// badge with the record's label on hover, while unsaved, invalid, and
// non-address-type matches show "—". The membership lookup must resolve in a
// single batched call per run (never per-row) and recompute on Reset + re-run.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// Render every virtualized row (jsdom's zero-size scroll element would
// otherwise render none).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * 53,
        size: 53,
        end: (index + 1) * 53,
      })),
    getTotalSize: () => opts.count * 53,
    measureElement: () => {},
  }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: { id: "default", providerType: "mempool-space" } }),
}));

const getAddressCoreStats = vi.fn();
const createProviderFromSettings = vi.fn(() => ({ getAddressCoreStats }));
// The shared provider harness (RecordDetailPanel -> transaction-sync) imports
// more than createProviderFromSettings — keep the originals, override one.
vi.mock("@/lib/blockchain-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
}));

// Spy on the batched membership lookup while keeping the real implementation
// (and the real CRUD helpers used for seeding). Partial mock via
// importOriginal — a wholesale mock of the data module would break seeding.
const lookupSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...mod,
    getSavedAddressRecordLookup: (addresses: string[]) => {
      lookupSpy(addresses);
      return mod.getSavedAddressRecordLookup(addresses);
    },
  };
});

import AddressChecker from "./AddressChecker";
import { createRecord, clearAllRecords, getRecordsByInputString } from "@/lib/data/record-crud";

// Valid mainnet addresses.
const ADDR_SAVED = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const ADDR_UNSAVED = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ADDR_INVALID = "not-a-bitcoin-address";

async function runCheck() {
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: `${ADDR_SAVED}\n${ADDR_UNSAVED}\n${ADDR_INVALID}` },
  });
  fireEvent.click(screen.getByTestId("button-run-check"));
  await waitFor(() => {
    expect(screen.getByTestId("button-reset-check")).toBeTruthy();
  });
}

describe("AddressChecker — In Vault column", () => {
  beforeEach(async () => {
    cleanup();
    vi.clearAllMocks();
    await clearAllRecords();
    getAddressCoreStats.mockImplementation(async () => ({
      txCount: 3,
      receivedSats: 100000,
      sentSats: 40000,
      balanceSats: 60000,
    }));
    // Seed an address record with an UPPERCASE inputString: matching must be
    // case-insensitive against the pasted lowercase address.
    await createRecord({
      type: "address",
      inputString: ADDR_SAVED.toUpperCase(),
      label: "Savings wallet",
      tags: [],
      categories: [],
    });
    // A non-address record for the unsaved address must NOT count as a match.
    await createRecord({
      type: "txid",
      inputString: ADDR_UNSAVED,
      label: "Some transaction",
      tags: [],
      categories: [],
    });
  });

  it("flags saved addresses (case-insensitive, with label tooltip) and dashes the rest", async () => {
    renderWithProviders(<AddressChecker />);
    await runCheck();

    // Saved address → "Saved" badge carrying the record's label for hover.
    await waitFor(() => {
      expect(screen.getByTestId("badge-invault-0")).toBeTruthy();
    });
    const badge = screen.getByTestId("badge-invault-0");
    expect(badge.getAttribute("title")).toBe("Saved in vault: Savings wallet (click to open)");
    expect(screen.getByTestId("cell-invault-0").textContent).toContain("Saved");

    // Unsaved address (only a txid-type record exists for it) → neutral dash.
    expect(screen.queryByTestId("badge-invault-1")).toBeNull();
    expect(screen.getByTestId("cell-invault-1").textContent).toBe("—");

    // Invalid input → neutral dash.
    expect(screen.queryByTestId("badge-invault-2")).toBeNull();
    expect(screen.getByTestId("cell-invault-2").textContent).toBe("—");
  });

  it("resolves membership in one batched lookup per run, never per-row", async () => {
    renderWithProviders(<AddressChecker />);
    await runCheck();

    await waitFor(() => {
      expect(screen.getByTestId("badge-invault-0")).toBeTruthy();
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    const batchArg = lookupSpy.mock.calls[0][0] as string[];
    expect(batchArg).toEqual([ADDR_SAVED, ADDR_UNSAVED]);
  });

  it("recomputes the snapshot on Reset + re-run so newly saved addresses appear", async () => {
    renderWithProviders(<AddressChecker />);
    await runCheck();
    await waitFor(() => {
      expect(screen.getByTestId("badge-invault-0")).toBeTruthy();
    });
    expect(screen.getByTestId("cell-invault-1").textContent).toBe("—");

    // Save the previously unsaved address into the vault, then Reset + re-run.
    await createRecord({
      type: "address",
      inputString: ADDR_UNSAVED,
      label: "",
      tags: [],
      categories: [],
    });
    fireEvent.click(screen.getByTestId("button-reset-check"));
    await runCheck();

    await waitFor(() => {
      expect(screen.getByTestId("badge-invault-1")).toBeTruthy();
    });
    // Unlabeled record falls back to a generic tooltip.
    expect(screen.getByTestId("badge-invault-1").getAttribute("title")).toBe("Saved in vault (click to open)");
    expect(lookupSpy).toHaveBeenCalledTimes(2);
  });

  it("opens the saved record in the global preview panel when the badge is clicked", async () => {
    renderWithProviders(<AddressChecker />);
    await runCheck();

    await waitFor(() => {
      expect(screen.getByTestId("badge-invault-0")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("badge-invault-0"));

    // The global record detail panel opens showing the saved record's
    // identifier (canonicalized to lowercase on create) and its label —
    // proving the click resolved the actual saved record by id.
    await waitFor(() => {
      const identifier = screen.getByTestId("text-panel-identifier");
      expect(identifier.textContent).toBe(ADDR_SAVED);
    });
    expect(screen.getByText("Savings wallet")).toBeTruthy();
  });

  it("opens the labeled record when two saved records share the same address", async () => {
    // Two `type: 'address'` records for the same address: an UNLABELED one
    // created first and a LABELED one created second. The lookup must prefer
    // the labeled record, so the badge click must open it — the panel title
    // (the record's label) proves which record was opened.
    await createRecord({
      type: "address",
      inputString: ADDR_UNSAVED,
      label: "",
      tags: [],
      categories: [],
    });
    await createRecord({
      type: "address",
      inputString: ADDR_UNSAVED,
      label: "Labeled duplicate",
      tags: [],
      categories: [],
    });
    // Guard the fixture: both records must actually exist as separate rows,
    // otherwise the labeled-preference branch isn't exercised at all.
    // (beforeEach also seeds a txid-type record for this address; count only
    // the address-type rows the lookup considers.)
    const addressRows = (await getRecordsByInputString(ADDR_UNSAVED)).filter(
      (r) => r.type === "address"
    );
    expect(addressRows.length).toBe(2);

    renderWithProviders(<AddressChecker />);
    await runCheck();

    await waitFor(() => {
      expect(screen.getByTestId("badge-invault-1")).toBeTruthy();
    });
    // Tooltip carries the labeled record's label, not the generic fallback.
    expect(screen.getByTestId("badge-invault-1").getAttribute("title")).toBe(
      "Saved in vault: Labeled duplicate (click to open)"
    );

    fireEvent.click(screen.getByTestId("badge-invault-1"));
    // The panel title is the opened record's label: the labeled duplicate,
    // not the unlabeled record that was created first.
    await waitFor(() => {
      expect(screen.getByText("Labeled duplicate")).toBeTruthy();
      expect(screen.getByTestId("text-panel-identifier").textContent).toBe(ADDR_UNSAVED);
    });
  });

  it("keeps unmatched and invalid rows non-interactive", async () => {
    renderWithProviders(<AddressChecker />);
    await runCheck();

    await waitFor(() => {
      expect(screen.getByTestId("badge-invault-0")).toBeTruthy();
    });
    // No badge (and hence no button) for unmatched/invalid rows.
    expect(screen.queryByTestId("badge-invault-1")).toBeNull();
    expect(screen.getByTestId("cell-invault-1").querySelector("button")).toBeNull();
    expect(screen.queryByTestId("badge-invault-2")).toBeNull();
    expect(screen.getByTestId("cell-invault-2").querySelector("button")).toBeNull();
  });
});
