// @vitest-environment jsdom
//
// Task: warn users before they copy an address tagged as suspected poisoning.
// AddressLink shows a red shield on tagged addresses and turns the copy button
// into a two-step guard: the first click warns (destructive toast, no copy),
// a second click within the arm window copies anyway.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import type { Record as DbRecord } from "@/lib/database";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const { openRecordPreview, openRecordPreviewByAddress } = vi.hoisted(() => ({
  openRecordPreview: vi.fn(() => Promise.resolve()),
  openRecordPreviewByAddress: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreview, openRecordPreviewByAddress }),
}));

// Control the metadata-hover cache so the guard's record resolution is
// deterministic without IndexedDB. Keep the pure field helpers real.
const { cacheByAddress } = vi.hoisted(() => ({
  cacheByAddress: new Map<string, DbRecord | null>(),
}));
vi.mock("@/lib/metadata-hover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metadata-hover")>();
  return {
    ...actual,
    getCachedRecord: (id: string) => cacheByAddress.get(id),
    subscribeCacheEntry: () => () => {},
    resolveIdentifier: async (id: string) => cacheByAddress.get(id) ?? null,
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { AddressLink } from "./AddressLink";

const POISONED = "bc1qvictimabc1111111111111111wxyz9999";
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
});

function renderLink(address: string) {
  return render(
    <TooltipProvider>
      <AddressLink address={address} />
    </TooltipProvider>,
  );
}

describe("AddressLink suspected-poisoning guard", () => {
  it("shows the red warning icon for a tagged address and not for a clean one", async () => {
    cacheByAddress.set(POISONED, makeRecord(POISONED, ["suspected-poisoning"]));
    cacheByAddress.set(CLEAN, makeRecord(CLEAN, ["exchange"]));

    renderLink(POISONED);
    expect(
      await screen.findByTestId(`icon-poisoning-warning-${POISONED.slice(0, 8)}`),
    ).toBeTruthy();
    cleanup();

    renderLink(CLEAN);
    expect(
      screen.queryByTestId(`icon-poisoning-warning-${CLEAN.slice(0, 8)}`),
    ).toBeNull();
  });

  it("first copy click warns without copying; second click copies", async () => {
    cacheByAddress.set(POISONED, makeRecord(POISONED, ["suspected-poisoning"]));
    renderLink(POISONED);

    const copyBtn = screen.getByTestId(`button-copy-address-${POISONED.slice(0, 8)}`);
    toastMock.mockClear();

    fireEvent.click(copyBtn);
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        title: expect.stringMatching(/poisoning/i),
        description: expect.stringMatching(/lookalike of one of your own addresses/i),
      }),
    );

    fireEvent.click(copyBtn);
    await flush();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(POISONED));
  });

  it("guards even when the cache is cold at click time (resolves first)", async () => {
    // No cache entry at render; resolveIdentifier finds the tagged record.
    renderLink(POISONED);
    cacheByAddress.set(POISONED, makeRecord(POISONED, ["suspected-poisoning"]));

    const copyBtn = screen.getByTestId(`button-copy-address-${POISONED.slice(0, 8)}`);
    toastMock.mockClear();
    fireEvent.click(copyBtn);
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("copies a clean address immediately, and a target-tagged (own) address too", async () => {
    cacheByAddress.set(CLEAN, makeRecord(CLEAN, ["poisoning-target"]));
    renderLink(CLEAN);

    fireEvent.click(screen.getByTestId(`button-copy-address-${CLEAN.slice(0, 8)}`));
    await flush();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CLEAN));
  });
});
