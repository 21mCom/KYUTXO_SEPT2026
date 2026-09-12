// @vitest-environment jsdom
//
// Task #1547: dropping Sparrow's native wallet file (.mv / .mv.db — a binary
// H2 MVStore database) on the Descriptor Import dropzone must surface a
// specific guidance message (use Sparrow's File → Export → Output Descriptor
// or wallet JSON) instead of a generic parse failure, while normal JSON/text
// exports keep working exactly as before.
//
// Mocking mirrors DescriptorImport.copyButtons.test.tsx: the heavy Dexie hooks
// and derivation modules are stubbed. descriptor-parser is partially mocked via
// importOriginal so the REAL isSparrowWalletFile / SPARROW_WALLET_FILE_MESSAGE
// are exercised, while parseDescriptor/parseSparrowExport stay controllable.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/lib/descriptor-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/descriptor-parser")>();
  return {
    ...actual,
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
    parseSparrowExport: vi.fn(() => ({
      export: { label: "My Wallet", descriptor: "tr(xpubFAKE.../0/*)" },
    })),
    getDescriptorSummary: vi.fn(() => "Taproot Singlesig"),
  };
});

vi.mock("@/lib/bsms-parser", () => ({
  parseBSMS: vi.fn(() => ({ success: false })),
  isBSMSFile: vi.fn(() => false),
}));

vi.mock("@/lib/xpub", () => ({
  deriveTaprootDualChain: vi.fn(async () => ({ receive: [], change: [] })),
  deriveMultisigDualChain: vi.fn(async () => ({ receive: [], change: [] })),
  hasNonStandardHeader: vi.fn(() => false),
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
import { isSparrowWalletFile, SPARROW_WALLET_FILE_MESSAGE } from "@/lib/descriptor-parser";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function dropFile(file: File) {
  const dropzone = screen.getByTestId("dropzone-descriptor");
  fireEvent.drop(dropzone, {
    dataTransfer: {
      files: [file],
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      types: ["Files"],
    },
  });
}

describe("isSparrowWalletFile", () => {
  it("detects .mv.db and .mv files case-insensitively", () => {
    expect(isSparrowWalletFile("wallet.mv.db")).toBe(true);
    expect(isSparrowWalletFile("Wallet.MV.DB")).toBe(true);
    expect(isSparrowWalletFile("wallet.mv")).toBe(true);
  });

  it("does not flag normal export files", () => {
    expect(isSparrowWalletFile("wallet.json")).toBe(false);
    expect(isSparrowWalletFile("descriptor.txt")).toBe(false);
    expect(isSparrowWalletFile("coordination.bsms")).toBe(false);
    expect(isSparrowWalletFile("mv.json")).toBe(false);
  });
});

describe("DescriptorImport Sparrow .mv.db guidance", () => {
  it("shows the Sparrow export guidance when a .mv.db file is dropped", async () => {
    render(<DescriptorImport />);

    dropFile(new File(["\x00binary"], "MyWallet.mv.db", { type: "application/octet-stream" }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Sparrow wallet file detected",
          description: SPARROW_WALLET_FILE_MESSAGE,
          variant: "destructive",
        }),
      );
    });
    // The inline parse-error alert carries the same guidance.
    expect(await screen.findByText(SPARROW_WALLET_FILE_MESSAGE)).toBeTruthy();
    expect(SPARROW_WALLET_FILE_MESSAGE).toContain("Output Descriptor");
  });

  it("shows the same guidance for a bare .mv file", async () => {
    render(<DescriptorImport />);

    dropFile(new File(["\x00binary"], "wallet.mv", { type: "" }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Sparrow wallet file detected",
          variant: "destructive",
        }),
      );
    });
  });

  it("still loads a valid Sparrow JSON export as before", async () => {
    render(<DescriptorImport />);

    dropFile(
      new File(['{"label":"My Wallet","descriptor":"tr(xpubFAKE.../0/*)"}'], "wallet.json", {
        type: "application/json",
      }),
    );

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Descriptor loaded" }),
      );
    });
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sparrow wallet file detected" }),
    );
  });
});
