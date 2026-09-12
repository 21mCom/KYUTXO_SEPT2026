// @vitest-environment jsdom
//
// Bulk Import wallet re-attribution (Wallet Overview stuck-counts fix): when
// an imported address already exists in the vault, the merge branch must
// re-stamp the user's chosen walletName —
//   - discovery-tier rows (blockchain-discovered / pending-review) that
//     inherited another wallet's name from sync move to the imported wallet,
//   - curated rows under a DIFFERENT wallet move too, and the import summary
//     toast reports the re-attribution so the move is never silent.
//
// Heavy Dexie/derivation modules are mocked like the chain-coverage test;
// getRecordsByType seeds the "existing vault rows" the merge branch sees.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// cmdk (wallet-name combobox) requires ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(window as any).ResizeObserver = (window as any).ResizeObserver || ResizeObserverStub;
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});

const { toastMock, updateRecordMock, createRecordMock, getRecordsByTypeMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  updateRecordMock: vi.fn(async () => {}),
  createRecordMock: vi.fn(async () => 1),
  getRecordsByTypeMock: vi.fn(async () => [] as any[]),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/hooks/use-records", () => ({
  createRecord: createRecordMock,
  updateRecord: updateRecordMock,
}));
vi.mock("@/lib/dataFacade", () => ({
  syncTagsToMaster: vi.fn(),
  syncCategoriesToMaster: vi.fn(),
  createRecordOrigin: vi.fn(),
  captureMergeOrigin: vi.fn(async () => {}),
  saveDerivationTemplate: vi.fn(),
  getRecordsByType: getRecordsByTypeMock,
  getDerivationTemplates: vi.fn(async () => []),
  deleteDerivationTemplate: vi.fn(),
}));
vi.mock("@/lib/database", () => ({
  beginBulkOperation: vi.fn(),
  endBulkOperation: vi.fn(),
}));
vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ categories: [] }) }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [] }), createOwner: vi.fn() }));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [{ id: 1, name: "WalletBeta" }] }),
  createWalletName: vi.fn(),
}));
vi.mock("@/hooks/use-seed-names", () => ({ useSeedNames: () => ({ seedNames: [] }), createSeedName: vi.fn() }));
vi.mock("@/hooks/use-wallet-software", () => ({ useWalletSoftware: () => ({ walletSoftware: [] }), createWalletSoftware: vi.fn() }));

const RECEIVE = ["bc1qreceive0", "bc1qreceive1", "bc1qreceive2"].map((address, i) => ({
  address,
  path: `m/84'/0'/0'/0/${i}`,
  index: i,
  chainType: "receive" as const,
}));
const CHANGE = ["bc1qchange0", "bc1qchange1"].map((address, i) => ({
  address,
  path: `m/84'/0'/0'/1/${i}`,
  index: i,
  chainType: "change" as const,
}));

vi.mock("@/lib/xpub", () => ({
  deriveDualChainAddresses: vi.fn(async () => ({ receive: RECEIVE, change: CHANGE })),
  deriveDualChainAdvanced: vi.fn(async () => ({ receive: RECEIVE, change: CHANGE })),
  deriveMultisigDualChain: vi.fn(),
  analyzeXpub: vi.fn(() => ({
    prefix: "zpub",
    bipStandard: "BIP84",
    depth: 3,
    scriptType: "p2wpkh",
    needsAdvancedMode: false,
    nonStandardHeader: false,
    suggestedPath: "0",
    network: "mainnet",
    parentFingerprint: "00000000",
  })),
  validateExtendedPublicKey: vi.fn(() => ({ valid: true })),
  validateMultisigXpubs: vi.fn(() => ({ valid: true })),
  getBipDescription: vi.fn(() => "BIP84 (Native SegWit)"),
  getDepthDescription: vi.fn(() => "Account level"),
  getMultisigScriptTypeDescription: vi.fn(() => "P2WSH"),
  convertExtendedKeyPrefix: vi.fn((k: string) => k),
}));

import BulkImport from "./BulkImport";

const XPUB = "zpubFAKE00000000000000000000000000000000000000000000";

function setSearch(search: string) {
  window.history.replaceState(null, "", `/import${search}`);
}

/** Existing vault rows the merge branch will collide with. */
const EXISTING = [
  {
    // Sync auto-created this counterparty row and stamped WalletOne's name.
    id: 101,
    type: "address",
    inputString: "bc1qreceive0",
    label: "",
    tags: [],
    categories: [],
    source: "blockchain-sync",
    walletName: "WalletOne",
    addressImportance: "blockchain-discovered",
  },
  {
    // A curated row left over from an earlier import into WalletOne.
    id: 102,
    type: "address",
    inputString: "bc1qreceive1",
    label: "Old receive 1",
    tags: [],
    categories: [],
    source: "manual",
    walletName: "WalletOne",
    addressImportance: "manual",
  },
  {
    // Already under the target wallet — merged, not re-attributed.
    id: 103,
    type: "address",
    inputString: "bc1qchange0",
    label: "Already Beta",
    tags: [],
    categories: [],
    source: "manual",
    walletName: "WalletBeta",
    addressImportance: "wallet-import",
  },
];

async function renderAndSave() {
  render(<BulkImport />);
  const next1 = await screen.findByTestId("button-next-step1");
  await waitFor(() => expect((next1 as HTMLButtonElement).disabled).toBe(false), { timeout: 15_000 });
  fireEvent.click(next1);

  // Name the target wallet so the import is an explicit act of attribution.
  fireEvent.click(await screen.findByTestId("select-wallet-name"));
  fireEvent.click(await screen.findByText("WalletBeta"));

  fireEvent.click(await screen.findByTestId("button-next-step2"));
  await screen.findByTestId("checkbox-select-all-receive", {}, { timeout: 15_000 });

  fireEvent.click(await screen.findByTestId("button-save-addresses"));
  await waitFor(() => expect(toastMock).toHaveBeenCalled(), { timeout: 15_000 });
}

describe("BulkImport wallet re-attribution", { timeout: 30_000 }, () => {
  beforeEach(() => {
    toastMock.mockClear();
    updateRecordMock.mockClear();
    createRecordMock.mockClear();
    getRecordsByTypeMock.mockReset();
    getRecordsByTypeMock.mockResolvedValue(EXISTING as any[]);
    setSearch(`?source=descriptor&xpub=${XPUB}&scriptType=p2wpkh&chains=dual-chain`);
  });
  afterEach(() => {
    cleanup();
    setSearch("");
  });

  it("re-attributes existing rows to the imported wallet and reports the moves", async () => {
    await renderAndSave();

    // bc1qreceive0 (discovery-tier, WalletOne) -> WalletBeta, tier upgraded.
    const discUpdate = updateRecordMock.mock.calls.find(([id]) => id === 101);
    expect(discUpdate).toBeTruthy();
    expect(discUpdate![1].walletName).toBe("WalletBeta");
    expect(discUpdate![1].addressImportance).toBe("xpub-derived");

    // bc1qreceive1 (curated, WalletOne) -> re-attributed to WalletBeta.
    const curatedUpdate = updateRecordMock.mock.calls.find(([id]) => id === 102);
    expect(curatedUpdate).toBeTruthy();
    expect(curatedUpdate![1].walletName).toBe("WalletBeta");

    // bc1qchange0 already under WalletBeta keeps its attribution.
    const sameUpdate = updateRecordMock.mock.calls.find(([id]) => id === 103);
    expect(sameUpdate).toBeTruthy();
    expect(sameUpdate![1].walletName).toBe("WalletBeta");

    // The summary toast names both re-attributions, one of them curated.
    const completeToast = toastMock.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.title === "Import Complete");
    expect(completeToast).toBeTruthy();
    expect(completeToast.description).toContain("2 re-attributed from other wallets");
    expect(completeToast.description).toContain("1 previously curated");
  });

  it("keeps existing attribution when no wallet name is entered", async () => {
    render(<BulkImport />);
    const next1 = await screen.findByTestId("button-next-step1");
    await waitFor(() => expect((next1 as HTMLButtonElement).disabled).toBe(false), { timeout: 15_000 });
    fireEvent.click(next1);
    fireEvent.click(await screen.findByTestId("button-next-step2"));
    await screen.findByTestId("checkbox-select-all-receive", {}, { timeout: 15_000 });
    fireEvent.click(await screen.findByTestId("button-save-addresses"));
    await waitFor(() => expect(toastMock).toHaveBeenCalled(), { timeout: 15_000 });

    const discUpdate = updateRecordMock.mock.calls.find(([id]) => id === 101);
    expect(discUpdate![1].walletName).toBe("WalletOne");

    const completeToast = toastMock.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.title === "Import Complete");
    expect(completeToast.description).not.toContain("re-attributed");
  });
});
