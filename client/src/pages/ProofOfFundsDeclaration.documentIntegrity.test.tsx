// @vitest-environment jsdom
//
// Browser-level guard for the always-on Document Integrity block in the Proof of
// Funds Declaration PDF (ProofOfFundsDeclaration.tsx `generatePdf`).
//
// Every generated PDF must carry:
//   - a "Page N of M" footer on EVERY page, including the declaration reference ID
//   - a Document Integrity section with a 64-character hex SHA-256 fingerprint
//   - a blockchain time-anchor line whenever a live block height was used
//   - a verbatim canonical "fingerprint preimage" that actually re-hashes to the
//     printed fingerprint (proving the integrity claim is reproducible)
// and toggling optional sections (attestation / glossary) must change the total
// page count WITHOUT breaking the footer numbering.
//
// These tests render the REAL <ProofOfFundsDeclaration /> against real Dexie
// data, drive it through the UI (paste address -> Check Balances -> fill
// declarant -> Generate PDF), capture the blob jsPDF hands to
// URL.createObjectURL, and assert on the recovered PDF text. The live block
// height is injected by mocking the blockchain provider so no network is touched.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, waitFor } from "@testing-library/react";

import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { renderWithProviders } from "@/test/testProviders";
import { extractPdfText, pdfHasUtf16beRuns } from "@/test/pdfAssertions";

// Inject a deterministic live block height (and a non-zero balance) so the
// "blockchain time-anchor" branch fires without any network access.
const LIVE_BLOCK_HEIGHT = 840000;
const LIVE_BALANCE_SATS = 150_000_000;

// generatePdf calls `doc.save(...)`, whose `save` is an own instance method that
// in jsdom does not reliably round-trip through URL.createObjectURL. Wrap the
// jsPDF module so each instance's `save` instead stashes the real blob via
// output("blob"); a hoisted holder bridges the mock factory and the test body.
const pdfCapture = vi.hoisted(() => ({ blob: null as Blob | null }));

vi.mock("jspdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jspdf")>();
  const Real = actual.jsPDF;
  function Wrapped(this: unknown, ...args: unknown[]) {
    const inst = new (Real as unknown as new (...a: unknown[]) => {
      save: (...a: unknown[]) => unknown;
      output: (type: string) => Blob;
    })(...args);
    inst.save = function () {
      pdfCapture.blob = inst.output("blob");
      return inst;
    };
    return inst;
  }
  (Wrapped as unknown as { prototype: unknown }).prototype = Real.prototype;
  return { ...actual, default: Wrapped, jsPDF: Wrapped };
});

vi.mock("@/lib/blockchain-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: vi.fn(() => ({
      name: "mock-provider",
      getBlockHeight: async () => LIVE_BLOCK_HEIGHT,
      getAddressCoreStats: async () => ({
        balanceSats: LIVE_BALANCE_SATS,
        txCount: 1,
        receivedSats: LIVE_BALANCE_SATS,
        sentSats: 0,
      }),
      getAddressTransactions: async () => [],
      getTransaction: async () => null,
      testConnection: async () => ({ success: true }),
    })),
  };
});

import ProofOfFundsDeclaration from "./ProofOfFundsDeclaration";

// A valid mainnet bech32 address (BIP-173 test vector) so parseAddressInput
// accepts it and the row reaches "done".
const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  pdfCapture.blob = null;

  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });

  await createRecord(
    { type: "address", inputString: ADDRESS, label: "Owned", tags: [], categories: [] },
    { skipNotification: true, skipVocabularySync: true },
  );

  // Seed one synced confirmed transaction paying the address so the OFFLINE
  // balance source resolves a non-zero balance — the empty-exclusion rule
  // drops zero-balance rows, which would leave nothing to declare.
  await addTransaction(
    {
      txid: "a".repeat(64),
      blockHeight: 820000,
      blockTime: 1_700_000_000,
      fee: 1000,
      feeRate: 10,
      syncedAt: Date.now(),
    },
    { skipNotification: true },
  );
  await addParticipant(
    {
      txid: "a".repeat(64),
      role: "output",
      address: ADDRESS,
      amount: LIVE_BALANCE_SATS,
      vout: 0,
    },
    { skipNotification: true },
  );
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

type Harness = ReturnType<typeof renderWithProviders>;

/** Paste the address, run the balance check, and fill the required declarant
 *  fields so the Generate PDF button becomes enabled. `live` selects the
 *  on-chain balance source (which yields a block-height time-anchor). */
async function prepareDeclaration(
  h: Harness,
  opts: { live: boolean },
): Promise<void> {
  const { getByTestId } = h;

  fireEvent.change(getByTestId("textarea-address-input"), {
    target: { value: ADDRESS },
  });

  if (opts.live) {
    fireEvent.click(getByTestId("button-source-live"));
  }

  fireEvent.click(getByTestId("button-check-balances"));

  fireEvent.change(getByTestId("input-declarant-name"), {
    target: { value: "Alice Example" },
  });
  fireEvent.change(getByTestId("input-purpose"), {
    target: { value: "Bank account opening" },
  });

  // The Generate button only enables once a row reaches "done" and the
  // declarant fields are present (canGeneratePdf).
  await waitFor(() => {
    expect(
      (getByTestId("button-generate-pdf") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
}

async function generateAndCapture(h: Harness): Promise<Blob> {
  pdfCapture.blob = null;
  fireEvent.click(h.getByTestId("button-generate-pdf"));
  await waitFor(() => {
    expect(pdfCapture.blob).toBeInstanceOf(Blob);
  });
  return pdfCapture.blob as unknown as Blob;
}

/** Collect every "Page N of M" footer and assert the numbering is complete and
 *  consistent, and that the declaration reference appears in the footer band. */
function assertFooters(text: string, referenceId: string): number {
  const matches = [...text.matchAll(/Page (\d+) of (\d+)/g)];
  expect(matches.length).toBeGreaterThan(0);

  const totals = new Set(matches.map((m) => m[2]));
  // Every page must report the SAME total.
  expect(totals.size).toBe(1);
  const total = Number([...totals][0]);

  const seen = new Set(matches.map((m) => Number(m[1])));
  for (let p = 1; p <= total; p++) {
    expect(seen.has(p)).toBe(true);
  }
  // The footer band carries the declaration reference ID (the 16-hex nonce).
  expect(text).toContain(`Ref: ${referenceId}`);
  return total;
}

function extractReferenceId(text: string): string {
  const m = text.match(/Declaration Reference:\s*([0-9a-f]{16})/);
  expect(m).not.toBeNull();
  return (m as RegExpMatchArray)[1];
}

function extractFingerprint(text: string): string {
  // The Document Integrity meta block prints the 64-hex SHA-256.
  const idx = text.indexOf("Content Fingerprint (SHA-256):");
  expect(idx).toBeGreaterThanOrEqual(0);
  const m = text.slice(idx).match(/\b([0-9a-f]{64})\b/);
  expect(m).not.toBeNull();
  return (m as RegExpMatchArray)[1];
}

describe("Proof of Funds PDF — Document Integrity & footers", () => {
  it("renders footers, a 64-hex fingerprint, and the live block-height time-anchor", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);
    await prepareDeclaration(h, { live: true });

    const blob = await generateAndCapture(h);
    const text = await extractPdfText(blob);

    // No record-derived string regressed into a garbled UTF-16BE run.
    expect(await pdfHasUtf16beRuns(blob)).toBe(false);

    // Static scaffolding proves the document actually rendered.
    expect(text).toContain("PROOF OF FUNDS DECLARATION");
    expect(text).toContain("DOCUMENT INTEGRITY");

    const referenceId = extractReferenceId(text);
    const fingerprint = extractFingerprint(text);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Blockchain time-anchor: live block height was used.
    expect(text).toContain("On-chain data current as of:");
    expect(text).toContain(`Block ${LIVE_BLOCK_HEIGHT.toLocaleString()}`);

    // Footers on every page, carrying the reference ID.
    assertFooters(text, referenceId);
  });

  it("re-hashes the printed canonical preimage to the printed fingerprint", async () => {
    // Offline mode keeps the canonical payload pure ASCII (no em-dash in the
    // 'as-of' label), so the verbatim preimage recovered from the PDF re-hashes
    // exactly to the printed fingerprint — proving the integrity claim is
    // independently reproducible.
    const h = renderWithProviders(<ProofOfFundsDeclaration />);
    await prepareDeclaration(h, { live: false });

    const blob = await generateAndCapture(h);
    const text = await extractPdfText(blob);

    const fingerprint = extractFingerprint(text);

    // The preimage runs from the canonical header to the GENERATED line.
    const start = text.indexOf("KYUTXO-POF-v1");
    expect(start).toBeGreaterThanOrEqual(0);
    const tail = text.slice(start);
    const genMatch = tail.match(/GENERATED: [^\n]+/);
    expect(genMatch).not.toBeNull();
    const gen = genMatch as RegExpMatchArray;
    const preimage = tail.slice(0, (gen.index as number) + gen[0].length);

    // Sanity: the preimage is the structured canonical payload, not prose.
    expect(preimage).toContain(`REF: ${extractReferenceId(text)}`);
    expect(preimage).toContain("DECLARANT: Alice Example");
    expect(preimage).toContain("SECTION_GLOSSARY: OFF");

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(preimage),
    );
    const recomputed = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(recomputed).toBe(fingerprint);
  });

  it("changes total page count when toggling attestation/glossary but keeps footers correct", async () => {
    const h = renderWithProviders(<ProofOfFundsDeclaration />);
    await prepareDeclaration(h, { live: true });

    // Baseline: both optional sections OFF.
    const baseBlob = await generateAndCapture(h);
    const baseText = await extractPdfText(baseBlob);
    const baseRef = extractReferenceId(baseText);
    const basePages = assertFooters(baseText, baseRef);

    // Turn on the formal attestation block and the glossary appendix.
    fireEvent.click(h.getByTestId("switch-include-attestation"));
    fireEvent.click(h.getByTestId("switch-include-glossary"));

    const expandedBlob = await generateAndCapture(h);
    const expandedText = await extractPdfText(expandedBlob);
    const expandedRef = extractReferenceId(expandedText);
    const expandedPages = assertFooters(expandedText, expandedRef);

    // The reference ID is stable across regenerations within the same session.
    expect(expandedRef).toBe(baseRef);
    // Adding the attestation + glossary appendices grows the document.
    expect(expandedPages).toBeGreaterThan(basePages);
    // The expanded PDF still carries the always-on integrity section + anchor.
    expect(expandedText).toContain("DOCUMENT INTEGRITY");
    expect(expandedText).toContain("FORMAL ATTESTATION");
    expect(extractFingerprint(expandedText)).toMatch(/^[0-9a-f]{64}$/);
  });
});
