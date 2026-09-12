// @vitest-environment jsdom
//
// Page-level coverage for the Quantum Risk Scanner's selectable tagging,
// results filter, and copy/CSV export (Task #1735):
//   • default selection (Critical + High) tags ONLY those levels while
//     stripping stale quantum:* tags from unselected levels, and creates
//     quantum vocabulary tags only for the selected levels;
//   • unchecking every level persists an empty selection across remounts and
//     makes the scan analysis-only (no record writes, no vocabulary writes);
//   • the filter toolbar narrows rows/groups (case-insensitive address text +
//     risk-level chips), keeps full Risk Summary totals, and shows a clear
//     empty state;
//   • Copy places the formula-guarded findings CSV on the clipboard with the
//     shared hook's success/failure toasts;
//   • Download CSV saves only the currently-filtered rows under a dated
//     filename, with hostile cells apostrophe-prefixed, and surfaces a
//     destructive toast when export fails.
//
// The real Dexie database runs over fake-indexeddb; records are seeded via the
// CRUD helpers with skipVocabularySync so the vocabulary table stays exactly
// what the scan itself writes.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// jsdom gives the page scroll element a 0-height rect, so the real
// @tanstack/react-virtual renders zero rows. Stub it to render every item
// (matching the UTXOs test pattern) — virtualization itself is verified in a
// real browser by scripts/check-quantum-scan-scale-browser.mjs.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      end: (index + 1) * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));


import { Toaster } from "@/components/ui/toaster";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords, getRecordsByType } from "@/lib/data/record-crud";
import { getTags } from "@/lib/data/vocabulary-crud";
import { getSettings, clearSettings } from "@/lib/data/settings-crud";
import QuantumRiskScanner from "./QuantumRiskScanner";

// Script-type fixtures (classification rules are out of scope — these just
// deterministically land in the five risk levels).
const P2PK_ADDR = "02" + "ab".repeat(32); // 66 hex chars → p2pk → critical
const TAPROOT_ADDR = "bc1pfilterhightarget0000000000000000000000"; // p2tr → high
const LEGACY_ADDR = "1medlegacyfilteraddr000000"; // p2pkh, unspent → medium
const P2SH_ADDR = "3variablescriptaddr000000"; // p2sh → variable
const LOW_ADDR = "zzz-low-address-000"; // unknown → low
const HOSTILE_ADDR = "=2+5"; // unknown → low, and a formula sigil
const HOSTILE_TAG = "=SUM(A1)";

const CSV_HEADER = "Address,Script Type,Risk Level,Applied Quantum Tag,Other Tags";

async function seedAddress(inputString: string, tags: string[]): Promise<number> {
  return await createRecord(
    {
      type: "address",
      inputString,
      label: `Record ${inputString.slice(0, 10)}`,
      source: "manual",
      addressImportance: "manual",
      tags,
      categories: [],
    },
    { skipVocabularySync: true },
  );
}

function renderScanner() {
  return render(
    <>
      <QuantumRiskScanner />
      <Toaster />
    </>,
  );
}

function checkboxState(level: string): string | null {
  return screen.getByTestId(`checkbox-apply-tag-${level}`).getAttribute("aria-checked");
}

// The scan button is disabled until the settings live-query resolves — and the
// checkboxes render the DEFAULT selection while loading — so wait for BOTH the
// expected checkbox state and an enabled scan button before clicking anything.
async function waitForSettingsLoaded(expectedCritical: "true" | "false" = "true") {
  await waitFor(() => {
    expect(checkboxState("critical")).toBe(expectedCritical);
    expect(
      (screen.getByTestId("button-scan-records") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
}

async function runScan() {
  fireEvent.click(screen.getByTestId("button-scan-records"));
  await screen.findByTestId("results-grouped", {}, { timeout: 15000 });
}

async function quantumVocabularyNames(): Promise<string[]> {
  return (await getTags())
    .map((t) => t.name)
    .filter((n) => n.startsWith("quantum:"))
    .sort();
}

beforeEach(async () => {
  await clearAllRecords();
  await clearSettings();
  await db.tags.clear();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await clearAllRecords();
  await clearSettings();
  await db.tags.clear();
});

describe("QuantumRiskScanner — selectable tagging", () => {
  it(
    "default selection tags only Critical + High and strips stale quantum tags from unselected levels",
    async () => {
      const idCritical = await seedAddress(P2PK_ADDR, []);
      const idHigh = await seedAddress(TAPROOT_ADDR, ["keep-tag", "quantum:medium"]);
      const idMedium = await seedAddress(LEGACY_ADDR, ["quantum:high", "note-tag"]);
      const idVariable = await seedAddress(P2SH_ADDR, ["quantum:variable"]);
      const idLow = await seedAddress(LOW_ADDR, ["quantum:low", "misc"]);

      renderScanner();
      await waitForSettingsLoaded();

      // Defaults: critical + high on, the rest off.
      expect(checkboxState("high")).toBe("true");
      expect(checkboxState("medium")).toBe("false");
      expect(checkboxState("variable")).toBe("false");
      expect(checkboxState("low")).toBe("false");

      await runScan();

      // Status + toast distinguish classified vs tagged.
      expect(screen.getByTestId("text-status-message").textContent).toBe(
        "Scan complete. 5 addresses classified, 2 tagged.",
      );
      expect((await screen.findAllByText("5 addresses classified, 2 tagged.")).length)
        .toBeGreaterThan(0);

      // Record tags: selected levels got their fresh quantum tag, unselected
      // levels had stale quantum tags stripped, other tags survived.
      const after = await getRecordsByType("address");
      const tagsByAddress = new Map(after.map((r) => [r.inputString, r.tags ?? []]));
      expect(tagsByAddress.get(P2PK_ADDR)).toEqual(["quantum:critical"]);
      expect(tagsByAddress.get(TAPROOT_ADDR)).toEqual(["keep-tag", "quantum:high"]);
      expect(tagsByAddress.get(LEGACY_ADDR)).toEqual(["note-tag"]);
      expect(tagsByAddress.get(P2SH_ADDR)).toEqual([]);
      expect(tagsByAddress.get(LOW_ADDR)).toEqual(["misc"]);

      // Vocabulary: quantum tags exist ONLY for the selected levels, and the
      // scan didn't sneak the records' other tags into the vocabulary.
      expect(await quantumVocabularyNames()).toEqual(["quantum:critical", "quantum:high"]);
      const allVocab = (await getTags()).map((t) => t.name);
      expect(allVocab).not.toContain("keep-tag");

      // Applied-tag badge only on rows whose tag was really written.
      expect(screen.getByTestId(`tag-applied-${idCritical}`).textContent).toBe("quantum:critical");
      expect(screen.getByTestId(`tag-applied-${idHigh}`).textContent).toBe("quantum:high");
      expect(screen.queryByTestId(`tag-applied-${idMedium}`)).toBeNull();
      expect(screen.queryByTestId(`tag-applied-${idVariable}`)).toBeNull();
      expect(screen.queryByTestId(`tag-applied-${idLow}`)).toBeNull();

      // All five rows are still listed (classification is never narrowed by
      // the tag selection).
      expect(screen.getByTestId(`result-${idMedium}`)).toBeTruthy();
      expect(screen.getByTestId(`result-${idLow}`)).toBeTruthy();
    },
    30000,
  );

  it(
    "empty selection persists across remounts and runs an analysis-only scan with no writes",
    async () => {
      const id = await seedAddress(LEGACY_ADDR, ["quantum:high", "keep"]);

      renderScanner();
      await waitForSettingsLoaded();

      // Uncheck both defaults; the choice lands in the settings row.
      fireEvent.click(screen.getByTestId("checkbox-apply-tag-critical"));
      await waitFor(() => expect(checkboxState("critical")).toBe("false"));
      fireEvent.click(screen.getByTestId("checkbox-apply-tag-high"));
      await waitFor(() => expect(checkboxState("high")).toBe("false"));
      await waitFor(async () => {
        expect((await getSettings("default"))?.quantumTagLevels).toEqual([]);
      });

      // Remount: the empty selection is the persisted state, not the default.
      cleanup();
      renderScanner();
      await waitForSettingsLoaded("false");
      expect(checkboxState("high")).toBe("false");
      expect(screen.getByTestId("text-analysis-only-hint")).toBeTruthy();

      await runScan();

      expect(screen.getByTestId("text-status-message").textContent).toBe(
        "Scan complete. 1 address classified. Analysis only — no tags were applied.",
      );
      expect(
        (await screen.findAllByText("1 address classified. Analysis only — no tags were applied."))
          .length,
      ).toBeGreaterThan(0);

      // No record writes (the stale quantum tag deliberately survives) and no
      // vocabulary writes of any kind.
      const after = await getRecordsByType("address");
      expect(after[0]?.tags).toEqual(["quantum:high", "keep"]);
      expect(await getTags()).toEqual([]);
      expect(screen.queryByTestId(`tag-applied-${id}`)).toBeNull();
    },
    30000,
  );
});

describe("QuantumRiskScanner — results filter", () => {
  it(
    "narrows rows by address text and risk level, keeps full summary totals, and clears from the empty state",
    async () => {
      await seedAddress(P2PK_ADDR, []);
      await seedAddress(TAPROOT_ADDR, []);
      await seedAddress(LEGACY_ADDR, []);

      renderScanner();
      await waitForSettingsLoaded();
      await runScan();

      expect(screen.getByTestId("text-filter-count").textContent).toBe("3 of 3 shown");

      // Case-insensitive address text search.
      fireEvent.change(screen.getByTestId("input-filter-address"), {
        target: { value: "BC1PFILTER" },
      });
      await waitFor(() => {
        expect(screen.getByTestId("text-filter-count").textContent).toBe("1 of 3 shown");
      });
      expect(screen.getByTestId("group-high")).toBeTruthy();
      expect(screen.getByTestId("group-count-high").textContent).toBe("1");
      expect(screen.queryByTestId("group-critical")).toBeNull();
      expect(screen.queryByTestId("group-medium")).toBeNull();
      // Risk Summary keeps FULL scan totals while the list is filtered.
      expect(screen.getByTestId("count-critical").textContent).toBe("1");
      expect(screen.getByTestId("count-medium").textContent).toBe("1");

      // Level chips filter independently of the text box.
      fireEvent.change(screen.getByTestId("input-filter-address"), { target: { value: "" } });
      fireEvent.click(screen.getByTestId("button-filter-level-critical"));
      await waitFor(() => {
        expect(screen.getByTestId("text-filter-count").textContent).toBe("1 of 3 shown");
      });
      expect(screen.getByTestId("group-critical")).toBeTruthy();
      expect(screen.queryByTestId("group-high")).toBeNull();

      // Text + chip with no intersection → empty state, then clear restores all.
      fireEvent.change(screen.getByTestId("input-filter-address"), {
        target: { value: "bc1p" },
      });
      await screen.findByTestId("empty-filter-state");
      expect(screen.queryByTestId("results-grouped")).toBeNull();
      fireEvent.click(screen.getByTestId("button-clear-filters-empty"));
      await waitFor(() => {
        expect(screen.getByTestId("text-filter-count").textContent).toBe("3 of 3 shown");
      });
      expect(screen.getByTestId("group-critical")).toBeTruthy();
      expect(screen.getByTestId("group-high")).toBeTruthy();
      expect(screen.getByTestId("group-medium")).toBeTruthy();
    },
    30000,
  );
});

describe("QuantumRiskScanner — copy & download", () => {
  it(
    "Copy puts the formula-guarded findings CSV on the clipboard with success and failure toasts",
    async () => {
      await seedAddress(P2PK_ADDR, []);
      await seedAddress(HOSTILE_ADDR, [HOSTILE_TAG]);

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      renderScanner();
      await waitForSettingsLoaded();
      await runScan();

      fireEvent.click(screen.getByTestId("button-copy-findings"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      // Hostile address and tag are apostrophe-prefixed; the applied-tag
      // column is blank for the unselected (low) hostile row.
      expect(writeText.mock.calls[0][0]).toBe(
        CSV_HEADER +
          "\r\n" +
          `${P2PK_ADDR},p2pk,Critical,quantum:critical,` +
          "\r\n" +
          `'${HOSTILE_ADDR},unknown,Low,,'${HOSTILE_TAG}` +
          "\r\n",
      );
      expect((await screen.findAllByText("Findings CSV copied")).length).toBeGreaterThan(0);

      // Clipboard rejection surfaces the shared hook's destructive toast.
      writeText.mockRejectedValueOnce(new Error("denied"));
      fireEvent.click(screen.getByTestId("button-copy-findings"));
      expect((await screen.findAllByText("Copy failed")).length).toBeGreaterThan(0);
      expect(
        (await screen.findAllByText("Could not copy the findings csv to your clipboard."))
          .length,
      ).toBeGreaterThan(0);
    },
    30000,
  );

  it(
    "Download CSV exports only the filtered rows under a dated filename and toasts on failure",
    async () => {
      await seedAddress(P2PK_ADDR, []);
      await seedAddress(HOSTILE_ADDR, [HOSTILE_TAG]);

      const createObjectURL = vi.fn(() => "blob:mock-url");
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
      const clickedDownloads: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clickedDownloads.push(this.download);
      });

      renderScanner();
      await waitForSettingsLoaded();
      await runScan();

      // Narrow to just the hostile row before exporting.
      fireEvent.change(screen.getByTestId("input-filter-address"), {
        target: { value: "=2" },
      });
      await waitFor(() => {
        expect(screen.getByTestId("text-filter-count").textContent).toBe("1 of 2 shown");
      });

      fireEvent.click(screen.getByTestId("button-download-findings"));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

      const blob = createObjectURL.mock.calls[0][0] as Blob;
      expect(await blob.text()).toBe(
        CSV_HEADER + "\r\n" + `'${HOSTILE_ADDR},unknown,Low,,'${HOSTILE_TAG}` + "\r\n",
      );
      expect(clickedDownloads).toHaveLength(1);
      expect(clickedDownloads[0]).toMatch(/^kyutxo-quantum-risk-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
      expect(
        (await screen.findAllByText(/Findings saved as kyutxo-quantum-risk-/)).length,
      ).toBeGreaterThan(0);

      // A throwing export surfaces the destructive toast instead of silence.
      createObjectURL.mockImplementationOnce(() => {
        throw new Error("boom");
      });
      fireEvent.click(screen.getByTestId("button-download-findings"));
      expect((await screen.findAllByText("Download Failed")).length).toBeGreaterThan(0);
    },
    30000,
  );
});
