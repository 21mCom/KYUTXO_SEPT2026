// @vitest-environment jsdom
//
// Verifies that the Reports page Privacy Audit finding surface renders http(s)
// URLs as click-only links across both text surfaces that go through the shared
// renderSourceNote util — the finding description and the "Fix:" correction
// text. Upholds the offline-first guarantee: a URL is only ever opened on an
// explicit user click (window.open) and is NEVER fetched merely by rendering.
// Plain text (no URL) renders without a link.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one that returns a fixed mock PrivacyAuditResult, so the
// test exercises only the UI link rendering.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { fetchCallsWithNoteUrl } from "@/test/noteFetchCalls";

vi.mock("@/hooks/use-owners", () => ({
  useOwners: () => ({ owners: [], isLoading: false }),
}));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [], isLoading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
    { id: 1, inputString: "bc1qexampleaddress", owner: undefined, walletName: undefined },
  ]),
}));

const DESC_URL = "https://en.bitcoin.it/wiki/Address_reuse";
const FIX_URL = "https://example.com/fix-it";

const mockResult = {
  findings: [
    {
      type: "ADDRESS_REUSE",
      severity: "HIGH",
      description: `Address reused — learn more at ${DESC_URL} now.`,
      details: {},
      correction: `Follow ${FIX_URL} to remediate.`,
      txids: ["tx1"],
      addresses: ["bc1qreused"],
      scoreDelta: -12.4,
    },
    {
      type: "DUST",
      severity: "LOW",
      description: "Dust outputs detected with no links.",
      details: {},
      correction: "Avoid spending dust.",
      txids: [],
      addresses: ["bc1qdust"],
      scoreDelta: -2.6,
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
    { label: "Dust", findingType: "DUST", delta: -3, runningScore: 85, count: 1 },
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

describe("Reports privacy finding link rendering (offline-first)", () => {
  let openSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchSpy = vi.fn().mockRejectedValue(new Error("network access is forbidden"));
    vi.stubGlobal("fetch", fetchSpy);
    // jsdom doesn't implement scrollIntoView; the focus helpers call it.
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderWithResult() {
    const utils = render(<PrivacyAuditReportPanel />);
    fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
    await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
    return utils;
  }

  it("renders a URL in the finding description as a click-only link and never fetches on load", async () => {
    const { getByTestId } = await renderWithResult();

    const row = getByTestId("row-privacy-finding-0");
    const links = within(row).getAllByRole("link");
    const descLink = links.find((l) => l.getAttribute("href") === DESC_URL);
    expect(descLink).toBeDefined();
    expect(descLink!.textContent).toBe(DESC_URL);

    // Offline-first: the finding URLs are never fetched merely by rendering.
    // (Unrelated app-level background fetches may fire during mount, so we
    // assert on the finding URLs rather than on fetch never being called.)
    expect(fetchCallsWithNoteUrl(fetchSpy, DESC_URL, FIX_URL)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens the description link via window.open only on click (preventing navigation)", async () => {
    const { getByTestId } = await renderWithResult();

    const row = getByTestId("row-privacy-finding-0");
    const descLink = within(row)
      .getAllByRole("link")
      .find((l) => l.getAttribute("href") === DESC_URL)!;

    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchCallsWithNoteUrl(fetchSpy, DESC_URL, FIX_URL)).toEqual([]);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(descLink, clickEvent);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(DESC_URL, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    // Opening is delegated to the browser, never fetched in-app.
    expect(fetchCallsWithNoteUrl(fetchSpy, DESC_URL, FIX_URL)).toEqual([]);
  });

  it("renders a URL in the 'Fix:' correction text as a click-only link", async () => {
    const { getByTestId } = await renderWithResult();

    const row = getByTestId("row-privacy-finding-0");
    const fixLink = within(row)
      .getAllByRole("link")
      .find((l) => l.getAttribute("href") === FIX_URL);
    expect(fixLink).toBeDefined();
    expect(fixLink!.textContent).toBe(FIX_URL);
    expect(fetchCallsWithNoteUrl(fetchSpy, DESC_URL, FIX_URL)).toEqual([]);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(fixLink!, clickEvent);
    expect(openSpy).toHaveBeenCalledWith(FIX_URL, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(fetchCallsWithNoteUrl(fetchSpy, DESC_URL, FIX_URL)).toEqual([]);
  });

  it("renders plain finding text (no URL) without any link", async () => {
    const { getByTestId } = await renderWithResult();

    // The DUST finding (index 1) has no URLs in its description or correction.
    const row = getByTestId("row-privacy-finding-1");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(row.textContent).toContain("Dust outputs detected with no links.");
    expect(row.textContent).toContain("Avoid spending dust.");

    expect(fetchCallsWithNoteUrl(fetchSpy, DESC_URL, FIX_URL)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
