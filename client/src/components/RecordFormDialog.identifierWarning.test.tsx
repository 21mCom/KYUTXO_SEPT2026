// @vitest-environment jsdom
//
// Paste-mistake warnings in RecordFormDialog (Task #1861).
//
// Covered:
//   1. A 64-hex string (ambiguous with an x-only public key) shows a
//      non-blocking "will be saved as a transaction ID" warning.
//   2. A mixed-case bech32 address shows a non-blocking "will be saved in
//      lowercase" warning that names the canonical form.
//   3. A well-formed lowercase bech32 address shows NO warning.
//   4. Type "other" is explicitly free-form — no warning for 64-hex there.
//   5. The warning never blocks submission: the form still saves.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Radix primitives (Select, Dialog) reach for APIs jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;
Element.prototype.scrollIntoView = vi.fn();
(Element.prototype as any).hasPointerCapture = vi.fn();
(Element.prototype as any).releasePointerCapture = vi.fn();
(Element.prototype as any).setPointerCapture = vi.fn();

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({
    nodeSettings: { id: "default", providerType: "mempool-space" },
  }),
}));

import { RecordFormDialog } from "@/components/RecordFormDialog";

const HEX64 = "aB".repeat(32);
const MIXED_BECH32 = "bc1qW508D6qejXTDG4y5r3Zarvary0c5xw7KV8F3T4";
const MIXED_BECH32_CANONICAL = MIXED_BECH32.toLowerCase();
const LOWER_BECH32 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function renderDialog(onSave = vi.fn(async () => {})) {
  render(<RecordFormDialog open onClose={() => {}} onSave={onSave} />);
  return onSave;
}

function typeIdentifier(value: string) {
  fireEvent.change(screen.getByTestId("input-address"), { target: { value } });
}

async function switchTypeTo(label: RegExp) {
  fireEvent.click(screen.getByTestId("select-type"));
  const option = await screen.findByRole("option", { name: label });
  fireEvent.click(option);
}

describe("RecordFormDialog — identifier paste warnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("warns that a 64-hex string will be saved as a transaction ID", async () => {
    renderDialog();
    typeIdentifier(HEX64);

    const alert = await screen.findByTestId("alert-identifier-warning");
    expect(alert.textContent).toContain("saved as a transaction ID");
    expect(alert.textContent).toContain("x-only public key");
  });

  it("warns that mixed-case bech32 will be saved in lowercase, naming the canonical form", async () => {
    renderDialog();
    typeIdentifier(MIXED_BECH32);

    const alert = await screen.findByTestId("alert-identifier-warning");
    expect(alert.textContent).toContain("saved in lowercase");
    expect(alert.textContent).toContain(MIXED_BECH32_CANONICAL);
  });

  it("shows no warning for a well-formed lowercase bech32 address", () => {
    renderDialog();
    typeIdentifier(LOWER_BECH32);

    expect(screen.queryByTestId("alert-identifier-warning")).toBeNull();
  });

  it("shows no warning for 64-hex under the free-form 'other' type", async () => {
    renderDialog();
    await switchTypeTo(/^Other$/);
    typeIdentifier(HEX64);

    expect(screen.queryByTestId("alert-identifier-warning")).toBeNull();
  });

  it("never blocks submission while the warning is showing", async () => {
    const onSave = renderDialog();
    fireEvent.change(screen.getByTestId("input-label"), { target: { value: "My tx" } });
    typeIdentifier(HEX64);
    await screen.findByTestId("alert-identifier-warning");

    fireEvent.click(screen.getByTestId("button-save"));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].inputString).toBe(HEX64);
  });
});
