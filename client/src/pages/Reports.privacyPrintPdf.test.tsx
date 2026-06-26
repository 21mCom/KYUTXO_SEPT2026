// @vitest-environment jsdom
//
// Coverage for the "Print / PDF" action in the Privacy Audit report panel
// (exportPdf in Reports.tsx). The printable-HTML builder (buildPrintableReport)
// and the in-window copy-button wiring (wireReportCopyButton) are unit-tested
// directly in lib/__tests__/privacy-report-html.test.ts and
// lib/__tests__/privacy-report-copy-button.test.ts. This file guards the
// page-level glue that ties them together:
//   - opening a new window and writing the printable HTML into it,
//   - showing a destructive toast when the pop-up is blocked (window.open null),
//   - wiring the in-window "Copy" button so it copies via the async Clipboard
//     API and falls back to execCommand("copy"), updating the status text.
//
// We render the real PrivacyAuditReportPanel but stub the data-fetching chain
// (owners/wallets hooks, the address page query, toast) and replace
// runPrivacyAudit with one returning a fixed PrivacyAuditResult, so only the
// print/PDF UI wiring is exercised. buildPrintableReport, buildPrivacyTextReport
// and wireReportCopyButton are left REAL so the produced HTML / wired button is
// the actual production behavior.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

// A hoisted toast spy so the mocked useToast hands back the same fn we assert on.
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

// Radix Select doesn't open under jsdom; swap it for a minimal native <select>
// that wires value / onValueChange the same way (mirrors the sibling export
// test). The print/PDF wiring under test is unaffected.
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

// One address record that matches the default "all" scope so generate() never
// short-circuits with a "No Addresses" toast.
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

// ── Fake print window ────────────────────────────────────────────────────────
// exportPdf opens a window, writes the printable HTML, then wires the in-window
// copy button against that window's document. jsdom's window.open returns a
// non-functional stub, so we substitute a fake window whose document.write
// accumulates HTML and, on close(), parses it into a REAL Document (via
// DOMParser). That keeps getElementById / createElement / the wired button's
// behavior real end-to-end while staying deterministic.
type FakeWindow = {
  win: any;
  getWritten: () => string;
  setClipboard: (value: unknown) => void;
  setExecCommand: (fn: (cmd: string) => boolean) => void;
};

function makeFakeWindow(): FakeWindow {
  let buffer = "";
  let parsed: Document | null = null;
  let clipboard: unknown;
  let execCommand: ((cmd: string) => boolean) | undefined;

  const doc: any = {
    open: () => {
      buffer = "";
    },
    write: (s: string) => {
      buffer += s;
    },
    close: () => {
      parsed = new DOMParser().parseFromString(buffer, "text/html");
    },
    getElementById: (id: string) => parsed?.getElementById(id) ?? null,
    createElement: (tag: string) => parsed!.createElement(tag),
    get body() {
      return parsed!.body;
    },
    get activeElement() {
      return parsed!.activeElement;
    },
    execCommand: (cmd: string) => (execCommand ? execCommand(cmd) : false),
  };

  const win: any = {
    document: doc,
    navigator: {
      get clipboard() {
        return clipboard;
      },
    },
    focus: vi.fn(),
    print: vi.fn(),
  };

  return {
    win,
    getWritten: () => buffer,
    setClipboard: (value: unknown) => {
      clipboard = value;
    },
    setExecCommand: (fn: (cmd: string) => boolean) => {
      execCommand = fn;
    },
  };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  toastSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  // Wait for the async generate() -> mock runPrivacyAudit -> buttons to render.
  await waitFor(() => utils.getByTestId("button-print-privacy-report"));
  return utils;
}

describe("PrivacyAuditReportPanel — Print / PDF", () => {
  it("opens a new window and writes the printable report HTML into it", async () => {
    const fake = makeFakeWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fake.win);

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-print-privacy-report"));

    // A blank pop-up window was requested.
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(fake.win.focus).toHaveBeenCalledTimes(1);

    // The written document is the buildPrintableReport output: a full HTML doc
    // carrying the report header, the (real) finding text, the score summary,
    // and the in-window copy-button markup wired afterwards.
    const html = fake.getWritten();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Privacy Audit Report");
    expect(html).toContain('id="copy-report-btn"');
    expect(html).toContain('id="copy-report-status"');
    expect(html).toContain("Address reused across multiple transactions.");
    expect(html).toContain("Findings &amp; Warnings (1)");
    // Grade + score summary boxes come straight from the audit result.
    expect(html).toContain("85/100");
    expect(html).toContain(">B<");
    // Default scope (no owner/wallet selected) is reflected in the report.
    expect(html).toContain("Owner: All");
    expect(html).toContain("Wallet: All");

    // After a short layout delay the print dialog is invoked so users can
    // "Save as PDF". The 250ms setTimeout fires on real timers within waitFor.
    await waitFor(() => expect(fake.win.print).toHaveBeenCalledTimes(1));
  });

  it("shows a destructive toast and does not write/print when the pop-up is blocked (window.open returns null)", async () => {
    // A fake window we deliberately do NOT return from window.open: it lets us
    // prove the blocked branch never touches a window's document or print().
    const fake = makeFakeWindow();
    const writeSpy = vi.spyOn(fake.win.document, "write");
    vi.spyOn(window, "open").mockReturnValue(null);

    const { getByTestId } = await renderWithResult();
    // Clicking must not throw even though there is no window to write into.
    expect(() => fireEvent.click(getByTestId("button-print-privacy-report"))).not.toThrow();

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        title: "Could Not Open Print View",
        description: expect.stringContaining("pop-ups"),
      }),
    );

    // The early return means nothing is ever written or printed. Give the print
    // setTimeout (250ms) ample time to confirm it was never scheduled.
    await new Promise((r) => setTimeout(r, 350));
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fake.win.print).not.toHaveBeenCalled();
    expect(fake.win.focus).not.toHaveBeenCalled();
  });

  it("wires the in-window Copy button to write the report via the Clipboard API", async () => {
    const fake = makeFakeWindow();
    const writeText = vi.fn().mockResolvedValue(undefined);
    fake.setClipboard({ writeText });
    vi.spyOn(window, "open").mockReturnValue(fake.win);

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-print-privacy-report"));

    const btn = fake.win.document.getElementById("copy-report-btn");
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Let the async click handler's awaited writeText settle.
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    // It copied the plain-text report (same builder as Copy / Export Text).
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("PRIVACY AUDIT REPORT");
    expect(copied).toContain("Grade: B");
    expect(copied).toContain("Address reused across multiple transactions.");

    const statusEl = fake.win.document.getElementById("copy-report-status");
    expect(statusEl.textContent).toBe("Copied to clipboard.");
    expect(statusEl.style.color).toBe("rgb(22, 163, 74)"); // #16a34a
  });

  it("falls back to execCommand('copy') when the Clipboard API is unavailable", async () => {
    const fake = makeFakeWindow();
    fake.setClipboard(undefined); // no async Clipboard API in this window
    let copiedValue: string | null = null;
    fake.setExecCommand((cmd) => {
      if (cmd === "copy") {
        // The temporary textarea is still appended to the body during the copy
        // call (it's removed immediately after), so read it from there. We can't
        // rely on document.activeElement: focus() is a no-op in a parsed
        // (non-active) DOMParser document.
        const ta = fake.win.document.body.querySelector(
          "textarea",
        ) as HTMLTextAreaElement | null;
        copiedValue = ta?.value ?? null;
      }
      return true;
    });
    vi.spyOn(window, "open").mockReturnValue(fake.win);

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-print-privacy-report"));

    const btn = fake.win.document.getElementById("copy-report-btn");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const statusEl = fake.win.document.getElementById("copy-report-status");
    await vi.waitFor(() => expect(statusEl.textContent).toBe("Copied to clipboard."));

    // The temporary textarea selected at copy time carried the real report text.
    expect(copiedValue).toContain("PRIVACY AUDIT REPORT");
    expect(copiedValue).toContain("Grade: B");
    // The textarea is cleaned up after copying.
    expect(fake.win.document.body.querySelector("textarea")).toBeNull();
    expect(statusEl.style.color).toBe("rgb(22, 163, 74)"); // #16a34a
  });

  it("reports a failure in the status text when execCommand returns false", async () => {
    const fake = makeFakeWindow();
    fake.setClipboard(undefined);
    fake.setExecCommand(() => false);
    vi.spyOn(window, "open").mockReturnValue(fake.win);

    const { getByTestId } = await renderWithResult();
    fireEvent.click(getByTestId("button-print-privacy-report"));

    const btn = fake.win.document.getElementById("copy-report-btn");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const statusEl = fake.win.document.getElementById("copy-report-status");
    await vi.waitFor(() =>
      expect(statusEl.textContent).toBe(
        "Copy unavailable — select the text and press Ctrl/Cmd+C.",
      ),
    );
    expect(statusEl.style.color).toBe("rgb(220, 38, 38)"); // #dc2626
  });
});
