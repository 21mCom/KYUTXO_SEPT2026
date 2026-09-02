// @vitest-environment jsdom
//
// Coverage for the BIP-329 import identifier canonicalization heads-up (Task:
// "Warn BIP-329 label imports too when identifiers get silently lowercased").
// The import preview now surfaces a non-blocking notice
// (data-testid="alert-identifier-warning") counting identifiers that will be
// stored case-folded (mixed-case bech32, uppercase hex txids), mirroring the
// Quick Tagger paste flow and the single-record form.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";
import { clearAllRecords } from "@/lib/data/record-crud";
import BIP329Import from "./BIP329Import";

const LOWER_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const MIXED_CASE_ADDRESS = "bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TXID =
  "a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d";
const UPPER_TXID = TXID.toUpperCase();

function makeJsonl(records: { type: string; ref: string; label?: string }[]) {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

function makeFile(content: string, name = "labels.jsonl"): File {
  const file = new File([content], name, { type: "text/plain" });
  // jsdom's File lacks .text(); the page reads content via file.text().
  if (typeof file.text !== "function") {
    (file as unknown as { text: () => Promise<string> }).text = () =>
      Promise.resolve(content);
  }
  return file;
}

async function uploadAndPreview(content: string) {
  const input = screen.getByTestId("input-bip329-file");
  fireEvent.change(input, { target: { files: [makeFile(content)] } });

  // Wait for the file to be parsed (Continue button becomes enabled)
  await waitFor(() => {
    const next = screen.getByTestId("button-next-step") as HTMLButtonElement;
    expect(next.disabled).toBe(false);
  });

  fireEvent.click(screen.getByTestId("button-next-step"));

  await waitFor(() => {
    expect(screen.getByTestId("card-preview-table")).toBeTruthy();
  });
}

describe("BIP329Import identifier canonicalization warning", () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  afterEach(() => {
    cleanup();
  });

  it("warns on the preview step when identifiers will be case-folded", async () => {
    renderWithProviders(<BIP329Import />);

    await uploadAndPreview(
      makeJsonl([
        { type: "addr", ref: MIXED_CASE_ADDRESS, label: "Mixed case" },
        { type: "tx", ref: UPPER_TXID, label: "Upper txid" },
        { type: "addr", ref: LOWER_ADDRESS, label: "Already canonical" },
      ]),
    );

    const alert = screen.getByTestId("alert-identifier-warning");
    expect(alert.textContent).toContain(
      "2 identifiers will be saved in lowercase",
    );
    expect(alert.textContent).toContain("canonical lowercase form");
  });

  it("shows no warning when all identifiers are already canonical", async () => {
    renderWithProviders(<BIP329Import />);

    await uploadAndPreview(
      makeJsonl([
        { type: "addr", ref: LOWER_ADDRESS, label: "Canonical addr" },
        { type: "tx", ref: TXID, label: "Canonical txid" },
      ]),
    );

    expect(screen.queryByTestId("alert-identifier-warning")).toBeNull();
  });

  it("counts uppercase outpoint identifiers (txid:vout) in the warning", async () => {
    renderWithProviders(<BIP329Import />);

    await uploadAndPreview(
      makeJsonl([
        { type: "output", ref: `${UPPER_TXID}:0`, label: "Upper outpoint" },
        { type: "output", ref: `${TXID}:1`, label: "Canonical outpoint" },
      ]),
    );

    const alert = screen.getByTestId("alert-identifier-warning");
    expect(alert.textContent).toContain(
      "1 identifier will be saved in lowercase",
    );
  });

  it("uses singular wording for a single case-folded identifier", async () => {
    renderWithProviders(<BIP329Import />);

    await uploadAndPreview(
      makeJsonl([{ type: "addr", ref: MIXED_CASE_ADDRESS, label: "Mixed" }]),
    );

    const alert = screen.getByTestId("alert-identifier-warning");
    expect(alert.textContent).toContain(
      "1 identifier will be saved in lowercase",
    );
  });
});
