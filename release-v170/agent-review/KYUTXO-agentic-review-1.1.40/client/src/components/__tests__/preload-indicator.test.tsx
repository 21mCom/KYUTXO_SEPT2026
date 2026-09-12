// @vitest-environment jsdom
//
// End-to-end proof of the headline behaviour: in a large list a row's note
// icon must appear WITHOUT the user hovering. AddressLink / TxidLink mount with
// no cached entry (so no indicator), subscribe to their identifier, and when an
// EXTERNAL preload (batchPreloadIdentifiers, as the page fires for visible
// rows) resolves the record, the orange FileText icon must light up on its own.
//
// This renders the real AddressLink / TxidLink against the real metadata-hover
// cache + subscriber pipeline; only the IndexedDB query, RecordPreview context,
// settings, and clipboard are stubbed so the render is cheap and deterministic.
// It is allow-listed in scripts/check-test-providers.js because it intentionally
// mocks RecordPreviewContext to render under a bare TooltipProvider.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import type { Record as DbRecord } from "@/lib/database";
import { DEFAULT_HOVER_TOOLTIP_PREFS } from "@/lib/metadata-hover";

// metadata-hover's batch path fans out to getRecordsByInputStrings; the
// single-hover path uses getRecordsByInputString. Stub both.
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
import { TxidLink } from "../TxidLink";
import { TooltipProvider } from "@/components/ui/tooltip";
import { batchPreloadIdentifiers, invalidateCachedRecord } from "@/lib/metadata-hover";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TXID = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

function recordWith(inputString: string): DbRecord {
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

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function hasIndicator(trigger: HTMLElement): boolean {
  return trigger.querySelector("svg.lucide-file-text") !== null;
}

beforeEach(() => {
  getRecordsByInputString.mockReset();
  getRecordsByInputStrings.mockReset();
  invalidateCachedRecord(ADDRESS);
  invalidateCachedRecord(TXID);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddressLink no-hover indicator via external preload", () => {
  const triggerId = `link-address-${ADDRESS.slice(0, 8)}`;

  it("shows the FileText icon after a preload resolves, with no hover", async () => {
    getRecordsByInputStrings.mockResolvedValue([recordWith(ADDRESS)]);

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);

    // Mounts with no cached entry -> no indicator yet.
    expect(hasIndicator(trigger)).toBe(false);

    // The page (not a hover) warms the cache for the visible rows.
    await act(async () => {
      batchPreloadIdentifiers([ADDRESS]);
      await Promise.resolve();
    });

    await waitFor(() => expect(hasIndicator(trigger)).toBe(true));
    // The hover query path was never exercised.
    expect(getRecordsByInputString).not.toHaveBeenCalled();
  });

  it("stays icon-less when the preload finds a record with no metadata", async () => {
    getRecordsByInputStrings.mockResolvedValue([]); // no matching record

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    await act(async () => {
      batchPreloadIdentifiers([ADDRESS]);
      await Promise.resolve();
    });

    // Resolved to null -> indicator must remain hidden.
    await waitFor(() => expect(getRecordsByInputStrings).toHaveBeenCalled());
    expect(hasIndicator(trigger)).toBe(false);
  });
});

describe("TxidLink no-hover indicator via external preload", () => {
  const triggerId = `link-txid-${TXID.slice(0, 8)}`;

  it("shows the FileText icon after a preload resolves, with no hover", async () => {
    getRecordsByInputStrings.mockResolvedValue([recordWith(TXID)]);

    renderWithProvider(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    await act(async () => {
      batchPreloadIdentifiers([TXID]);
      await Promise.resolve();
    });

    await waitFor(() => expect(hasIndicator(trigger)).toBe(true));
    expect(getRecordsByInputString).not.toHaveBeenCalled();
  });
});
