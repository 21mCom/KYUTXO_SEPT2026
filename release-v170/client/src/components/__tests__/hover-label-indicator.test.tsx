// @vitest-environment jsdom
//
// The hover tooltip gained a "Label" row, and as a side-effect a record whose
// ONLY metadata is a real (non-blank, non "Unlabeled") label now counts as
// having metadata -> it must flag the orange FileText indicator and surface the
// label at the top of the tooltip. This is a new branch that could regress
// silently, so this suite renders the real AddressLink / TxidLink and asserts:
//   - a label-only record shows the indicator AND the label (text-hover-label)
//   - turning the "Label" hover toggle OFF hides both
// We stub the IndexedDB-backed CRUD + RecordPreview context (pulled in at import
// time) and control the hover prefs via a mocked useSettings so the toggle can
// be flipped per render.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import type { Record as DbRecord } from "@/lib/database";
import {
  DEFAULT_HOVER_TOOLTIP_PREFS,
  type HoverTooltipPrefs,
} from "@/lib/metadata-hover";

// resolveIdentifier() (real module) fans out to getRecordsByInputString; return
// a single label-only record so the tooltip resolves to it.
const { getRecordsByInputString } = vi.hoisted(() => ({
  getRecordsByInputString: vi.fn(),
}));
vi.mock("@/lib/data/record-crud", () => ({ getRecordsByInputString }));

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

// Control the hover prefs (the "Label" toggle lives here) per render.
const { hoverPrefsRef } = vi.hoisted(() => ({
  hoverPrefsRef: { current: null as HoverTooltipPrefs | null },
}));
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ hoverTooltipPrefs: hoverPrefsRef.current }),
}));

import { AddressLink } from "../AddressLink";
import { TxidLink } from "../TxidLink";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveIdentifier, invalidateCachedRecord } from "@/lib/metadata-hover";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TXID = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

function labelOnlyRecord(inputString: string): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "Cold Storage",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
  } as DbRecord;
}

function noMetaRecord(inputString: string): DbRecord {
  return {
    id: 1,
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: "Unlabeled",
    tags: [],
    categories: [],
    createdAt: 0,
    updatedAt: 0,
  } as DbRecord;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function hasIndicator(trigger: HTMLElement): boolean {
  return trigger.querySelector("svg.lucide-file-text") !== null;
}

beforeEach(() => {
  hoverPrefsRef.current = { ...DEFAULT_HOVER_TOOLTIP_PREFS };
  getRecordsByInputString.mockReset();
  invalidateCachedRecord(ADDRESS);
  invalidateCachedRecord(TXID);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddressLink label-only hover indicator", () => {
  const triggerId = `link-address-${ADDRESS.slice(0, 8)}`;

  it("shows the metadata indicator and the label when the Label toggle is on", async () => {
    getRecordsByInputString.mockResolvedValue([labelOnlyRecord(ADDRESS)]);
    // Pre-resolve so the component seeds tooltipRecord from the cache at mount,
    // making the indicator visible without waiting on an async hover resolve.
    await resolveIdentifier(ADDRESS);

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(true);

    // Open the tooltip so its body (the label row) mounts.
    fireEvent.focus(trigger);
    await flush();

    const labels = await screen.findAllByTestId("text-hover-label");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0].textContent).toContain("Cold Storage");
  });

  it("hides the indicator and the label when the Label toggle is off", async () => {
    hoverPrefsRef.current = { ...DEFAULT_HOVER_TOOLTIP_PREFS, showLabel: false };
    getRecordsByInputString.mockResolvedValue([labelOnlyRecord(ADDRESS)]);
    await resolveIdentifier(ADDRESS);

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    fireEvent.focus(trigger);
    await flush();

    expect(screen.queryAllByTestId("text-hover-label")).toHaveLength(0);
  });
});

describe("TxidLink label-only hover indicator", () => {
  const triggerId = `link-txid-${TXID.slice(0, 8)}`;

  it("shows the metadata indicator and the label when the Label toggle is on", async () => {
    getRecordsByInputString.mockResolvedValue([labelOnlyRecord(TXID)]);
    await resolveIdentifier(TXID);

    renderWithProvider(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(true);

    fireEvent.focus(trigger);
    await flush();

    const labels = await screen.findAllByTestId("text-hover-label");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0].textContent).toContain("Cold Storage");
  });

  it("hides the indicator and the label when the Label toggle is off", async () => {
    hoverPrefsRef.current = { ...DEFAULT_HOVER_TOOLTIP_PREFS, showLabel: false };
    getRecordsByInputString.mockResolvedValue([labelOnlyRecord(TXID)]);
    await resolveIdentifier(TXID);

    renderWithProvider(<TxidLink txid={TXID} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    fireEvent.focus(trigger);
    await flush();

    expect(screen.queryAllByTestId("text-hover-label")).toHaveLength(0);
  });
});

// Live-update behaviour: when a record is edited or deleted the CRUD layer calls
// invalidateCachedRecord(identifier). A visible AddressLink/TxidLink is
// subscribed to that identifier, so the invalidation must re-resolve and flip
// the orange FileText indicator without waiting for a hover or the cache TTL.
describe("AddressLink live indicator refresh on invalidate", () => {
  const triggerId = `link-address-${ADDRESS.slice(0, 8)}`;

  it("shows the indicator after a record gains metadata (edit)", async () => {
    // Initially the address resolves to a record with no metadata -> no icon.
    getRecordsByInputString.mockResolvedValue([noMetaRecord(ADDRESS)]);
    await resolveIdentifier(ADDRESS);

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(false);

    // Simulate an edit that adds a label, then the CRUD-layer invalidation.
    getRecordsByInputString.mockResolvedValue([labelOnlyRecord(ADDRESS)]);
    await act(async () => {
      invalidateCachedRecord(ADDRESS);
      await flush();
    });

    await waitFor(() => expect(hasIndicator(trigger)).toBe(true));
  });

  it("clears the indicator after the record is deleted", async () => {
    // Initially the address resolves to a label-only record -> icon shown.
    getRecordsByInputString.mockResolvedValue([labelOnlyRecord(ADDRESS)]);
    await resolveIdentifier(ADDRESS);

    renderWithProvider(<AddressLink address={ADDRESS} />);
    const trigger = screen.getByTestId(triggerId);
    expect(hasIndicator(trigger)).toBe(true);

    // Simulate a delete: the address now resolves to nothing.
    getRecordsByInputString.mockResolvedValue([]);
    await act(async () => {
      invalidateCachedRecord(ADDRESS);
      await flush();
    });

    await waitFor(() => expect(hasIndicator(trigger)).toBe(false));
  });
});
