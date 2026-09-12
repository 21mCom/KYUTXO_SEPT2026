// @vitest-environment jsdom
//
// Verifies that evidence (proof-of-ownership) notes wire the shared
// renderSourceNote util through their display surfaces and uphold the
// offline-first guarantee: http(s) URLs render as clickable anchors that are
// only ever opened on an explicit user click (window.open) and are NEVER
// fetched at load time. Notes without a URL must still render as plain text.
//
// Mounting the full Evidence page requires the engine client + IndexedDB, so —
// following the VaultManagement.notes.test.tsx pattern — we faithfully replicate
// the exact JSX Evidence.tsx uses to display notes:
//  - Card list:      `<p>{renderSourceNote(evidence.notes)}</p>`
//  - Detail dialog:  `<p>{renderSourceNote(selectedEvidence.notes)}</p>`
//  - Preview dialog: `<p>{renderSourceNote(previewEvidence.notes)}</p>`
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { renderSourceNote } from "@/lib/renderSourceNote";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Faithful replica of Evidence.tsx's card-list notes markup. */
function CardListNotes({ notes }: { notes: string }) {
  return (
    <p
      className="text-sm text-muted-foreground line-clamp-2 mb-2"
      data-testid="text-evidence-card-notes"
    >
      {renderSourceNote(notes)}
    </p>
  );
}

/** Faithful replica of Evidence.tsx's detail-dialog notes markup. */
function DetailDialogNotes({ notes }: { notes: string }) {
  return (
    <p className="whitespace-pre-wrap" data-testid="text-evidence-detail-notes">
      {renderSourceNote(notes)}
    </p>
  );
}

/** Faithful replica of Evidence.tsx's preview-dialog notes markup. */
function PreviewDialogNotes({ notes }: { notes: string }) {
  return (
    <p
      className="text-sm whitespace-pre-wrap"
      data-testid="text-evidence-preview-notes"
    >
      {renderSourceNote(notes)}
    </p>
  );
}

describe("Evidence notes link rendering (offline-first)", () => {
  it("renders a URL in card-list notes as a clickable anchor with the correct href", () => {
    const { getByTestId } = render(
      <CardListNotes notes="Deed scan archived at https://example.com/deed.pdf for reference" />,
    );
    const notes = getByTestId("text-evidence-card-notes");
    const link = notes.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://example.com/deed.pdf");
    expect(link.textContent).toBe("https://example.com/deed.pdf");
    expect(notes.textContent).toBe(
      "Deed scan archived at https://example.com/deed.pdf for reference",
    );
  });

  it("renders a URL in the detail dialog notes as a clickable anchor", () => {
    const { getByTestId } = render(
      <DetailDialogNotes notes="Original held by https://registry.example.org/title/42" />,
    );
    const notes = getByTestId("text-evidence-detail-notes");
    const link = notes.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(
      "https://registry.example.org/title/42",
    );
  });

  it("renders a URL in the preview dialog notes as a clickable anchor", () => {
    const { getByTestId } = render(
      <PreviewDialogNotes notes="See https://example.com/proof for provenance" />,
    );
    const notes = getByTestId("text-evidence-preview-notes");
    const link = notes.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://example.com/proof");
  });

  it("opens an evidence-note link via window.open without fetching at render", () => {
    // Strict no-fetch assertion is safe here: this test renders replica
    // markup fed by the pure renderSourceNote util, with no app providers
    // or hooks mounted, so no unrelated background fetch can ever fire.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const { getByTestId } = render(
      <DetailDialogNotes notes="ref https://example.com" />,
    );

    // Render alone must never fetch or open anything (offline-first).
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    const link = getByTestId("text-evidence-detail-notes").querySelector(
      "a",
    ) as HTMLAnchorElement;

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link, clickEvent);

    // The link opens externally via window.open; default navigation is prevented.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
    expect(clickEvent.defaultPrevented).toBe(true);
    // Still no fetch — opening is delegated to the browser, not fetched in-app.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders evidence notes without a URL as plain text (no link)", () => {
    const plain = "Notarized copy stored in the home safe.";
    const { getByTestId } = render(<CardListNotes notes={plain} />);
    const notes = getByTestId("text-evidence-card-notes");
    expect(notes.textContent).toBe(plain);
    expect(notes.querySelector("a")).toBeNull();
  });
});
