// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { retryableLazy } from "./App";

describe("retryableLazy", () => {
  it("shows a readable error and loads the page after a successful retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const LoadedPage = () => <div>Recovered page content</div>;
    const importer = vi
      .fn<() => Promise<{ default: typeof LoadedPage }>>()
      .mockRejectedValueOnce(new Error("chunk download failed"))
      .mockResolvedValue({ default: LoadedPage });
    const RetryablePage = retryableLazy(importer);

    render(
      <Suspense fallback={<div>Loading page…</div>}>
        <RetryablePage />
      </Suspense>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This page couldn't be loaded",
    );
    expect(importer).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered page content")).toBeTruthy();
    expect(importer.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});