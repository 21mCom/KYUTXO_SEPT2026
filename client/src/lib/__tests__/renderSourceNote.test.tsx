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
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { renderSourceNote } from "../renderSourceNote";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

describe("renderSourceNote never linkifies dangerous URI schemes", () => {
  // A free-text note is untrusted user input. Only http(s) URLs should ever
  // become clickable links; any other scheme — most importantly the
  // script-executing/exfiltration vectors below — must render as inert plain
  // text. These tests pin that down so a regression that loosens the URL regex
  // can't silently turn a malicious note into a script-running link.
  const dangerousNotes: ReadonlyArray<readonly [string, string]> = [
    ["javascript: (script execution)", "Click javascript:alert(1) now"],
    [
      "JavaScript: (mixed case bypass attempt)",
      "Click JavaScript:alert(1) now",
    ],
    [
      "data: (inline HTML/script payload)",
      "Open data:text/html,<script>alert(1)</script> here",
    ],
    ["file: (local file access)", "See file:///etc/passwd for details"],
    ["vbscript: (legacy script execution)", "Run vbscript:msgbox(1) here"],
    [
      "javascript: wrapped in a real sentence",
      'He wrote "javascript:alert(document.cookie)" in the note.',
    ],
  ];

  it.each(dangerousNotes)(
    "renders a %s URI as plain text with no link",
    (_label, note) => {
      render(<div data-testid="note">{renderSourceNote(note)}</div>);

      const container = screen.getByTestId("note");
      // No anchor is produced for the dangerous scheme.
      expect(within(container).queryByRole("link")).toBeNull();
      // The note text is preserved verbatim (rendered inert as plain text).
      expect(container.textContent).toBe(note);
    },
  );

  it("only linkifies the http(s) URL, leaving an adjacent javascript: URI as plain text", () => {
    const note =
      "Safe https://example.com/x but danger javascript:alert(1) here";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");

    // Exactly one link — the http(s) URL — and never the javascript: URI.
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://example.com/x");
    // The javascript: URI survives only as inert plain text inside the note.
    expect(container.textContent).toBe(note);
  });

  it("linkifies both http:// and https:// schemes", () => {
    const note = "Plain http://example.com/a and secure https://example.com/b";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const links = within(container).getAllByRole("link");

    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("http://example.com/a");
    expect(links[1].getAttribute("href")).toBe("https://example.com/b");
  });

  it("never produces an href that begins with javascript:, data:, file:, or vbscript:", () => {
    const note =
      "javascript:alert(1) data:text/html,x file:///etc/passwd vbscript:x and https://example.com/ok";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    // The only link is the http(s) one; assert no link carries a dangerous scheme.
    for (const link of within(container).queryAllByRole("link")) {
      const href = (link.getAttribute("href") ?? "").toLowerCase();
      expect(href.startsWith("javascript:")).toBe(false);
      expect(href.startsWith("data:")).toBe(false);
      expect(href.startsWith("file:")).toBe(false);
      expect(href.startsWith("vbscript:")).toBe(false);
      expect(/^https?:\/\//.test(href)).toBe(true);
    }
  });
});

describe("renderSourceNote offline-first guarantees", () => {
  it("performs zero network requests when rendering a note containing URLs", () => {
    // Stub every render-time network entry point. If a regression ever pre-fetches
    // a URL (fetch), kicks off an XHR, opens a WebSocket/EventSource, or pre-renders
    // an <img>/preload that loads the URL, one of these spies will catch it.
    const fetchSpy = vi.fn(() => Promise.resolve(new Response("")));
    vi.stubGlobal("fetch", fetchSpy);

    const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, "open");
    const xhrSendSpy = vi.spyOn(XMLHttpRequest.prototype, "send");

    const sendBeaconSpy = vi.fn(() => true);
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      sendBeacon: sendBeaconSpy,
    });

    // Spy on <img>.src assignments — setting src is what triggers an image fetch.
    const imgSrcSpy = vi.fn();
    const imgSrcDescriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "src",
    );
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      set(value: string) {
        imgSrcSpy(value);
      },
      get() {
        return "";
      },
    });

    try {
      const note =
        "Source one https://example.com/a and source two https://example.com/b too.";
      render(<div data-testid="note">{renderSourceNote(note)}</div>);

      // Sanity check: the links did render (so we know rendering actually ran).
      const container = screen.getByTestId("note");
      expect(within(container).getAllByRole("link")).toHaveLength(2);

      // The core assertion: rendering performed no network activity whatsoever.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrOpenSpy).not.toHaveBeenCalled();
      expect(xhrSendSpy).not.toHaveBeenCalled();
      expect(sendBeaconSpy).not.toHaveBeenCalled();
      expect(imgSrcSpy).not.toHaveBeenCalled();
    } finally {
      if (imgSrcDescriptor) {
        Object.defineProperty(
          HTMLImageElement.prototype,
          "src",
          imgSrcDescriptor,
        );
      }
    }
  });

  it("does not open the URL at render time (window.open only fires on click)", () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    const note = "Check https://example.com/x for the details.";
    render(<div data-testid="note">{renderSourceNote(note)}</div>);

    const container = screen.getByTestId("note");
    const link = within(container).getByRole("link");

    // Nothing should have been opened just by rendering the link.
    expect(openSpy).not.toHaveBeenCalled();

    // Only an explicit user click opens the URL externally.
    link.click();
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/x",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
