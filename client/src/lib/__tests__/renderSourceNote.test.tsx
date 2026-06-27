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

  it("marks the link with break-all so very long unbroken URLs wrap instead of overflowing", () => {
    const longUrl =
      "https://example.com/" + "a".repeat(400) + "/some-resource";
    render(<div data-testid="note">{renderSourceNote(`See ${longUrl} here`)}</div>);

    const container = screen.getByTestId("note");
    const link = within(container).getByRole("link");
    expect(link.getAttribute("href")).toBe(longUrl);
    // Every surface that renders renderSourceNote output relies on this class to
    // keep long URLs contained; assert it directly on the shared helper.
    expect(link.classList.contains("break-all")).toBe(true);
  });

  it("keeps a closing paren and trailing period out of the href when a URL ends a sentence inside parentheses", () => {
    const note = "Source: (see https://example.com/x).";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // The closing paren and trailing period are excluded from the link target.
    expect(links[0].getAttribute("href")).toBe("https://example.com/x");
    // The visible link text matches the href exactly (no stray ")" or ".").
    expect(links[0].textContent).toBe("https://example.com/x");
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

    // The ")" and "." are still present in the note as visible plain text.
    expect(container.textContent).toBe(note);
  });

  it("stops the href at the closing paren even when followed by other bracket/quote characters", () => {
    const note = 'He noted (https://example.com/path)" in the file.';
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // The link is cut at the closing paren; the trailing ")" and quote stay text.
    expect(links[0].getAttribute("href")).toBe("https://example.com/path");
    // The visible link text matches the href exactly.
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

    expect(container.textContent).toBe(note);
  });

  it("keeps a trailing double-quote out of the href when a URL is wrapped in quotes", () => {
    const note = 'See "https://example.com/x" for details.';
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // The trailing double-quote is excluded from the link target.
    expect(links[0].getAttribute("href")).toBe("https://example.com/x");
    // The visible link text matches the href exactly (no stray quote).
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

    // The wrapping quotes are still present as visible plain text.
    expect(container.textContent).toBe(note);
  });

  it("keeps a trailing square bracket out of the href when a URL is wrapped in brackets", () => {
    const note = "See [https://example.com/x] for details.";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // The trailing "]" is excluded from the link target.
    expect(links[0].getAttribute("href")).toBe("https://example.com/x");
    // The visible link text matches the href exactly (no stray "]").
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

    // The wrapping brackets are still present as visible plain text.
    expect(container.textContent).toBe(note);
  });

  it("keeps a trailing angle bracket out of the href when a URL is wrapped in angle brackets", () => {
    const note = "See <https://example.com/x> for details.";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // The trailing ">" is excluded from the link target.
    expect(links[0].getAttribute("href")).toBe("https://example.com/x");
    // The visible link text matches the href exactly (no stray ">").
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

    // The wrapping angle brackets are still present as visible plain text.
    expect(container.textContent).toBe(note);
  });

  it("keeps a trailing single-quote out of the href when a URL is wrapped in single quotes", () => {
    const note = "See 'https://example.com/x' for details.";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // The trailing single-quote is excluded from the link target.
    expect(links[0].getAttribute("href")).toBe("https://example.com/x");
    // The visible link text matches the href exactly (no stray quote).
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

    // The wrapping single quotes are still present as visible plain text.
    expect(container.textContent).toBe(note);
  });

  it("keeps a valid IPv6-literal URL's closing bracket inside the href", () => {
    const note = "Local node at http://[::1] is reachable.";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // The IPv6 host literal's closing "]" is part of the URL and must stay.
    expect(links[0].getAttribute("href")).toBe("http://[::1]");
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

    expect(container.textContent).toBe(note);
  });

  it("strips only the wrapping bracket around a bracketed IPv6-literal URL", () => {
    const note = "Local node at [http://[::1]] is reachable.";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");
    expect(links).toHaveLength(1);

    // Only the unbalanced wrapping "]" is removed; the IPv6 "]" stays.
    expect(links[0].getAttribute("href")).toBe("http://[::1]");
    expect(links[0].textContent).toBe(links[0].getAttribute("href"));

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
