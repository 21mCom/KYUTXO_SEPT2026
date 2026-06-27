// @vitest-environment jsdom
//
// Unit tests for the shared renderSourceNote util in isolation. Every notes
// surface in the app (record notes, Reports findings, evidence notes) relies on
// this one helper to turn http(s) URLs in free text into clickable links, so a
// regression here would silently break links everywhere at once. The page-level
// tests only exercise a single clean URL; these tests pin down the helper's own
// parsing rules: trailing punctuation is stripped out of the link target (but
// kept as visible text), and multiple URLs in one note each become their own
// correct link. Notes without a URL render as plain text.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { renderSourceNote } from "../renderSourceNote";

afterEach(() => {
  cleanup();
});

describe("renderSourceNote parsing rules", () => {
  it("strips trailing punctuation from hrefs while keeping multiple URLs as separate links", () => {
    const note = "Visit https://example.com/x. Then https://example.com/y, ok";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(2);

    // First URL: trailing period is not part of the href, but visible as text.
    expect(links[0].getAttribute("href")).toBe("https://example.com/x");
    expect(links[0].textContent).toBe("https://example.com/x");

    // Second URL: trailing comma is not part of the href, but visible as text.
    expect(links[1].getAttribute("href")).toBe("https://example.com/y");
    expect(links[1].textContent).toBe("https://example.com/y");

    // The full note text (including the stripped punctuation) is still present.
    expect(container.textContent).toBe(note);
  });

  it("renders a note with no URL as plain text (no link)", () => {
    const plain = "Just a regular note with no links.";
    render(<div data-testid="note">{renderSourceNote(plain)}</div>);

    const container = screen.getByTestId("note");
    expect(container.textContent).toBe(plain);
    expect(within(container).queryByRole("link")).toBeNull();
  });
});
