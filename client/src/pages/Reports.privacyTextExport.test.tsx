// @vitest-environment jsdom
//
// Coverage for the Copy / Export Text wiring in the Privacy Audit report panel
// (Reports.tsx). The plain-text builder (buildPrivacyTextReport) is unit-tested
// separately in lib/__tests__/privacy-report-text.test.ts; this file guards the
// page-level glue that turns that builder into:
//   - a downloadable text/plain Blob with a dated filename (Export Text), and
//   - a clipboard copy with a success toast, plus a destructive fallback toast
//     when the clipboard API is missing or its write rejects (Copy).
// It also verifies the selected owner/wallet scope flows from the panel's
// Select controls into the built report.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one returning a fixed PrivacyAuditResult, so only the
// export/copy UI wiring is exercised. buildPrivacyTextReport is left REAL so the
// produced/copied text is the actual production report.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor, screen } from "@testing-library/react";

// A hoisted toast spy so the mocked useToast hands back the same fn we assert on.
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. This keeps the scope-selection state path real
// while staying deterministic; the export/copy wiring under test is unaffected.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = () => null;
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) => React.createElement("option", { value }, children),
  };
});

vi.mock("@/hooks/use-owners", () => ({
  useOwners: () => ({ owners: [{ name: "Alice" }, { name: "Bob" }], isLoading: false }),
}));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [{ name: "Cold Storage" }], isLoading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// One address record that matches BOTH the default "all" scope and the
// Alice / Cold Storage scope, so generate() never short-circuits with a
// "No Addresses" toast regardless of the selection under test.
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
    {
      id: 1,
      type: "address",
      inputString: "bc1qexampleaddress",
      owner: "Alice",
      walletName: "Cold Storage",
    },
  ]),
}));

const mockResult = {
  findings: [
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address reused across multiple transactions.",
      details: {},
      correction: "Use a fresh address for each receive.",
      txids: ["tx1"],
      addresses: ["bc1qreused"],
      scoreDelta: -12.4,
    },
  ],
  warnings: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 85,
  grade: "B",
  scoreWaterfall: [
    { label: "Base Score", findingType: "BASE", delta: 0, runningScore: 100, count: 0 },
    { label: "Address Reuse", findingType: "ADDRESS_REUSE", delta: -12, runningScore: 88, count: 1 },
  ],
  needsResync: false,
  fingerprintCoverage: 1,
};

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => mockResult),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");
const { runPrivacyAudit } = await import("@/lib/privacy-audit");

// A sub-1-point finding (scoreDelta between -1 and 0). formatScoreDelta renders
// these as the tiny-penalty "<-1 pts" label rather than rounding to "0 pts".
const TINY_PENALTY_RESULT = {
  ...mockResult,
  findings: [
    {
      type: "FINGERPRINT_NVERSION",
      severity: "LOW",
      description: "Transaction uses a non-default nVersion.",
      details: {},
      correction: "Use a wallet with standard transaction construction.",
      txids: ["tx1"],
      addresses: [],
      scoreDelta: -0.4,
    },
  ],
};

// ── DOM stubs ────────────────────────────────────────────────────────────────
// jsdom doesn't implement URL.createObjectURL or anchor navigation, and Radix
// Select needs pointer-capture / scrollIntoView. Capture the Blob and anchor
// download attribute instead of letting jsdom attempt a real navigation.
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickedDownloads: string[];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  toastSpy.mockClear();
  clickedDownloads = [];
  createObjectURL = vi.fn(() => "blob:mock-url");
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  // Capture the anchor download name without triggering jsdom navigation.
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownloads.push(this.download);
    });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // restoreAllMocks above also clears the prototype spy.
  void clickSpy;
});

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

async function renderWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  // Wait for the async generate() -> mock runPrivacyAudit -> buttons to render.
  await waitFor(() => utils.getByTestId("button-export-privacy-report-text"));
  return utils;
}

const DATED_TXT = /^privacy-audit-report-\d{4}-\d{2}-\d{2}\.txt$/;

describe("PrivacyAuditReportPanel — Export Text", () => {
  it("produces a text/plain Blob and triggers a download with a dated filename", async () => {
    const { getByTestId } = await renderWithResult();

    fireEvent.click(getByTestId("button-export-privacy-report-text"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain;charset=utf-8");

    // The .txt download fired with a date-stamped filename, and the object URL
    // was revoked afterwards.
    expect(clickedDownloads).toHaveLength(1);
    expect(clickedDownloads[0]).toMatch(DATED_TXT);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("the exported Blob carries the real plain-text report content", async () => {
    const { getByTestId } = await renderWithResult();

    fireEvent.click(getByTestId("button-export-privacy-report-text"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await blob.text();
    expect(text).toContain("PRIVACY AUDIT REPORT");
    expect(text).toContain("Grade: B");
    expect(text).toContain("Address reused across multiple transactions.");
  });

  it("emits the tiny-penalty '<-1 pts' label for a sub-1-point finding", async () => {
    // A regression in the export path could silently re-hide sub-1-point
    // penalties in the document users actually save. The audit returns a finding
    // whose -0.4 scoreDelta must surface as "<-1 pts" — not rounded away to 0.
    vi.mocked(runPrivacyAudit).mockResolvedValueOnce(TINY_PENALTY_RESULT as any);

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-export-privacy-report-text"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const text = await (createObjectURL.mock.calls[0][0] as Blob).text();
    expect(text).toContain("Score Impact: <-1 pts");
  });
});

describe("PrivacyAuditReportPanel — Copy", () => {
  it("writes the built report to the clipboard and shows a success toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-copy-privacy-report-text"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("PRIVACY AUDIT REPORT");
    expect(copied).toContain("Grade: B");

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copied to Clipboard" }),
    );
    // The success toast is not destructive.
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("shows the destructive fallback toast when the clipboard API is unavailable", async () => {
    setClipboard(undefined);

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-copy-privacy-report-text"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Clipboard Unavailable",
          description: expect.stringContaining("Export Text"),
        }),
      ),
    );
  });

  it("shows the destructive fallback toast when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-copy-privacy-report-text"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Copy Failed",
          description: expect.stringContaining("Export Text"),
        }),
      ),
    );
  });
});

describe("PrivacyAuditReportPanel — scope flows into the report", () => {
  it("defaults to the All / All scope in the exported text", async () => {
    const { getByTestId } = await renderWithResult();

    fireEvent.click(getByTestId("button-export-privacy-report-text"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const text = await (createObjectURL.mock.calls[0][0] as Blob).text();
    expect(text).toContain("Owner: All");
    expect(text).toContain("Wallet: All");
    // The report-wide scope caption matches the history exporter wording.
    expect(text).toContain("Scope: All addresses");
  });

  it("shows the report-wide scope caption on screen before export", async () => {
    const { getByTestId } = await renderWithResult();
    expect(getByTestId("text-privacy-report-scope").textContent).toContain(
      "Scope: All addresses",
    );
  });

  it("carries the selected owner/wallet scope into the copied report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    render(<PrivacyAuditReportPanel />);

    // Choose a specific owner and wallet before generating.
    fireEvent.change(screen.getByTestId("select-privacy-report-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByTestId("select-privacy-report-wallet"), {
      target: { value: "Cold Storage" },
    });

    fireEvent.click(screen.getByTestId("button-generate-privacy-report"));
    await waitFor(() => screen.getByTestId("button-copy-privacy-report-text"));

    fireEvent.click(screen.getByTestId("button-copy-privacy-report-text"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Owner: Alice");
    expect(copied).toContain("Wallet: Cold Storage");
    // The report-wide scope caption matches the history exporter wording.
    expect(copied).toContain("Scope: Owner = Alice, Wallet = Cold Storage");
  });

  it("keeps the scope caption locked to the audited scope after the filter changes post-scan", async () => {
    render(<PrivacyAuditReportPanel />);

    // Run the audit against the default "All addresses" scope.
    fireEvent.click(screen.getByTestId("button-generate-privacy-report"));
    await waitFor(() => screen.getByTestId("button-export-privacy-report-text"));
    expect(screen.getByTestId("text-privacy-report-scope").textContent).toContain(
      "Scope: All addresses",
    );

    // Now change the Owner/Wallet dropdowns WITHOUT re-running the audit.
    fireEvent.change(screen.getByTestId("select-privacy-report-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByTestId("select-privacy-report-wallet"), {
      target: { value: "Cold Storage" },
    });

    // The on-screen caption must still describe the scope the displayed results
    // were computed from, not the new (un-applied) dropdown selection.
    expect(screen.getByTestId("text-privacy-report-scope").textContent).toContain(
      "Scope: All addresses",
    );
    expect(screen.getByTestId("text-privacy-report-scope").textContent).not.toContain(
      "Alice",
    );
  });

  it("exports the audited scope, not the post-scan dropdown change", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    render(<PrivacyAuditReportPanel />);

    // Run the audit against the default "All addresses" scope.
    fireEvent.click(screen.getByTestId("button-generate-privacy-report"));
    await waitFor(() => screen.getByTestId("button-copy-privacy-report-text"));

    // Change the filters after the scan but before exporting.
    fireEvent.change(screen.getByTestId("select-privacy-report-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByTestId("select-privacy-report-wallet"), {
      target: { value: "Cold Storage" },
    });

    fireEvent.click(screen.getByTestId("button-copy-privacy-report-text"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const copied = writeText.mock.calls[0][0] as string;
    // The export reflects the scope the audit actually ran with.
    expect(copied).toContain("Owner: All");
    expect(copied).toContain("Wallet: All");
    expect(copied).toContain("Scope: All addresses");
    expect(copied).not.toContain("Scope: Owner = Alice, Wallet = Cold Storage");
  });
});
