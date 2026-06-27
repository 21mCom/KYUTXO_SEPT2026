// @vitest-environment jsdom
//
// Guard test for Task #940: the inline copy buttons on DescriptorImport step 2
// (receive + change derived addresses) MUST both write to navigator.clipboard
// AND fire the correct success / destructive "Copy failed" toast (wired by
// Task #538 via the inline `copyAddress` helper).
//
// The page pulls in many Dexie-backed hooks and the heavy xpub / descriptor
// derivation modules at import time, so we mock:
//   - @/hooks/* vocabulary hooks      -> empty lists (no IndexedDB)
//   - @/lib/descriptor-parser         -> a fixed, valid parsed descriptor
//   - @/lib/xpub                      -> deriveTaprootDualChain resolves fixed
//                                        receive/change address arrays
//   - @/hooks/use-toast               -> hoisted toastMock
// This keeps the render cheap and isolates the copy-button-to-toast wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const RECEIVE_ADDRESS = "bc1qreceive0000000000000000000000000000000q";
const CHANGE_ADDRESS = "bc1qchange00000000000000000000000000000000q";

vi.mock("@/lib/descriptor-parser", () => ({
  parseDescriptor: vi.fn(() => ({
    success: true,
    descriptor: {
      scriptType: "p2tr",
      threshold: 1,
      keys: [
        {
          fingerprint: "deadbeef",
          derivationPath: "86'/0'/0'",
          xpub: "xpubFAKE000000000000000000000000000000000000",
          chainPath: "/0/*",
          rawChainPath: "/0/*",
        },
      ],
      network: "mainnet",
      isMultisig: false,
      isSortedMulti: false,
      isTaproot: true,
      rawDescriptor: "tr(xpubFAKE.../0/*)",
      chainType: "dual-chain",
    },
  })),
  parseSparrowExport: vi.fn(() => ({ error: "not a sparrow export" })),
  descriptorKeysToXpubEntries: vi.fn(() => []),
  getDescriptorSummary: vi.fn(() => "Taproot Singlesig"),
}));

vi.mock("@/lib/bsms-parser", () => ({
  parseBSMS: vi.fn(() => ({ success: false })),
  isBSMSFile: vi.fn(() => false),
}));

vi.mock("@/lib/xpub", () => ({
  deriveTaprootDualChain: vi.fn(async () => ({
    receive: [{ index: 0, address: RECEIVE_ADDRESS }],
    change: [{ index: 0, address: CHANGE_ADDRESS }],
  })),
  deriveMultisigDualChain: vi.fn(async () => ({ receive: [], change: [] })),
}));

vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [] }), createTag: vi.fn() }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ categories: [] }), createCategory: vi.fn() }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [] }), createOwner: vi.fn() }));
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: [] }), createWalletName: vi.fn() }));
vi.mock("@/hooks/use-seed-names", () => ({
  useSeedNames: () => ({ seedNames: [] }),
  createSeedName: vi.fn(),
  SEED_NAME_MAX_LENGTH: 50,
}));
vi.mock("@/hooks/use-wallet-software", () => ({
  useWalletSoftware: () => ({ walletSoftware: [] }),
  createWalletSoftware: vi.fn(),
}));
vi.mock("@/hooks/use-records", () => ({
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  lookupRecordsByInputStrings: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/dataFacade", () => ({
  syncTagsToMaster: vi.fn(),
  syncCategoriesToMaster: vi.fn(),
  createRecordOrigin: vi.fn(),
}));
vi.mock("@/lib/database", () => ({
  beginBulkOperation: vi.fn(),
  endBulkOperation: vi.fn(),
}));

import DescriptorImport from "./DescriptorImport";

let writeText: ReturnType<typeof vi.fn>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderAndDerive() {
  render(<DescriptorImport />);
  // Step 1: paste a descriptor (mocked parser accepts anything non-empty).
  fireEvent.change(screen.getByTestId("textarea-descriptor"), {
    target: { value: "tr(xpubFAKE.../0/*)" },
  });
  await flush();
  // Advance to step 2 by deriving addresses (deriveTaprootDualChain is mocked).
  fireEvent.click(screen.getByTestId("button-derive-addresses"));
  await waitFor(() => screen.getByTestId("button-copy-receive-0"));
}

describe("DescriptorImport copy buttons toast", () => {
  it("copies a receive address and shows the success toast", async () => {
    await renderAndDerive();

    fireEvent.click(screen.getByTestId("button-copy-receive-0"));
    await flush();

    expect(writeText).toHaveBeenCalledWith(RECEIVE_ADDRESS);
    expect(toastMock).toHaveBeenCalledWith({
      title: "Copied",
      description: "Address copied to clipboard",
    });
  });

  it("copies a change address and shows the success toast", async () => {
    await renderAndDerive();

    // Change addresses are hidden until the "Show" toggle is clicked.
    fireEvent.click(screen.getByTestId("button-toggle-change"));
    await waitFor(() => screen.getByTestId("button-copy-change-0"));

    fireEvent.click(screen.getByTestId("button-copy-change-0"));
    await flush();

    expect(writeText).toHaveBeenCalledWith(CHANGE_ADDRESS);
    expect(toastMock).toHaveBeenCalledWith({
      title: "Copied",
      description: "Address copied to clipboard",
    });
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    await renderAndDerive();

    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    fireEvent.click(screen.getByTestId("button-copy-receive-0"));
    await flush();

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Copy failed",
        description: "Could not copy to clipboard",
        variant: "destructive",
      }),
    );
  });
});
