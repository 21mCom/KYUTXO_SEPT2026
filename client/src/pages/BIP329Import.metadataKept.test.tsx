// @vitest-environment jsdom
//
// Coverage for the kept-metadata notice on the BIP-329 import completion
// screen (Task: "Show the kept-metadata notice on the desktop Wallet Import
// and BIP-329 pages too"). When executeImport reports keptFieldCounts (a
// user-relevant field kept its existing value on already-existing records),
// the completion screen must render alert-metadata-kept like Mobile Wallet
// Import does, instead of finishing silently.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";
import { clearAllRecords, createRecord } from "@/lib/data/record-crud";
import BIP329Import from "./BIP329Import";

const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function makeJsonl(records: { type: string; ref: string; label?: string }[]) {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

function makeFile(content: string, name = "labels.jsonl"): File {
  const file = new File([content], name, { type: "text/plain" });
  if (typeof file.text !== "function") {
    (file as unknown as { text: () => Promise<string> }).text = () =>
      Promise.resolve(content);
  }
  return file;
}

async function uploadAndRunImport(content: string) {
  const input = screen.getByTestId("input-bip329-file");
  fireEvent.change(input, { target: { files: [makeFile(content)] } });

  await waitFor(() => {
    const next = screen.getByTestId("button-next-step") as HTMLButtonElement;
    expect(next.disabled).toBe(false);
  });

  // Upload → Preview
  fireEvent.click(screen.getByTestId("button-next-step"));
  await waitFor(() => {
    expect(screen.getByTestId("card-preview-table")).toBeTruthy();
  });

  // Preview → Import (runs executeImport)
  fireEvent.click(screen.getByTestId("button-next-step"));
  await waitFor(() => {
    expect(screen.getByTestId("import-result-summary")).toBeTruthy();
  });
}

describe("BIP329Import kept-metadata notice", () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows alert-metadata-kept when an existing record kept its wallet software", async () => {
    // Existing record already has walletSoftware set; the BIP-329 import
    // enters "BIP-329 Export", which must be kept-as-existing and reported.
    await createRecord({
      type: "address",
      inputString: ADDRESS,
      label: "Pre-existing",
      walletSoftware: "Sparrow",
      tags: [],
      categories: [],
    });

    renderWithProviders(<BIP329Import />);
    await uploadAndRunImport(
      makeJsonl([{ type: "addr", ref: ADDRESS, label: "New label" }]),
    );

    const alert = await screen.findByTestId("alert-metadata-kept");
    expect(alert.textContent).toContain("Some existing metadata was kept");
    expect(alert.textContent).toContain(
      "Wallet software: kept the existing value on 1 address",
    );
  });

  it("shows no kept-metadata notice when all records are new", async () => {
    renderWithProviders(<BIP329Import />);
    await uploadAndRunImport(
      makeJsonl([{ type: "addr", ref: ADDRESS, label: "Fresh" }]),
    );

    expect(screen.queryByTestId("alert-metadata-kept")).toBeNull();
  });
});
