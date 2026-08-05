// @vitest-environment jsdom
//
// Verifies that record notes on the Records page render http(s) URLs as
// clickable links (via the shared renderSourceNote util) and uphold the
// offline-first guarantee: a URL is only ever opened on an explicit user
// click (window.open) and is NEVER fetched at load time. Notes without a URL
// must still render as plain text.
//
// The provider harness mounts RecordPreviewProvider, which queries Dexie at
// mount — jsdom has no IndexedDB, so the shim below is required or the
// db-error-noise guard fails the tests.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, fireEvent, cleanup, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { fetchCallsWithNoteUrl } from "@/test/noteFetchCalls";

// The detail panel's effects call into the data layer; stub it so rendering a
// record never touches IndexedDB or the network. Each function resolves to an
// empty/neutral value so no conflicts, history, or transaction lookups occur.
vi.mock("@/lib/dataFacade", () => ({
  getRecordOrigins: vi.fn().mockResolvedValue([]),
  getParticipantsByAddress: vi.fn().mockResolvedValue([]),
  getParticipantsByTxid: vi.fn().mockResolvedValue([]),
  getTransactionByTxid: vi.fn().mockResolvedValue(null),
  getTransactionsByTxids: vi.fn().mockResolvedValue([]),
}));

import { RecordDetailPanel } from "../RecordDetailPanel";

type PanelRecord = NonNullable<
  React.ComponentProps<typeof RecordDetailPanel>["record"]
>;

function baseRecord(overrides: Partial<PanelRecord> = {}): PanelRecord {
  return {
    id: "1",
    type: "other",
    inputString: "my-note-record",
    label: "Test Record",
    tags: [],
    categories: [],
    ...overrides,
  };
}

function renderPanel(record: PanelRecord) {
  return renderWithProviders(
    <RecordDetailPanel open={true} onClose={() => {}} record={record} />,
  );
}

describe("record notes link rendering (offline-first)", () => {
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

  it("renders a URL in the notes as a clickable link and never fetches it on load", () => {
    const url = "https://mempool.space/tx/abc123";
    renderPanel(baseRecord({ notes: `See ${url} for details.` }));

    const notes = screen.getByTestId("text-notes-detail");
    const link = within(notes).getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe(url);

    // Offline-first: the note URL is never fetched merely by rendering.
    // (Unrelated app-level background fetches may fire during mount, so we
    // assert on the note URL rather than on fetch never being called.)
    expect(fetchCallsWithNoteUrl(fetchSpy, url)).toEqual([]);
  });

  it("opens the link via window.open only on click (preventing navigation)", () => {
    const url = "https://example.com/proof";
    renderPanel(baseRecord({ notes: url }));

    const link = within(screen.getByTestId("text-notes-detail")).getByRole("link");

    // No open and no fetch before the user interacts.
    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchCallsWithNoteUrl(fetchSpy, url)).toEqual([]);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, clickEvent);

    // window.open is called with the URL; default navigation is prevented.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    // Still no fetch of the URL — opening is delegated to the browser.
    expect(fetchCallsWithNoteUrl(fetchSpy, url)).toEqual([]);
  });

  it("renders notes without a URL as plain text (no link)", () => {
    const plain = "Just a regular note with no links.";
    renderPanel(baseRecord({ notes: plain }));

    const notes = screen.getByTestId("text-notes-detail");
    expect(notes.textContent).toBe(plain);
    expect(within(notes).queryByRole("link")).toBeNull();
  });

  it("wraps a very long unbroken URL (break-all) so it can't break the record layout", () => {
    const longUrl =
      "https://example.com/" + "a".repeat(400) + "/proof-of-ownership";
    renderPanel(baseRecord({ notes: `Reference ${longUrl} attached` }));

    const notes = screen.getByTestId("text-notes-detail");
    const link = within(notes).getByRole("link");
    expect(link.getAttribute("href")).toBe(longUrl);
    // The anchor must carry break-all so the unbroken URL wraps instead of
    // overflowing the detail panel.
    expect(link.classList.contains("break-all")).toBe(true);

    expect(fetchCallsWithNoteUrl(fetchSpy, longUrl)).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
