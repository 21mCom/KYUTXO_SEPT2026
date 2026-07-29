// @vitest-environment jsdom
//
// Covers the "View details" action on the "Transaction Rebuild Complete" toast
// (maintenance-tools-section.tsx): the action button must render on the
// success (Complete) toast only — not on the deferred or no-orphans variants —
// and clicking it must scroll the "Last rebuild result" panel container into
// view via rebuildSectionRef.current?.scrollIntoView.
//
// useToast is stubbed with a spy so each toast's `action` element can be
// inspected and rendered in isolation inside a real Radix ToastProvider/Toast;
// detectAndBackfill is stubbed (no provider/network here). scrollIntoView is
// not implemented by jsdom, so it is installed as a spy on Element.prototype
// and asserted against the actual element it was invoked on.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-toast")>();
  return {
    ...actual,
    useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  };
});

vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  return {
    ...actual,
    useSettings: () => ({ disableOrphanCheck: false, isLoading: false }),
    updateDisableOrphanCheck: vi.fn(),
  };
});

const detectAndBackfillMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/txid-backfill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/txid-backfill")>();
  return {
    ...actual,
    detectAndBackfill: detectAndBackfillMock,
  };
});

import type { BackfillResult } from "@/lib/txid-backfill";
import { ToastProvider, Toast, ToastViewport } from "@/components/ui/toast";

const { renderWithProviders } = await import("@/test/testProviders");
const { MaintenanceToolsSection } = await import("./maintenance-tools-section");

function makeResult(over: Partial<BackfillResult> = {}): BackfillResult {
  return {
    orphansFound: 5,
    rebuilt: 5,
    skipped: 0,
    skippedReasons: {},
    failed: 0,
    prevoutsResolved: 0,
    deferred: false,
    errors: [],
    ...over,
  };
}

// jsdom does not implement scrollIntoView; install a spy so the component's
// rebuildSectionRef.current?.scrollIntoView(...) call is observable, including
// which element it ran on.
const scrollIntoViewSpy = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  toastSpy.mockReset();
  detectAndBackfillMock.mockReset();
  scrollIntoViewSpy.mockReset();
  Element.prototype.scrollIntoView = scrollIntoViewSpy as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

async function runRebuildAndGetToast(title: string) {
  renderWithProviders(<MaintenanceToolsSection />);
  fireEvent.click(screen.getByTestId("button-rebuild-transactions"));
  await waitFor(() => {
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title }));
  });
  return toastSpy.mock.calls.find((c) => c[0]?.title === title)?.[0] as {
    action?: ReactElement;
  };
}

describe("rebuild completion toast 'View details' action", () => {
  it("renders the action on the Complete toast and clicking it scrolls the result panel into view", async () => {
    detectAndBackfillMock.mockResolvedValue(makeResult());

    const toastArgs = await runRebuildAndGetToast("Transaction Rebuild Complete");
    expect(toastArgs.action).toBeTruthy();

    // The persistent result panel is visible and lives inside the container
    // the ref points at.
    const summary = await screen.findByTestId("rebuild-result-summary");

    // Mount the captured ToastAction in a real Radix toast so it is clickable.
    render(
      <ToastProvider>
        <Toast open>{toastArgs.action}</Toast>
        <ToastViewport />
      </ToastProvider>,
    );

    const button = screen.getByTestId("button-view-rebuild-details");
    expect(button.textContent).toContain("View details");

    fireEvent.click(button);

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    // It must have been invoked on the rebuild section container — the element
    // that wraps the "Last rebuild result" panel.
    const target = scrollIntoViewSpy.mock.instances[0] as unknown as HTMLElement;
    expect(target.contains(summary)).toBe(true);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth", block: "center" }),
    );
  });

  it("omits the action on the deferred toast", async () => {
    detectAndBackfillMock.mockResolvedValue(
      makeResult({ deferred: true, deferReason: "No blockchain node configured." } as Partial<BackfillResult>),
    );

    const toastArgs = await runRebuildAndGetToast("Transaction Rebuild Deferred");
    expect(toastArgs.action).toBeUndefined();
  });

  it("omits the action on the no-orphans toast", async () => {
    detectAndBackfillMock.mockResolvedValue(makeResult({ orphansFound: 0, rebuilt: 0 }));

    const toastArgs = await runRebuildAndGetToast("No Orphaned Transactions");
    expect(toastArgs.action).toBeUndefined();
  });
});
