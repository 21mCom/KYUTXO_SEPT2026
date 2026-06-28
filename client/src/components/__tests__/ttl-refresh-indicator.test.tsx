// @vitest-environment jsdom
//
// Proves the user-visible TTL-refresh behaviour that issue #1167 only covered at
// the pure-cache layer (getCachedRecord dropping entries older than the 5-minute
// window). Here we render the REAL AddressLink against the REAL metadata-hover
// cache + subscriber pipeline and assert that, after the TTL window elapses, a
// later preload (as a running page fires for its visible rows on scroll)
// re-resolves the record and the orange FileText icon updates ON ITS OWN -
// without a full reload and without a hover. Both directions are covered: an
// icon that must APPEAR and one that must DISAPPEAR after the underlying record
// changes.
//
// Only the IndexedDB query seam, RecordPreview context, settings, clipboard and
// toast are stubbed; the cache TTL logic, the subscribe/notify lifecycle and the
// icon rendering are all the real implementation. It is allow-listed in
// scripts/check-test-providers.js because (like preload-indicator.test.tsx) it
// intentionally mocks RecordPreviewContext to render under a bare
// TooltipProvider.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { Record as DbRecord } from "@/lib/database";
import { DEFAULT_HOVER_TOOLTIP_PREFS } from "@/lib/metadata-hover";

// metadata-hover's batch path (the one a page's visible-range preload uses) fans
// out to getRecordsByInputStrings; the single-hover path uses
// getRecordsByInputString. Stub both so every fetch is observable and the result
// shape is fully controlled.
const { getRecordsByInputString, getRecordsByInputStrings } = vi.hoisted(() => ({
  getRecordsByInputString: vi.fn(),
  getRecordsByInputStrings: vi.fn(),
}));
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByInputString,
  getRecordsByInputStrings,
}));

const { openRecordPreview, openRecordPreviewByAddress } = vi.hoisted(() => ({
  openRecordPreview: vi.fn(() => Promise.resolve()),
  openRecordPreviewByAddress: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreview, openRecordPreviewByAddress }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ copy: vi.fn(), isCopied: () => false }),
}));
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ hoverTooltipPrefs: { ...DEFAULT_HOVER_TOOLTIP_PREFS } }),
}));

import { AddressLink } from "../AddressLink";
import { TooltipProvider } from "@/components/ui/tooltip";
import { batchPreloadIdentifiers, invalidateCachedRecord } from "@/lib/metadata-hover";

// Mirrors the module-local CACHE_TTL_MS in metadata-hover.ts (5 minutes).
const CACHE_TTL_MS = 5 * 60 * 1000;
const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

function recordWithMetadata(inputString: string): DbRecord {
  return {
    id: 7,
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "Cold Storage",
    notes: "savings",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
  } as DbRecord;
}

function recordWithoutMetadata(inputString: string): DbRecord {
  // A record exists but carries nothing hasHoverMetadata would surface, so the
  // indicator must stay hidden.
  return {
    id: 7,
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "Unlabeled",
    notes: "",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
  } as DbRecord;
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function hasIndicator(trigger: HTMLElement): boolean {
  return trigger.querySelector("svg.lucide-file-text") !== null;
}

// Flush the microtask queue so the (un-awaited) async batch fetch settles and
// its synchronous subscriber notification has applied React state. We avoid
// waitFor here because it polls via fake-able timers and would hang under
// vi.useFakeTimers().
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function preload() {
  await act(async () => {
    batchPreloadIdentifiers([ADDRESS]);
    await flush();
  });
}

beforeEach(() => {
  getRecordsByInputString.mockReset();
  getRecordsByInputStrings.mockReset();
  // Drop any cross-test residue from the module-level cache (not reset by
  // cleanup()/clearAllMocks()).
  invalidateCachedRecord(ADDRESS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const triggerId = `link-address-${ADDRESS.slice(0, 8)}`;

describe("AddressLink note icon refreshes after the TTL window", () => {
  it("makes the icon APPEAR after the record gains metadata once the TTL elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Initially the address has no surfaced metadata -> a preload caches the
    // (no-icon) state.
    getRecordsByInputStrings.mockResolvedValue([recordWithoutMetadata(ADDRESS)]);

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    await preload();
    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);
    expect(hasIndicator(trigger)).toBe(false);

    // The underlying record gains metadata (e.g. an import path that did not
    // invalidate the cache, or a change made elsewhere).
    getRecordsByInputStrings.mockResolvedValue([recordWithMetadata(ADDRESS)]);

    // Within the TTL window a re-preload is a cache hit, so the stale (no-icon)
    // state is intentionally kept and no new fetch happens.
    vi.setSystemTime(CACHE_TTL_MS - 1);
    await preload();
    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);
    expect(hasIndicator(trigger)).toBe(false);

    // Past the TTL window the cached entry is dropped, the next preload
    // re-resolves from the DB and the subscriber lights the icon up on its own.
    vi.setSystemTime(CACHE_TTL_MS + 1);
    await preload();
    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(2);
    expect(hasIndicator(trigger)).toBe(true);

    // No hover ever happened.
    expect(getRecordsByInputString).not.toHaveBeenCalled();
  });

  it("makes the icon DISAPPEAR after the record loses metadata once the TTL elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Initially the address has metadata -> a preload lights the icon.
    getRecordsByInputStrings.mockResolvedValue([recordWithMetadata(ADDRESS)]);

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    await preload();
    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);
    expect(hasIndicator(trigger)).toBe(true);

    // The underlying record loses its metadata without invalidating the cache.
    getRecordsByInputStrings.mockResolvedValue([recordWithoutMetadata(ADDRESS)]);

    // Within the TTL window the stale (icon) state is kept; no new fetch.
    vi.setSystemTime(CACHE_TTL_MS - 1);
    await preload();
    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(1);
    expect(hasIndicator(trigger)).toBe(true);

    // Past the TTL window the next preload re-resolves and the icon clears
    // itself, with no reload and no hover.
    vi.setSystemTime(CACHE_TTL_MS + 1);
    await preload();
    expect(getRecordsByInputStrings).toHaveBeenCalledTimes(2);
    expect(hasIndicator(trigger)).toBe(false);

    expect(getRecordsByInputString).not.toHaveBeenCalled();
  });
});
