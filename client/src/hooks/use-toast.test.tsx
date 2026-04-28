// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { reducer, useToast, toast } from "./use-toast";

type ToastEntry = ReturnType<typeof makeToast>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const makeToast = (id: string, open = true) => ({
  id,
  open,
  title: `Toast ${id}`,
});

describe("reducer", () => {
  it("ADD_TOAST adds a toast to the beginning of the list", () => {
    const state = { toasts: [] as ToastEntry[] };
    const newToast = makeToast("1");
    const result = reducer(state, { type: "ADD_TOAST", toast: newToast });
    expect(result.toasts).toHaveLength(1);
    expect(result.toasts[0]).toEqual(newToast);
  });

  it("ADD_TOAST enforces TOAST_LIMIT by dropping older toasts when limit is exceeded", () => {
    const state = { toasts: [makeToast("1")] };
    const newToast = makeToast("2");
    const result = reducer(state, { type: "ADD_TOAST", toast: newToast });
    expect(result.toasts).toHaveLength(1);
    expect(result.toasts[0].id).toBe("2");
  });

  it("UPDATE_TOAST updates fields of a matching toast", () => {
    const state = { toasts: [makeToast("1")] };
    const result = reducer(state, {
      type: "UPDATE_TOAST",
      toast: { id: "1", title: "Updated" },
    });
    expect(result.toasts[0].title).toBe("Updated");
    expect(result.toasts[0].open).toBe(true);
  });

  it("UPDATE_TOAST does not modify non-matching toasts", () => {
    const state = { toasts: [makeToast("1"), makeToast("2")] };
    const result = reducer(state, {
      type: "UPDATE_TOAST",
      toast: { id: "1", title: "Updated" },
    });
    expect(result.toasts[1].title).toBe("Toast 2");
  });

  it("DISMISS_TOAST sets open to false for a specific toast", () => {
    const state = { toasts: [makeToast("1"), makeToast("2")] };
    const result = reducer(state, {
      type: "DISMISS_TOAST",
      toastId: "1",
    });
    expect(result.toasts[0].open).toBe(false);
    expect(result.toasts[1].open).toBe(true);
  });

  it("DISMISS_TOAST without toastId sets open to false for all toasts", () => {
    const state = { toasts: [makeToast("1"), makeToast("2")] };
    const result = reducer(state, { type: "DISMISS_TOAST" });
    expect(result.toasts.every((t) => t.open === false)).toBe(true);
  });

  it("REMOVE_TOAST removes a specific toast by id", () => {
    const state = { toasts: [makeToast("1"), makeToast("2")] };
    const result = reducer(state, {
      type: "REMOVE_TOAST",
      toastId: "1",
    });
    expect(result.toasts).toHaveLength(1);
    expect(result.toasts[0].id).toBe("2");
  });

  it("REMOVE_TOAST without toastId removes all toasts", () => {
    const state = { toasts: [makeToast("1"), makeToast("2")] };
    const result = reducer(state, { type: "REMOVE_TOAST" });
    expect(result.toasts).toHaveLength(0);
  });

  it("REMOVE_TOAST with non-existent id does not change the list", () => {
    const state = { toasts: [makeToast("1")] };
    const result = reducer(state, {
      type: "REMOVE_TOAST",
      toastId: "999",
    });
    expect(result.toasts).toHaveLength(1);
  });
});

describe("toast function", () => {
  it("returns an object with id, dismiss, and update", () => {
    const result = toast({ title: "Hello" });
    expect(result).toHaveProperty("id");
    expect(typeof result.id).toBe("string");
    expect(typeof result.dismiss).toBe("function");
    expect(typeof result.update).toBe("function");
  });

  it("generates unique ids for each toast", () => {
    const t1 = toast({ title: "First" });
    const t2 = toast({ title: "Second" });
    expect(t1.id).not.toBe(t2.id);
  });
});

describe("useToast", () => {
  it("returns current toasts and a toast function", () => {
    const { result } = renderHook(() => useToast());
    expect(result.current).toHaveProperty("toasts");
    expect(result.current).toHaveProperty("toast");
    expect(result.current).toHaveProperty("dismiss");
    expect(Array.isArray(result.current.toasts)).toBe(true);
  });

  it("reflects a toast added via the toast function", () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: "Test toast" });
    });

    expect(result.current.toasts.length).toBeGreaterThanOrEqual(1);
    const found = result.current.toasts.find(
      (t) => t.title === "Test toast",
    );
    expect(found).toBeDefined();
    expect(found!.open).toBe(true);
  });

  it("dismiss sets the toast open to false", () => {
    const { result } = renderHook(() => useToast());
    let toastId: string;

    act(() => {
      const t = result.current.toast({ title: "Dismissable" });
      toastId = t.id;
    });

    act(() => {
      result.current.dismiss(toastId!);
    });

    const found = result.current.toasts.find((t) => t.id === toastId!);
    if (found) {
      expect(found.open).toBe(false);
    }
  });

  it("cleans up listener on unmount", () => {
    const { result, unmount } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: "Before unmount" });
    });

    unmount();

    act(() => {
      toast({ title: "After unmount" });
    });
  });
});
