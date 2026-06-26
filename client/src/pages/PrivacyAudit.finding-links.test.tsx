// @vitest-environment jsdom
//
// Verifies that the Privacy Audit FindingCard renders http(s) URLs as
// click-only links across all three surfaces that go through the shared
// renderSourceNote util — the finding description, the source citation note,
// and the remediation/correction text. Upholds the offline-first guarantee:
// a URL is only ever opened on an explicit user click (window.open) and is
// NEVER fetched merely by rendering. Plain text (no URL) renders without a
// link.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PrivacyFinding } from "@/lib/privacy-audit";
import { FindingCard } from "./PrivacyAudit";

function baseFinding(overrides: Partial<PrivacyFinding> = {}): PrivacyFinding {
  return {
    type: "ADDRESS_REUSE",
    severity: "HIGH",
    description: "A plain finding description.",
    details: {},
    correction: "A plain remediation note.",
    txids: [],
    addresses: [],
    ...overrides,
  };
}

function renderCard(finding: PrivacyFinding) {
  return render(
    <TooltipProvider>
      <FindingCard finding={finding} coinjoinTxids={new Set<string>()} />
    </TooltipProvider>,
  );
}

describe("PrivacyAudit FindingCard link rendering (offline-first)", () => {
  let openSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchSpy = vi.fn().mockRejectedValue(new Error("network access is forbidden"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a URL in the finding description as a click-only link and never fetches on load", () => {
    const url = "https://en.bitcoin.it/wiki/Address_reuse";
    renderCard(baseFinding({ description: `Learn more at ${url} now.` }));

    const desc = screen.getByText(/Learn more at/);
    const link = within(desc).getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe(url);

    // Offline-first: nothing is fetched merely by rendering the finding.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens the description link via window.open only on click (preventing navigation)", () => {
    const url = "https://example.com/reuse-guide";
    renderCard(baseFinding({ description: url }));

    const link = screen.getByRole("link", { name: url });

    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, clickEvent);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    // Opening is delegated to the browser, never fetched in-app.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a URL in the remediation/correction text as a click-only link", () => {
    const url = "https://example.com/fix-it";
    renderCard(baseFinding({ correction: `Follow ${url} to remediate.` }));

    // Reveal the collapsed details that contain the remediation block.
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const remediation = screen.getByTestId("text-remediation");
    const link = within(remediation).getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe(url);
    expect(fetchSpy).not.toHaveBeenCalled();

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, clickEvent);
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a URL in a source citation note as a click-only link", () => {
    const url = "https://www.walletexplorer.com/wallet/SomeExchange";
    const address = "bc1qexamplecitationaddress";
    renderCard(
      baseFinding({
        details: {
          citations: [
            {
              name: "SomeExchange",
              address,
              categoryLabel: "Exchange",
              sourceNote: `Tagged via ${url} snapshot.`,
            },
          ],
        },
      }),
    );

    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const citation = screen.getByTestId(`text-entity-source-${address}`);
    const link = within(citation).getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe(url);
    expect(fetchSpy).not.toHaveBeenCalled();

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, clickEvent);
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders plain description and remediation text without any link", () => {
    renderCard(
      baseFinding({
        description: "Just a plain description with no links.",
        correction: "Just a plain remediation with no links.",
      }),
    );

    const desc = screen.getByText("Just a plain description with no links.");
    expect(within(desc).queryByRole("link")).toBeNull();

    fireEvent.click(screen.getByTestId("button-toggle-details"));
    const remediation = screen.getByTestId("text-remediation");
    expect(remediation.textContent).toBe("Just a plain remediation with no links.");
    expect(within(remediation).queryByRole("link")).toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
