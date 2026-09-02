// @vitest-environment jsdom
//
// Coverage for the Export JSON wiring in the Privacy Audit report panel
// (Reports.tsx). The JSON builder (buildPrivacyReport) is unit-tested separately
// in lib/__tests__/privacy-report-export.test.ts; this file guards the
// page-level glue that turns that builder into a downloadable application/json
// Blob with a dated filename (privacy-audit-report-YYYY-MM-DD.json). It also
// verifies the selected owner/wallet scope flows from the panel's Select
// controls into the serialized JSON.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one returning a fixed PrivacyAuditResult, so only the
// export UI wiring is exercised. buildPrivacyReport is left REAL so the produced
// JSON is the actual production report shape.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor, screen } from "@testing-library/react";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. This keeps the scope-selection state path real
// while staying deterministic; the export wiring under test is unaffected.
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

// ── DOM stubs ────────────────────────────────────────────────────────────────
// jsdom doesn't implement URL.createObjectURL or anchor navigation. Capture the
// Blob and anchor download attribute instead of letting jsdom attempt a real
// navigation.
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
  void clickSpy;
});

async function renderWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  // Wait for the async generate() -> mock runPrivacyAudit -> buttons to render.
  await waitFor(() => utils.getByTestId("button-export-privacy-report"));
  return utils;
}

const DATED_JSON = /^privacy-audit-report-\d{4}-\d{2}-\d{2}\.json$/;

describe("PrivacyAuditReportPanel — Export JSON", () => {
  it("produces an application/json Blob and triggers a download with a dated filename", async () => {
    const { getByTestId } = await renderWithResult();

    fireEvent.click(getByTestId("button-export-privacy-report"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");

    // The .json download fired with a date-stamped filename, and the object URL
    // was revoked afterwards.
    expect(clickedDownloads).toHaveLength(1);
    expect(clickedDownloads[0]).toMatch(DATED_JSON);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("the exported Blob carries the real JSON report content", async () => {
    const { getByTestId } = await renderWithResult();

    fireEvent.click(getByTestId("button-export-privacy-report"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const parsed = JSON.parse(await blob.text());

    expect(parsed.summary).toMatchObject({
      score: 85,
      grade: "B",
      transactionsAnalyzed: 5,
      addressesScanned: 3,
      isClean: false,
      findingsCount: 1,
      warningsCount: 0,
    });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: "Address reused across multiple transactions.",
    });
  });
});

describe("PrivacyAuditReportPanel — scope flows into the JSON", () => {
  it("defaults to the All / All scope (null/null) in the exported JSON", async () => {
    const { getByTestId } = await renderWithResult();

    fireEvent.click(getByTestId("button-export-privacy-report"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const parsed = JSON.parse(await (createObjectURL.mock.calls[0][0] as Blob).text());
    expect(parsed.scope).toEqual({ owner: null, wallet: null });
  });

  it("carries the selected owner/wallet scope into the serialized JSON", async () => {
    render(<PrivacyAuditReportPanel />);

    // Choose a specific owner and wallet before generating.
    fireEvent.change(screen.getByTestId("select-privacy-report-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByTestId("select-privacy-report-wallet"), {
      target: { value: "Cold Storage" },
    });

    fireEvent.click(screen.getByTestId("button-generate-privacy-report"));
    await waitFor(() => screen.getByTestId("button-export-privacy-report"));

    fireEvent.click(screen.getByTestId("button-export-privacy-report"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const parsed = JSON.parse(await (createObjectURL.mock.calls[0][0] as Blob).text());
    expect(parsed.scope).toEqual({ owner: "Alice", wallet: "Cold Storage" });
  });

  it("exports the audited scope, not the post-scan dropdown change", async () => {
    render(<PrivacyAuditReportPanel />);

    // Run the audit against the default "All addresses" scope.
    fireEvent.click(screen.getByTestId("button-generate-privacy-report"));
    await waitFor(() => screen.getByTestId("button-export-privacy-report"));

    // Change the filters after the scan but before exporting.
    fireEvent.change(screen.getByTestId("select-privacy-report-owner"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByTestId("select-privacy-report-wallet"), {
      target: { value: "Cold Storage" },
    });

    fireEvent.click(screen.getByTestId("button-export-privacy-report"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const parsed = JSON.parse(await (createObjectURL.mock.calls[0][0] as Blob).text());
    // The serialized scope reflects the scope the audit actually ran with
    // (null/null = All), not the new (un-applied) dropdown selection.
    expect(parsed.scope).toEqual({ owner: null, wallet: null });
    expect(parsed.scope).not.toEqual({ owner: "Alice", wallet: "Cold Storage" });
  });
});
