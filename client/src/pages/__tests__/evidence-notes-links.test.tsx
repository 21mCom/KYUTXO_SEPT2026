// @vitest-environment jsdom
//
// Verifies that evidence notes on the Evidence page render http(s) URLs as
// clickable links (via the shared renderSourceNote util) and uphold the
// offline-first guarantee: a URL is only ever opened on an explicit user
// click (window.open) and is NEVER fetched at load time. Notes without a URL
// must still render as plain text. The Evidence page renders notes through
// renderSourceNote in three places (grid/list cards, the detail dialog, and
// the quick-view preview dialog); this covers the grid surface and the
// preview dialog surface, both fed by the same shared util.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// Reimplement Dexie's live query hook with a plain promise-resolving effect so
// the page renders our fixture evidence without ever touching IndexedDB. This
// mirrors useLiveQuery's contract: returns undefined first, then the resolved
// value once the (async) querier settles.
vi.mock("dexie-react-hooks", () => {
  const React = require("react");
  return {
    useLiveQuery: (querier: () => unknown, deps?: unknown[]) => {
      const [result, setResult] = React.useState<unknown>(undefined);
      React.useEffect(() => {
        let active = true;
        Promise.resolve(querier()).then((r) => {
          if (active) setResult(r);
        });
        return () => {
          active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps ?? []);
      return result;
    },
  };
});

// The page's data layer must never hit IndexedDB or the network during the
// test. getAllEvidence feeds the list; everything else is only used by
// handlers and resolves to neutral values.
const getAllEvidenceMock = vi.fn();
vi.mock("@/lib/dataFacade", () => ({
  addEvidence: vi.fn().mockResolvedValue(1),
  updateEvidence: vi.fn().mockResolvedValue(undefined),
  deleteEvidence: vi.fn().mockResolvedValue(undefined),
  getEvidenceAttachments: vi.fn().mockResolvedValue([]),
  addEvidenceAttachment: vi.fn().mockResolvedValue(1),
  deleteEvidenceAttachment: vi.fn().mockResolvedValue(undefined),
  getAllEvidence: () => getAllEvidenceMock(),
  countEvidenceAttachmentsByEvidenceId: vi.fn().mockResolvedValue(0),
}));

// Attachment helpers touch the local filesystem / Electron bridge; stub them.
vi.mock("@/lib/attachments", () => ({
  uploadFile: vi.fn().mockResolvedValue(undefined),
  downloadFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  getFileBlob: vi.fn().mockResolvedValue(null),
  isPreviewableType: vi.fn().mockReturnValue(false),
  getPreviewType: vi.fn().mockReturnValue(null),
}));

// react-dropzone wires up DOM listeners we don't need here.
vi.mock("react-dropzone", () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
  }),
}));

import EvidencePage from "@/pages/Evidence";

type EvidenceFixture = {
  id: number;
  title: string;
  documentType: string;
  notes?: string;
  createdAt: number;
};

function makeEvidence(overrides: Partial<EvidenceFixture> = {}): EvidenceFixture {
  return {
    id: 1,
    title: "Proof of Ownership",
    documentType: "other",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function renderEvidence(list: EvidenceFixture[]) {
  getAllEvidenceMock.mockResolvedValue(list);
  const utils = renderWithProviders(<EvidencePage />);
  // Wait for the live query to resolve and the cards to render.
  await waitFor(() => {
    for (const ev of list) {
      expect(screen.getByTestId(`card-evidence-${ev.id}`)).toBeTruthy();
    }
  });
  return utils;
}

describe("evidence notes link rendering (offline-first)", () => {
  let openSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error("network access is forbidden"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a URL in an evidence note as a clickable link and never fetches it on load", async () => {
    const url = "https://mempool.space/tx/abc123";
    await renderEvidence([
      makeEvidence({ id: 1, notes: `See ${url} for details.` }),
    ]);

    const card = screen.getByTestId("card-evidence-1");
    const link = within(card).getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe(url);

    // Offline-first: nothing is fetched merely by rendering the note.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens the evidence note link via window.open only on click (preventing navigation)", async () => {
    const url = "https://example.com/proof";
    await renderEvidence([makeEvidence({ id: 1, notes: url })]);

    const link = within(screen.getByTestId("card-evidence-1")).getByRole("link");

    // No open and no fetch before the user interacts.
    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link, clickEvent);

    // window.open is called with the URL; default navigation is prevented.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(clickEvent.defaultPrevented).toBe(true);
    // Still no fetch — opening is delegated to the browser, not fetched in-app.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders an evidence note without a URL as plain text (no link)", async () => {
    const plain = "Just a regular note with no links.";
    await renderEvidence([makeEvidence({ id: 1, notes: plain })]);

    const card = screen.getByTestId("card-evidence-1");
    expect(card.textContent).toContain(plain);
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("wraps a very long unbroken URL (break-all) so it can't break the evidence layout", async () => {
    const longUrl =
      "https://example.com/" + "a".repeat(400) + "/evidence-record";
    await renderEvidence([
      makeEvidence({ id: 1, notes: `Stored at ${longUrl} now` }),
    ]);

    const card = screen.getByTestId("card-evidence-1");
    const link = within(card).getByRole("link");
    expect(link.getAttribute("href")).toBe(longUrl);
    // The anchor must carry break-all so the unbroken URL wraps instead of
    // overflowing the evidence card.
    expect(link.classList.contains("break-all")).toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the note URL as a link in the quick-view preview dialog too", async () => {
    const url = "https://blockstream.info/tx/def456";
    await renderEvidence([makeEvidence({ id: 1, notes: url })]);

    // Clicking the card opens the quick-view preview dialog (no previewable
    // attachment), which renders the note through the same shared util.
    fireEvent.click(screen.getByTestId("card-evidence-1"));

    const dialog = await screen.findByRole("dialog");
    const link = within(dialog).getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe(url);

    // Rendering the preview surface still performs no network fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
