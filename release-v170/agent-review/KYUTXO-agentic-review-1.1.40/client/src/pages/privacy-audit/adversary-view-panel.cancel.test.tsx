// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import { renderWithProviders } from "@/test/testProviders";
import { AdversaryViewPanel } from "./adversary-view-panel";

describe("AdversaryViewPanel cancel control", () => {
  it("shows a Cancel button while running and calls onCancel when clicked", () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <AdversaryViewPanel
        running={true}
        statusMessage="Analyzing wallets…"
        result={null}
        cancelled={false}
        onCancel={onCancel}
      />,
    );

    const cancelButton = screen.getByTestId("button-cancel-adversary-view");
    expect(cancelButton).toBeTruthy();
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a cancelled note instead of disappearing after cancellation", () => {
    renderWithProviders(
      <AdversaryViewPanel
        running={false}
        statusMessage=""
        result={null}
        cancelled={true}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByTestId("container-adversary-view")).toBeTruthy();
    expect(screen.getByTestId("text-adversary-cancelled")).toBeTruthy();
    expect(screen.queryByTestId("button-cancel-adversary-view")).toBeNull();
  });

  it("renders nothing when not running, no result, and not cancelled", () => {
    renderWithProviders(
      <AdversaryViewPanel
        running={false}
        statusMessage=""
        result={null}
        cancelled={false}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByTestId("container-adversary-view")).toBeNull();
  });
});
