// @vitest-environment jsdom
//
// Confirms the *downloaded* Source of Funds file (not just the on-screen notice)
// carries the unresolved-amount warning.
//
// The on-screen warning and the downloaded declaration are produced by two
// different paths: the screen renders `reportData.unresolvedAmountCount` as JSX,
// while the file is built by `exportReport` -> `buildSourceOfFundsText`. A
// regression that stops the report from passing its computed
// `unresolvedAmountCount` into the export (or that downloads different data)
// would silently drop the warning from the file a user actually keeps — the
// exact bug this work fixed.
//
// This test drives the whole component (select address -> Generate -> Export),
// captures the text handed to the download Blob, and asserts:
//   (1) when funding amounts are unresolved, the file contains the
//       "may understate the total received" warning AND the
//       "Unresolved Amounts: N" summary line;
//   (2) when every amount resolves, neither of those appear.

// renderWithProviders includes RecordPreviewProvider, which loads its custom
// field definitions from Dexie when it mounts.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, act } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";

const ADDR = "bc1qsourceoffundsdownloadtestaddr0000000";

const txA = "tx_download_0001";
const txB = "tx_download_0002";
const txC = "tx_download_0003";

const allTxids = [txA, txB, txC];

// Mutable scenario state — swapped per test so a single mocked module can drive
// both the "unresolved" and the "fully resolved" cases.
let addressParticipants: Array<Record<string, unknown>> = [];
let participantsByTxid: Record<string, Array<Record<string, unknown>>> = {};
let transactionsByTxid: Record<string, Record<string, unknown>> = {};

const heights: Record<string, number> = { [txA]: 100, [txB]: 200, [txC]: 300 };

function setScenario(amounts: Record<string, number>) {
  addressParticipants = allTxids.map((txid, i) => ({
    id: i + 1,
    txid,
    address: ADDR,
    role: "output" as const,
    vout: 0,
    amount: amounts[txid],
  }));
  participantsByTxid = Object.fromEntries(
    allTxids.map((txid, i) => [
      txid,
      [{ id: 100 + i, txid, address: ADDR, role: "output", vout: 0, amount: amounts[txid] }],
    ]),
  );
  transactionsByTxid = Object.fromEntries(
    allTxids.map((txid) => [
      txid,
      { txid, blockHeight: heights[txid], blockTime: 1_700_000_000 + heights[txid] },
    ]),
  );
}

const ownedRecord = {
  id: 1,
  type: "address",
  inputString: ADDR,
  inputStringLower: ADDR.toLowerCase(),
  label: "Download Test Address",
  owner: "Alice",
  walletName: "Cold Wallet",
  addressImportance: "verified",
};

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ sourceOfFundsTxLimit: 1000 }),
  useCustomFields: () => ({ customFields: [], enabledCustomFields: [], isLoading: false }),
}));

vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ categories: [] }) }));

vi.mock("@/hooks/use-address-records", () => ({
  useAddressRecords: () => ({ records: [ownedRecord], isLoading: false }),
}));

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddress: vi.fn(async () => addressParticipants),
  getParticipantsByTxid: vi.fn(async (txid: string) => participantsByTxid[txid] ?? []),
  getTransactionByTxid: vi.fn(async (txid: string) => transactionsByTxid[txid]),
  getTransactionsByTxids: vi.fn(async (txids: string[]) =>
    txids.map((txid) => ({ txid, blockHeight: heights[txid] })),
  ),
}));

vi.mock("@/lib/data/price-data-crud", () => ({
  getPriceDataByKey: vi.fn(async () => undefined),
  getLatestPriceOnOrBefore: vi.fn(async () => undefined),
}));

const { SourceOfFundsReport } = await import("./SourceOfFundsReport");

async function waitForCondition(fn: () => boolean, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("waitForCondition: condition never became true");
}

// Capture the text handed to the download Blob. exportReport builds the file with
// `new Blob([text], { type: "text/plain" })`, so we wrap the global Blob to record
// its first part rather than re-implementing the download.
let capturedDownload = "";
let RealBlob: typeof Blob;

beforeEach(() => {
  vi.clearAllMocks();
  capturedDownload = "";
  RealBlob = globalThis.Blob;
  class CapturingBlob extends RealBlob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      if (Array.isArray(parts) && typeof parts[0] === "string") {
        capturedDownload = parts[0] as string;
      }
      super(parts, options);
    }
  }
  vi.stubGlobal("Blob", CapturingBlob);
  // jsdom doesn't implement object URLs or anchor-triggered navigation.
  vi.stubGlobal("URL", {
    ...globalThis.URL,
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function generateAndExport() {
  const screen = renderWithProviders(<SourceOfFundsReport />);

  fireEvent.change(screen.getByTestId("input-address-search"), {
    target: { value: "Download" },
  });
  fireEvent.click(screen.getByTestId(`button-select-address-${ownedRecord.id}`));
  fireEvent.click(screen.getByTestId("button-generate-report"));

  // Export becomes available only once reportData exists.
  await waitForCondition(() => !!screen.queryByTestId("button-export-report"));
  fireEvent.click(screen.getByTestId("button-export-report"));

  await waitForCondition(() => capturedDownload.length > 0);
  return capturedDownload;
}

describe("SourceOfFundsReport downloaded file", () => {
  it("includes the unresolved-amount warning when funding amounts are unresolved", async () => {
    // Two of three funding outputs resolve to 0 (their funding tx was never synced).
    setScenario({ [txA]: 50_000, [txB]: 0, [txC]: 0 });

    const text = await generateAndExport();

    expect(text).toContain("may understate the total received");
    expect(text).toContain("Unresolved Amounts: 2");
  });

  it("omits the unresolved-amount warning when every amount resolves", async () => {
    setScenario({ [txA]: 50_000, [txB]: 60_000, [txC]: 70_000 });

    const text = await generateAndExport();

    expect(text).not.toContain("may understate the total received");
    expect(text).not.toContain("Unresolved Amounts:");
  });
});
