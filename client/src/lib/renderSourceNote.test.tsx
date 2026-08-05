// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { renderSourceNote } from "./renderSourceNote";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("renderSourceNote (shared util)", () => {
  it("returns plain text unchanged when there is no URL", () => {
    const { container, queryByRole } = render(
      <>{renderSourceNote("Just a plain citation note with no links.")}</>,
    );
    expect(queryByRole("link")).toBeNull();
    expect(container.textContent).toBe("Just a plain citation note with no links.");
  });

  it("turns a single URL into a clickable link with the correct href", () => {
    const { getByRole, container } = render(
      <>{renderSourceNote("See https://example.com for details")}</>,
    );
    const link = getByRole("link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.textContent).toBe("https://example.com");
    expect(container.textContent).toBe("See https://example.com for details");
  });

  it("renders multiple URLs in one note as separate links", () => {
    const { getAllByRole } = render(
      <>
        {renderSourceNote(
          "Sources: https://a.example.com and also http://b.example.com here",
        )}
      </>,
    );
    const links = getAllByRole("link") as HTMLAnchorElement[];
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("https://a.example.com");
    expect(links[1].getAttribute("href")).toBe("http://b.example.com");
  });

  it("keeps trailing punctuation out of the link target but renders it as text", () => {
    const { getByRole, container } = render(
      <>{renderSourceNote("see https://example.com.")}</>,
    );
    const link = getByRole("link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(container.textContent).toBe("see https://example.com.");
  });

  it("opens links via window.open on click and prevents default navigation", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { getByRole } = render(
      <>{renderSourceNote("ref https://example.com")}</>,
    );
    const link = getByRole("link") as HTMLAnchorElement;

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const prevented = !link.dispatchEvent(clickEvent);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
    expect(prevented).toBe(true);
  });

  it("does not perform any network request at render time", () => {
    // Strict no-fetch assertion is safe here: this test renders only the pure
    // renderSourceNote output with no app providers or hooks mounted, so no
    // unrelated background fetch (e.g. settings-token sync) can ever fire.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(
      <>
        {renderSourceNote(
          "Multiple https://a.example.com and https://b.example.com refs.",
        )}
      </>,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
