// @vitest-environment jsdom
//
// Guard test for the descriptor → Address Importer handoff chain coverage:
// when arriving via ?source=descriptor&chains=receive-only, the derived
// change addresses must start DESELECTED (and vice versa for change-only),
// so users can't accidentally save addresses the descriptor never covers.
// Dual-chain handoffs (and plain visits) keep both chains fully selected.
//
// Heavy Dexie/derivation modules are mocked; deriveDualChainAddresses
// resolves fixed receive/change arrays so the test isolates the
// selection-initialization logic in BulkImport.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/hooks/use-records", () => ({
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
}));
vi.mock("@/lib/dataFacade", () => ({
  syncTagsToMaster: vi.fn(),
  syncCategoriesToMaster: vi.fn(),
  createRecordOrigin: vi.fn(),
  saveDerivationTemplate: vi.fn(),
  getRecordsByType: vi.fn(async () => []),
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
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: [] }), createWalletName: vi.fn() }));
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

async function renderToPreview() {
  render(<BulkImport />);
  // Wait out the 300ms analyze debounce → Continue enables
  const next1 = await screen.findByTestId("button-next-step1");
  await waitFor(() => expect((next1 as HTMLButtonElement).disabled).toBe(false), { timeout: 15_000 });
  fireEvent.click(next1);
  fireEvent.click(await screen.findByTestId("button-next-step2"));
  // Derivation resolves → preview table renders
  await screen.findByTestId("checkbox-select-all-receive", {}, { timeout: 15_000 });
}

function selectAllChecked(testId: string): boolean {
  const el = screen.getByTestId(testId);
  return el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked";
}

describe("BulkImport descriptor handoff chain coverage", { timeout: 30_000 }, () => {
  beforeEach(() => {
    toastMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    setSearch("");
  });

  it("receive-only handoff leaves change addresses deselected", async () => {
    setSearch(`?source=descriptor&xpub=${XPUB}&scriptType=p2wpkh&chains=receive-only`);
    await renderToPreview();

    expect(screen.getByTestId("alert-descriptor-chain-coverage").textContent)
      .toMatch(/receive addresses only/i);
    expect(selectAllChecked("checkbox-select-all-receive")).toBe(true);

    // Expand the change section and confirm nothing is selected
    fireEvent.click(screen.getByTestId("toggle-change-addresses"));
    const changeAll = await screen.findByTestId("checkbox-select-all-change");
    expect(
      changeAll.getAttribute("aria-checked") === "true" ||
      changeAll.getAttribute("data-state") === "checked",
    ).toBe(false);
    for (let i = 0; i < CHANGE.length; i++) {
      const cb = screen.getByTestId(`checkbox-change-${i}`);
      expect(
        cb.getAttribute("aria-checked") === "true" ||
        cb.getAttribute("data-state") === "checked",
      ).toBe(false);
    }
  });

  it("change-only handoff leaves receive addresses deselected and expands change", async () => {
    setSearch(`?source=descriptor&xpub=${XPUB}&scriptType=p2wpkh&chains=change-only`);
    await renderToPreview();

    expect(screen.getByTestId("alert-descriptor-chain-coverage").textContent)
      .toMatch(/change addresses only/i);
    expect(selectAllChecked("checkbox-select-all-receive")).toBe(false);
    // change section auto-expanded and fully selected
    expect(selectAllChecked("checkbox-select-all-change")).toBe(true);
  });

  it("dual-chain handoff keeps both chains fully selected (no coverage alert)", async () => {
    setSearch(`?source=descriptor&xpub=${XPUB}&scriptType=p2wpkh&chains=dual-chain`);
    await renderToPreview();

    expect(screen.queryByTestId("alert-descriptor-chain-coverage")).toBeNull();
    expect(selectAllChecked("checkbox-select-all-receive")).toBe(true);
    fireEvent.click(screen.getByTestId("toggle-change-addresses"));
    const changeAll = await screen.findByTestId("checkbox-select-all-change");
    expect(
      changeAll.getAttribute("aria-checked") === "true" ||
      changeAll.getAttribute("data-state") === "checked",
    ).toBe(true);
  });
});
