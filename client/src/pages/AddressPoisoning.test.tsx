// @vitest-environment jsdom
//
// Page-level test for the Address Poisoning scanner: seeds poisoning-shaped
// fixtures (dust-sized inbound from a lookalike counterparty), runs the scan,
// asserts the results render with heuristics + highlighting, then applies tags
// and verifies they persist to records and the tag vocabulary — union-merged,
// never double-tagged, with a discovered-tier record created for the unknown
// suspect address.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords, getRecordsByInputString } from "@/lib/data/record-crud";
import { bulkAddParticipants, clearParticipants } from "@/lib/data/transaction-crud";
import AddressPoisoning from "./AddressPoisoning";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// jsdom has no layout, so the real virtualizer measures a 0-height scroll
// element and renders nothing. Render every row instead.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 132,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 132,
      getVirtualItems: () => items,
    };
  },
}));

const TXID_DUST = "a".repeat(64);
const TXID_CLEAN = "b".repeat(64);

// Victim + lookalike share leading "bc1qpoison" and trailing "zz777".
const VICTIM = "bc1qpoisontarget000000000000000zz777";
const LOOKALIKE = "bc1qpoisonattack99999999999999zz777";
const STRANGER = "bc1qstranger0000000000000000000000";

async function seed() {
  const victimRecordId = await createRecord({
    type: "address",
    inputString: VICTIM,
    label: "My receiving address",
    tags: [],
    categories: [],
    walletName: "Savings",
  });
  await bulkAddParticipants([
    // The poisoning attempt: dust to the victim from the lookalike.
    { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
    { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 600 },
    // A clean, non-dust payment from an unrelated address (never flagged).
    { txid: TXID_CLEAN, role: "output", address: VICTIM, amount: 25_000, vout: 0 },
    { txid: TXID_CLEAN, role: "input", address: STRANGER, amount: 30_000 },
  ]);
  return { victimRecordId };
}

async function lastToast() {
  await waitFor(() => expect(toastSpy).toHaveBeenCalled());
  return toastSpy.mock.calls[toastSpy.mock.calls.length - 1][0];
}

describe("AddressPoisoning page", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    toastSpy.mockClear();
    await clearAllRecords();
    await clearParticipants();
    await db.tags.clear();
  });

  it("renders scan results with heuristics, highlighting, and summary", async () => {
    await seed();
    renderWithProviders(<AddressPoisoning />);

    fireEvent.click(await screen.findByTestId("button-run-scan"));

    // Summary banner.
    const summary = await screen.findByTestId("text-summary", {}, { timeout: 10000 });
    expect(summary.textContent).toContain("1");
    expect(summary.textContent).toContain("high-confidence");

    // Group header for the targeted address + suspect row.
    await screen.findByTestId(`group-${VICTIM}`);
    await screen.findByTestId(`row-suspect-${LOOKALIKE}`);

    // Confidence + heuristic badges.
    const confidence = await screen.findByTestId(`badge-confidence-${LOOKALIKE}`);
    expect(confidence.textContent).toBe("high");
    await screen.findByTestId(`badge-heuristic-${LOOKALIKE}-dust-sized`);
    await screen.findByTestId(`badge-heuristic-${LOOKALIKE}-lookalike`);
    await screen.findByTestId(`badge-heuristic-${LOOKALIKE}-unknown-sender`);
    await screen.findByTestId(`badge-heuristic-${LOOKALIKE}-one-time-counterparty`);

    // Lookalike characters are highlighted (leading + trailing runs).
    const highlight = await screen.findByTestId(`highlight-${LOOKALIKE}`);
    const marks = highlight.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("bc1qpoison");
    expect(marks[1].textContent).toBe("zz777");

    // Dust output detail.
    const dust = await screen.findByTestId(`text-dust-${LOOKALIKE}`);
    expect(dust.textContent).toContain("546");
    expect(dust.textContent).toContain(`${TXID_DUST.slice(0, 12)}`);

    // The clean payment never produced a suspect row.
    expect(screen.queryByTestId(`row-suspect-${STRANGER}`)).toBeNull();
  });

  it("applies tags to a suspect: creates a discovered-tier record and tag vocabulary", async () => {
    await seed();
    renderWithProviders(<AddressPoisoning />);

    fireEvent.click(await screen.findByTestId("button-run-scan"));
    const tagButton = await screen.findByTestId(`button-tag-suspect-${LOOKALIKE}`, {}, { timeout: 10000 });
    expect(tagButton.textContent).toContain("Tag suspect");
    fireEvent.click(tagButton);

    // A new record was created for the unknown suspect, carrying the tag.
    await waitFor(async () => {
      const recs = await getRecordsByInputString(LOOKALIKE);
      expect(recs).toHaveLength(1);
      expect(recs[0].tags).toEqual(["suspected-poisoning"]);
      expect(recs[0].addressImportance).toBe("blockchain-discovered");
      expect(recs[0].discoveredInTxid).toBe(TXID_DUST);
    });

    // The tag vocabulary row exists.
    await waitFor(async () => {
      const tagRows = await db.tags.toArray();
      expect(tagRows.map((t) => t.name)).toContain("suspected-poisoning");
    });

    // Row now shows the applied tag and the button flips to its tagged state.
    await screen.findByTestId(`badge-tag-${LOOKALIKE}-suspected-poisoning`);
    await waitFor(() => {
      expect(screen.getByTestId(`button-tag-suspect-${LOOKALIKE}`).textContent).toContain("Tagged");
    });

    const toast = await lastToast();
    expect(toast.title).toBe("Tags applied");
    expect(toast.description).toContain("created 1 new record");
  });

  it("does not double-tag when tagging is repeated", async () => {
    await seed();
    renderWithProviders(<AddressPoisoning />);

    fireEvent.click(await screen.findByTestId("button-run-scan"));
    const tagButton = await screen.findByTestId(`button-tag-suspect-${LOOKALIKE}`, {}, { timeout: 10000 });
    fireEvent.click(tagButton);
    await screen.findByTestId(`badge-tag-${LOOKALIKE}-suspected-poisoning`);

    // The button now reads "Tagged" and is disabled — no second application.
    await waitFor(() => {
      const btn = screen.getByTestId(`button-tag-suspect-${LOOKALIKE}`);
      expect(btn.textContent).toContain("Tagged");
      expect(btn).toHaveProperty("disabled", true);
    });

    const recs = await getRecordsByInputString(LOOKALIKE);
    expect(recs).toHaveLength(1);
    expect(recs[0].tags).toEqual(["suspected-poisoning"]);
  });

  it("union-merges tags onto an existing suspect record instead of replacing", async () => {
    await seed();
    // The suspect address already has a record with its own tags.
    await createRecord({
      type: "address",
      inputString: LOOKALIKE,
      label: "Known exchange",
      tags: ["exchange"],
      categories: [],
    });

    renderWithProviders(<AddressPoisoning />);
    fireEvent.click(await screen.findByTestId("button-run-scan"));
    const tagButton = await screen.findByTestId(`button-tag-suspect-${LOOKALIKE}`, {}, { timeout: 10000 });
    fireEvent.click(tagButton);

    await waitFor(async () => {
      const recs = await getRecordsByInputString(LOOKALIKE);
      expect(recs).toHaveLength(1);
      expect(recs[0].tags).toEqual(expect.arrayContaining(["exchange", "suspected-poisoning"]));
      // Pre-existing label untouched.
      expect(recs[0].label).toBe("Known exchange");
    });
  });

  it("tags the user's own targeted address from a result row", async () => {
    await seed();
    renderWithProviders(<AddressPoisoning />);

    fireEvent.click(await screen.findByTestId("button-run-scan"));
    const tagTargetButton = await screen.findByTestId(`button-tag-target-${LOOKALIKE}`, {}, { timeout: 10000 });
    fireEvent.click(tagTargetButton);

    await waitFor(async () => {
      const recs = await getRecordsByInputString(VICTIM);
      expect(recs).toHaveLength(1);
      expect(recs[0].tags).toEqual(["poisoning-target"]);
    });

    await screen.findByTestId(`badge-target-tag-${VICTIM}-poisoning-target`);
  });

  it("bulk tag-all action tags every untagged suspect at once", async () => {
    await seed();
    renderWithProviders(<AddressPoisoning />);

    fireEvent.click(await screen.findByTestId("button-run-scan"));
    const tagAll = await screen.findByTestId("button-tag-all-suspects", {}, { timeout: 10000 });
    expect(tagAll.textContent).toContain("(1)");
    fireEvent.click(tagAll);

    await waitFor(async () => {
      const recs = await getRecordsByInputString(LOOKALIKE);
      expect(recs).toHaveLength(1);
      expect(recs[0].tags).toEqual(["suspected-poisoning"]);
    });

    // Nothing left to tag — the bulk action drains to zero and disables.
    await waitFor(() => {
      const btn = screen.getByTestId("button-tag-all-suspects");
      expect(btn.textContent).toContain("(0)");
      expect(btn).toHaveProperty("disabled", true);
    });
  });

  it("shows the empty state when no poisoning is found", async () => {
    await createRecord({
      type: "address",
      inputString: VICTIM,
      label: "Clean address",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      { txid: TXID_CLEAN, role: "output", address: VICTIM, amount: 25_000, vout: 0 },
      { txid: TXID_CLEAN, role: "input", address: STRANGER, amount: 30_000 },
    ]);

    renderWithProviders(<AddressPoisoning />);
    fireEvent.click(await screen.findByTestId("button-run-scan"));
    await screen.findByTestId("state-empty", {}, { timeout: 10000 });
  });
});
