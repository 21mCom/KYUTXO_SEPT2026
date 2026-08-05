// @vitest-environment jsdom
//
// Verifies that the record detail panel renders http(s) URLs found in a
// record's free-text notes as click-only links via the shared renderSourceNote
// util. Upholds the offline-first guarantee: a URL is only ever opened on an
// explicit user click (window.open) and is NEVER fetched merely by rendering.
// Plain text notes (no URL) render without a link.
//
// We render the real RecordDetailPanel but stub the data-fetching chain
// (dataFacade lookups, toast, QR code generation) so the test exercises only
// the notes link rendering.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

vi.mock("@/lib/dataFacade", () => ({
  getRecordOrigins: vi.fn(async () => []),
  getParticipantsByAddress: vi.fn(async () => []),
  getParticipantsByTxid: vi.fn(async () => []),
  getTransactionByTxid: vi.fn(async () => null),
  getTransactionsByTxids: vi.fn(async () => []),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,stub") },
}));

const { RecordDetailPanel } = await import("./RecordDetailPanel");

const NOTE_URL = "https://en.bitcoin.it/wiki/Address_reuse";

// Unrelated app-level background fetches (e.g. the Tor proxy settings-token
// sync triggered via use-node-settings) can legitimately fire during mount.
// The offline-first guarantee we protect is narrower: the notes URL itself
// must never be fetched. So we assert no fetch call ever targeted the notes
// URL, rather than asserting fetch was never called at all.
function fetchCallsWithNotesUrl(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([input]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as Request | undefined)?.url ?? String(input));
    return url.includes(NOTE_URL);
  });
}

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    type: "address" as const,
    inputString: "bc1qexampleaddress",
    label: "Test Address",
    tags: [],
    categories: [],
    ...overrides,
  };
}

function renderPanel(record: ReturnType<typeof baseRecord>) {
  return renderWithProviders(
    <RecordDetailPanel open={true} onClose={() => {}} record={record} />,
  );
}

describe("RecordDetailPanel notes link rendering (offline-first)", () => {
  let openSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchSpy = vi.fn().mockRejectedValue(new Error("network access is forbidden"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a URL in the notes as a click-only link and never fetches on load", () => {
    const { getByTestId } = renderPanel(
      baseRecord({ notes: `See more at ${NOTE_URL} now.` }),
    );

    const notes = getByTestId("text-notes-detail");
    const link = within(notes).getByRole("link");
    expect(link.getAttribute("href")).toBe(NOTE_URL);
    expect(link.textContent).toBe(NOTE_URL);

    // Offline-first: nothing is fetched merely by rendering the notes.
    expect(fetchCallsWithNotesUrl(fetchSpy)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens the notes link via window.open only on click (preventing navigation)", () => {
    const { getByTestId } = renderPanel(baseRecord({ notes: NOTE_URL }));

    const notes = getByTestId("text-notes-detail");
    const link = within(notes).getByRole("link", { name: NOTE_URL });

    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchCallsWithNotesUrl(fetchSpy)).toEqual([]);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, clickEvent);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(NOTE_URL, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    // Opening is delegated to the browser, never fetched in-app.
    expect(fetchCallsWithNotesUrl(fetchSpy)).toEqual([]);
  });

  it("renders plain notes text (no URL) without any link", () => {
    const { getByTestId } = renderPanel(
      baseRecord({ notes: "Just a plain note with no links." }),
    );

    const notes = getByTestId("text-notes-detail");
    expect(within(notes).queryByRole("link")).toBeNull();
    expect(notes.textContent).toContain("Just a plain note with no links.");

    expect(fetchCallsWithNotesUrl(fetchSpy)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
