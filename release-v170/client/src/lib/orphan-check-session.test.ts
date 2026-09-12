// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ORPHAN_CHECK_DONE_KEY,
  ORPHANS_AWAITING_PROVIDER_KEY,
  resetOrphanCheckGate,
} from "./orphan-check-session";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("resetOrphanCheckGate", () => {
  it("clears both the done and awaiting-provider gate keys", () => {
    sessionStorage.setItem(ORPHAN_CHECK_DONE_KEY, "1");
    sessionStorage.setItem(ORPHANS_AWAITING_PROVIDER_KEY, "1");

    resetOrphanCheckGate();

    expect(sessionStorage.getItem(ORPHAN_CHECK_DONE_KEY)).toBeNull();
    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBeNull();
  });

  it("is a no-op when the keys are not set", () => {
    expect(() => resetOrphanCheckGate()).not.toThrow();
    expect(sessionStorage.getItem(ORPHAN_CHECK_DONE_KEY)).toBeNull();
    expect(sessionStorage.getItem(ORPHANS_AWAITING_PROVIDER_KEY)).toBeNull();
  });

  it("leaves unrelated session keys untouched", () => {
    sessionStorage.setItem(ORPHAN_CHECK_DONE_KEY, "1");
    sessionStorage.setItem("kyutxo:unrelated", "keep-me");

    resetOrphanCheckGate();

    expect(sessionStorage.getItem(ORPHAN_CHECK_DONE_KEY)).toBeNull();
    expect(sessionStorage.getItem("kyutxo:unrelated")).toBe("keep-me");
  });

  it("tolerates sessionStorage access failures without throwing", () => {
    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("sessionStorage disabled");
      });

    expect(() => resetOrphanCheckGate()).not.toThrow();
    // It at least attempted to clear the gate before bailing out.
    expect(removeItem).toHaveBeenCalled();
  });
});
