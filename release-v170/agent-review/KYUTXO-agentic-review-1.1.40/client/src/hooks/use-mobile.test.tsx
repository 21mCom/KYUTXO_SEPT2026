// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIsMobile } from "./use-mobile";

let changeHandler: (() => void) | null = null;
let mockMatches = false;

const mockMatchMedia = vi.fn((query: string) => ({
  matches: mockMatches,
  media: query,
  onchange: null,
  addEventListener: vi.fn((_event: string, handler: () => void) => {
    changeHandler = handler;
  }),
  removeEventListener: vi.fn((_event: string, _handler: () => void) => {
    if (_handler === changeHandler) {
      changeHandler = null;
    }
  }),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

beforeEach(() => {
  changeHandler = null;
  mockMatches = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: mockMatchMedia,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useIsMobile", () => {
  it("returns false when window width is above the breakpoint", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 1024,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("returns true when window width is below the breakpoint", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 500,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("returns true when window width is exactly at the breakpoint minus one", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 767,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("returns false when window width is exactly the breakpoint", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 768,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("registers a matchMedia listener with the correct query", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 1024,
    });

    renderHook(() => useIsMobile());

    expect(mockMatchMedia).toHaveBeenCalledWith("(max-width: 767px)");
  });

  it("updates when the media query change event fires", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 1024,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 500,
    });

    act(() => {
      changeHandler?.();
    });

    expect(result.current).toBe(true);
  });

  it("cleans up the event listener on unmount", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      value: 1024,
    });

    const { unmount } = renderHook(() => useIsMobile());

    const mqlInstance = mockMatchMedia.mock.results[
      mockMatchMedia.mock.results.length - 1
    ].value;

    unmount();

    expect(mqlInstance.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});
