// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { renderSourceNote } from "@/lib/renderSourceNote";

// These tests mirror the exact JSX VaultManagement.tsx uses to display notes:
//  - Per-cosigner notes are rendered as `<p>{renderSourceNote(cosigner.notes)}</p>`
//    (see VaultManagement.tsx cosigner notes block).
//  - Vault-level notes are rendered as a clickable `<p onClick={edit}>` wrapping a
//    `<span onClick={stopPropagation}>{renderSourceNote(vault.userNotes)}</span>`
//    so clicking a link inside the note does NOT enter note edit mode.
// Mounting the full page requires the engine client + IndexedDB, so we replicate
// the surrounding structure faithfully and exercise renderSourceNote within it.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Faithful replica of VaultManagement's vault-notes display markup. */
function VaultNotesDisplay({
  userNotes,
  onEdit,
}: {
  userNotes: string;
  onEdit: () => void;
}) {
  return (
    <p
      className="text-sm whitespace-pre-wrap cursor-pointer hover-elevate rounded p-1 -mx-1"
      onClick={onEdit}
      data-testid="text-vault-notes-0"
    >
      <span onClick={(e) => e.stopPropagation()}>
        {renderSourceNote(userNotes)}
      </span>
    </p>
  );
}

/** Faithful replica of VaultManagement's cosigner-notes display markup. */
function CosignerNotesDisplay({ notes }: { notes: string }) {
  return (
    <p
      className="text-xs text-muted-foreground whitespace-pre-wrap"
      data-testid="text-cosigner-notes-0-0"
    >
      {renderSourceNote(notes)}
    </p>
  );
}

describe("VaultManagement notes link rendering", () => {
  it("renders a URL in vault-level notes as a clickable anchor", () => {
    const { getByTestId } = render(
      <VaultNotesDisplay
        userNotes="Cold storage backup at https://example.com/vault docs"
        onEdit={() => {}}
      />,
    );
    const notes = getByTestId("text-vault-notes-0");
    const link = notes.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://example.com/vault");
    expect(notes.textContent).toBe(
      "Cold storage backup at https://example.com/vault docs",
    );
  });

  it("renders a URL in a per-cosigner note as a clickable anchor", () => {
    const { getByTestId } = render(
      <CosignerNotesDisplay notes="Key held by https://cosigner.example.org/profile" />,
    );
    const notes = getByTestId("text-cosigner-notes-0-0");
    const link = notes.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(
      "https://cosigner.example.org/profile",
    );
    expect(link.textContent).toBe("https://cosigner.example.org/profile");
  });

  it("opens vault-note links via window.open without fetching at render", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const { getByTestId } = render(
      <VaultNotesDisplay
        userNotes="ref https://example.com"
        onEdit={() => {}}
      />,
    );
    // Render alone must never fetch or open anything.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    const link = getByTestId("text-vault-notes-0").querySelector(
      "a",
    ) as HTMLAnchorElement;
    fireEvent.click(link);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not enter note edit mode when a link inside vault notes is clicked (stopPropagation)", () => {
    const onEdit = vi.fn();
    vi.spyOn(window, "open").mockReturnValue(null);

    const { getByTestId } = render(
      <VaultNotesDisplay
        userNotes="See https://example.com for the recovery steps"
        onEdit={onEdit}
      />,
    );

    const link = getByTestId("text-vault-notes-0").querySelector(
      "a",
    ) as HTMLAnchorElement;
    fireEvent.click(link);

    // The click is stopped by the wrapping span, so edit mode is never triggered.
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("still enters edit mode when the surrounding note text (not a link) is clicked", () => {
    const onEdit = vi.fn();

    const { getByTestId } = render(
      <VaultNotesDisplay
        userNotes="See https://example.com for the recovery steps"
        onEdit={onEdit}
      />,
    );

    // Clicking the paragraph itself (outside the stopPropagation span path)
    // should still trigger edit mode.
    fireEvent.click(getByTestId("text-vault-notes-0"));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
