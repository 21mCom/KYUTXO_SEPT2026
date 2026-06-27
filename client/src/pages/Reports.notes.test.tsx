// @vitest-environment jsdom
//
// Verifies that the Reports page privacy-finding surfaces wire the shared
// renderSourceNote util through their display markup and uphold the
// offline-first guarantee: http(s) URLs render as clickable anchors that are
// only ever opened on an explicit user click (window.open) and are NEVER
// fetched at load time. Notes without a URL must still render as plain text.
//
// Mounting the full Reports page requires the engine client + IndexedDB, so —
// following the Evidence.notes.test.tsx / VaultManagement.notes.test.tsx
// pattern — we faithfully replicate the exact JSX Reports.tsx uses to display
// privacy-finding text:
//   - Description:  `<div ...>{renderSourceNote(f.description)}</div>`
//   - Remediation:  `<div ...>Fix: {renderSourceNote(f.correction)}</div>`
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { renderSourceNote } from "@/lib/renderSourceNote";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Faithful replica of Reports.tsx's privacy-finding description markup. */
function FindingDescription({ description }: { description: string }) {
  return (
    <div
      className="text-xs text-muted-foreground mt-0.5 line-clamp-2"
      data-testid="text-privacy-finding-description"
    >
      {renderSourceNote(description)}
    </div>
  );
}

/** Faithful replica of Reports.tsx's privacy-finding remediation markup. */
function FindingCorrection({ correction }: { correction: string }) {
  return (
    <div
      className="text-xs text-muted-foreground mt-0.5 italic"
      data-testid="text-privacy-finding-correction"
    >
      Fix: {renderSourceNote(correction)}
    </div>
  );
}

describe("Reports privacy-finding link rendering (offline-first)", () => {
  it("renders a URL in a finding description as a clickable anchor with the correct href", () => {
    const { getByTestId } = render(
      <FindingDescription description="Address reuse detected — see https://en.bitcoin.it/wiki/Address_reuse for details" />,
    );
    const desc = getByTestId("text-privacy-finding-description");
    const link = desc.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(
      "https://en.bitcoin.it/wiki/Address_reuse",
    );
    expect(link.textContent).toBe("https://en.bitcoin.it/wiki/Address_reuse");
    expect(desc.textContent).toBe(
      "Address reuse detected — see https://en.bitcoin.it/wiki/Address_reuse for details",
    );
  });

  it("renders a URL in remediation (Fix) text as a clickable anchor with the correct href", () => {
    const { getByTestId } = render(
      <FindingCorrection correction="Use a new address per receive; guide at https://example.com/privacy-guide" />,
    );
    const fix = getByTestId("text-privacy-finding-correction");
    const link = fix.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(
      "https://example.com/privacy-guide",
    );
    // The static "Fix: " prefix is preserved alongside the linked URL.
    expect(fix.textContent).toBe(
      "Fix: Use a new address per receive; guide at https://example.com/privacy-guide",
    );
  });

  it("opens a finding-description link via window.open without fetching at render", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const { getByTestId } = render(
      <FindingDescription description="ref https://example.com" />,
    );

    // Render alone must never fetch or open anything (offline-first).
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    const link = getByTestId(
      "text-privacy-finding-description",
    ).querySelector("a") as HTMLAnchorElement;

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link, clickEvent);

    // The link opens externally via window.open; default navigation is prevented.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
    expect(clickEvent.defaultPrevented).toBe(true);
    // Still no fetch — opening is delegated to the browser, not fetched in-app.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens a remediation link via window.open without fetching at render", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const { getByTestId } = render(
      <FindingCorrection correction="See https://example.org/fix" />,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    const link = getByTestId(
      "text-privacy-finding-correction",
    ).querySelector("a") as HTMLAnchorElement;
    fireEvent.click(link);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.org/fix",
      "_blank",
      "noopener,noreferrer",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a finding description without a URL as plain text (no link)", () => {
    const plain = "Multiple inputs from different addresses were combined.";
    const { getByTestId } = render(
      <FindingDescription description={plain} />,
    );
    const desc = getByTestId("text-privacy-finding-description");
    expect(desc.textContent).toBe(plain);
    expect(desc.querySelector("a")).toBeNull();
  });
});
