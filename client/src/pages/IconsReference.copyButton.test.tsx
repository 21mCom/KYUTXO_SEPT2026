// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import { TooltipProvider } from "@/components/ui/tooltip";
import IconsReference from "./IconsReference";

function renderPage() {
  return render(
    <TooltipProvider>
      <IconsReference />
    </TooltipProvider>,
  );
}

// The first lucide icon in the reference grid. Card test ids are the
// lowercased icon name (see data-testid={`icon-${item.name.toLowerCase()}`}).
const ICON_NAME = "Activity";
const ICON_TESTID = `icon-${ICON_NAME.toLowerCase()}`;

let writeText: ReturnType<typeof vi.fn>;

// Flush pending promise microtasks (and the React state updates they trigger).
async function flush() {
  await act(async () => {
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("IconsReference copy button", () => {
  it("writes the icon name to the clipboard and surfaces the success toast", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId(ICON_TESTID));
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ICON_NAME);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: `Copied "${ICON_NAME}"` }),
    );
    // Success toast must not be destructive.
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("flashes the copied (ring) state and resets after 2s", async () => {
    vi.useFakeTimers();
    renderPage();
    const card = screen.getByTestId(ICON_TESTID);

    expect(card.className).not.toContain("ring-2");

    fireEvent.click(card);
    await flush();
    expect(card.className).toContain("ring-2");

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(card.className).toContain("ring-2");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(card.className).not.toContain("ring-2");
  });

  it("surfaces the destructive 'Copy failed' toast and does not flash when the clipboard write is rejected", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderPage();
    const card = screen.getByTestId(ICON_TESTID);

    fireEvent.click(card);
    await flush();

    expect(card.className).not.toContain("ring-2");
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Copy failed",
        variant: "destructive",
      }),
    );
  });

  it("surfaces the destructive toast when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    renderPage();
    const card = screen.getByTestId(ICON_TESTID);

    fireEvent.click(card);
    await flush();

    expect(card.className).not.toContain("ring-2");
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});
