// @vitest-environment jsdom
//
// Task: warn about suspected-poisoning addresses on every copy button, not
// just AddressLink. useGuardedAddressCopy is the shared two-step guard used
// by non-AddressLink copy affordances (Balance heuristic list, Network
// Analysis, Flow Visualizer, peel chain, Address Reuse, QR scanner, ...):
// the first copy click on a tagged address warns (destructive toast, no
// copy); a second click within the arm window copies anyway. Untagged
// addresses copy immediately. Arm state is per-address so a list-backed hook
// instance never lets one warned address arm a different one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { Record as DbRecord } from "@/lib/database";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

// Control the metadata-hover cache so record resolution is deterministic
// without IndexedDB.
const { cacheByAddress } = vi.hoisted(() => ({
  cacheByAddress: new Map<string, DbRecord | null>(),
}));
vi.mock("@/lib/metadata-hover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metadata-hover")>();
  return {
    ...actual,
    getCachedRecord: (id: string) => cacheByAddress.get(id),
    resolveIdentifier: async (id: string) => cacheByAddress.get(id) ?? null,
  };
});

import { useGuardedAddressCopy } from "./use-guarded-address-copy";

const POISONED = "bc1qvictimabc1111111111111111wxyz9999";
const POISONED_2 = "bc1qothersuspect222222222222222aaaa0000";
const CLEAN = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

function makeRecord(address: string, tags: string[]): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString: address,
    label: "",
    tags,
    categories: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as DbRecord;
}

function Harness({ addresses }: { addresses: string[] }) {
  const { copyAddress, isArmed } = useGuardedAddressCopy();
  return (
    <div>
      {addresses.map((a) => (
        <button
          key={a}
          data-testid={`copy-${a.slice(-4)}`}
          data-armed={isArmed(a) ? "yes" : "no"}
          onClick={() => void copyAddress(a)}
        >
          copy
        </button>
      ))}
    </div>
  );
}

let writeText: ReturnType<typeof vi.fn>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
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
  cacheByAddress.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useGuardedAddressCopy", () => {
  it("copies an untagged address immediately", async () => {
    cacheByAddress.set(CLEAN, makeRecord(CLEAN, ["personal"]));
    render(<Harness addresses={[CLEAN]} />);
    fireEvent.click(screen.getByTestId(`copy-${CLEAN.slice(-4)}`));
    await flush();
    expect(writeText).toHaveBeenCalledWith(CLEAN);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Address copied" }),
    );
  });

  it("copies immediately when no record exists (cold cache resolves null)", async () => {
    render(<Harness addresses={[CLEAN]} />);
    fireEvent.click(screen.getByTestId(`copy-${CLEAN.slice(-4)}`));
    await flush();
    expect(writeText).toHaveBeenCalledWith(CLEAN);
  });

  it("warns on first click for a tagged address and copies on the second", async () => {
    cacheByAddress.set(
      POISONED,
      makeRecord(POISONED, ["suspected-poisoning"]),
    );
    render(<Harness addresses={[POISONED]} />);
    const btn = screen.getByTestId(`copy-${POISONED.slice(-4)}`);

    fireEvent.click(btn);
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Suspected address-poisoning address",
        variant: "destructive",
      }),
    );
    expect(btn.getAttribute("data-armed")).toBe("yes");

    fireEvent.click(btn);
    await flush();
    expect(writeText).toHaveBeenCalledWith(POISONED);
    expect(btn.getAttribute("data-armed")).toBe("no");
  });

  it("resolves the record on a cold cache before deciding to warn", async () => {
    // getCachedRecord returns undefined (not in map) -> falls back to
    // resolveIdentifier. Seed only for the resolve path.
    const rec = makeRecord(POISONED, ["suspected-poisoning"]);
    cacheByAddress.set(POISONED, rec);
    const spy = vi.spyOn(cacheByAddress, "get");
    // First call (getCachedRecord) returns undefined; later calls resolve.
    spy.mockImplementationOnce(() => undefined);
    render(<Harness addresses={[POISONED]} />);
    fireEvent.click(screen.getByTestId(`copy-${POISONED.slice(-4)}`));
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
    spy.mockRestore();
  });

  it("arms per-address: warning one address does not arm another", async () => {
    cacheByAddress.set(POISONED, makeRecord(POISONED, ["suspected-poisoning"]));
    cacheByAddress.set(
      POISONED_2,
      makeRecord(POISONED_2, ["suspected-poisoning"]),
    );
    render(<Harness addresses={[POISONED, POISONED_2]} />);

    fireEvent.click(screen.getByTestId(`copy-${POISONED.slice(-4)}`));
    await flush();
    expect(writeText).not.toHaveBeenCalled();

    // Clicking the OTHER tagged address must warn, not copy.
    fireEvent.click(screen.getByTestId(`copy-${POISONED_2.slice(-4)}`));
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it("disarms after the arm window elapses", async () => {
    vi.useFakeTimers();
    cacheByAddress.set(POISONED, makeRecord(POISONED, ["suspected-poisoning"]));
    render(<Harness addresses={[POISONED]} />);
    const btn = screen.getByTestId(`copy-${POISONED.slice(-4)}`);

    fireEvent.click(btn);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(btn.getAttribute("data-armed")).toBe("yes");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(btn.getAttribute("data-armed")).toBe("no");

    // Next click warns again instead of copying.
    fireEvent.click(btn);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(writeText).not.toHaveBeenCalled();
  });
});
