// @vitest-environment jsdom
//
// Regression coverage for the "warned-but-valid" entity-list import path.
//
// When a user imports an entity list, a sourceNote whose embedded address
// citation (e.g. .../address/<addr>) differs from the entry's own address is a
// likely copy/paste mistake. validateEntitySnapshot flags this with a
// *non-fatal* EntitySnapshotWarning (via findMismatchedCitations) — it must NOT
// turn the entry into an error, must NOT drop the entry, and must NOT strip the
// sourceNote. The whole point of the warning is to let the user review the
// attribution while still keeping it: the sourceNote is the "why" behind a
// flagged counterparty, and it has to survive all the way to a Privacy Audit
// finding and its exports.
//
// The sibling Reports.privacyCitationImportedList.test.tsx proves an imported
// citation reaches the audit, but its sourceNote happens to match the entry's
// address (no warning). Nothing tested that a *mismatched* citation — the case
// that raises a warning — still imports and still surfaces as the flag reason.
// A future tightening of import validation (e.g. promoting this warning to an
// error, or quietly discarding warned entries) could silently lose the
// attribution for a flagged counterparty, and no test would notice.
//
// This test imports a user-supplied snapshot whose single valid entry cites a
// DIFFERENT (but real, checksum-valid) address in its sourceNote, asserts the
// import succeeds with exactly one warning and zero errors (the entry retained),
// then runs the REAL runPrivacyAudit() against a seeded owned→entity contact and
// confirms the (mismatched-citation) sourceNote still surfaces on all three
// surfaces users read: the on-screen panel, the JSON export, and the printable
// PDF/HTML export. The embedded URL is never fetched — KYUTXO is strictly
// offline.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import { clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { runPrivacyAudit, type EntityCitation } from "@/lib/privacy-audit";
import { resetActiveEntityList } from "@/lib/privacy-entity-list";
import {
  importEntitySnapshot,
  resetEntitySnapshot,
} from "@/lib/data/entity-list-store";
import {
  buildPrivacyReport,
  type ExportScope,
  type ExportedFinding,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";

// The panel reads address records via getRecordsPageByTypeIdReverseKeyset to
// build the audit's address list. Stub just that one read to return the owned
// address — the audit itself (runPrivacyAudit, real) reads the seeded
// participants/transactions straight from Dexie, so the citation it produces is
// genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      {
        id: 1,
        // Inlined (not the OWNED1 const) so the hoisted mock factory never
        // touches a not-yet-initialized top-level binding.
        inputString: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        owner: undefined,
        walletName: undefined,
      },
    ]),
  };
});

vi.mock("@/hooks/use-owners", () => ({
  useOwners: () => ({ owners: [], isLoading: false }),
}));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [], isLoading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// OWNED1 pays directly to ENTITY_ADDR in TX1 — a hop-1 (direct) contact that
// detectEntityContacts captures. All addresses are REAL, checksum-valid mainnet
// addresses because the import path validates every one.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ENTITY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// The sourceNote cites a DIFFERENT (real, checksum-valid) address than the
// entry's own ENTITY_ADDR — the copy/paste mistake that raises a non-fatal
// warning. The cited address must be alphanumeric-contiguous so CITATION_RE
// captures it whole.
const WRONG_CITED_ADDR = "3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5";
const SOURCE_URL = `https://www.walletexplorer.com/address/${WRONG_CITED_ADDR}`;
const SOURCE_NOTE = `WalletExplorer.com service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Mismatched Citation Exchange";
const ENTITY_CATEGORY_LABEL = "Exchange";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

// The exact bytes a user would have in their snapshot file: the `{ entries: [] }`
// envelope form, with the sourceNote citing a different address than the entry.
const SNAPSHOT_JSON = JSON.stringify({
  entries: [
    {
      address: ENTITY_ADDR,
      name: ENTITY_NAME,
      category: "exchange",
      sourceNote: SOURCE_NOTE,
    },
  ],
});

async function seedDirectContact(): Promise<void> {
  await addTransaction(
    { txid: TX1, blockHeight: 800002, blockTime: 1_700_000_900, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX1, role: "input", address: OWNED1, amount: 250_123, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid: TX1, role: "output", address: ENTITY_ADDR, amount: 199_111, vout: 0 },
    { skipNotification: true },
  );
}

function getCitations(details: Record<string, unknown>): EntityCitation[] {
  return (details.citations as EntityCitation[]) ?? [];
}

// Spy on fetch for the whole flow to prove the embedded sourceNote URL is never
// requested — import, audit, render, and export are all strictly offline.
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  fetchSpy = vi.fn(() => Promise.reject(new Error("network access is forbidden")));
  vi.stubGlobal("fetch", fetchSpy);

  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedDirectContact();
  await resetEntitySnapshot();
  resetActiveEntityList();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await resetEntitySnapshot();
  resetActiveEntityList();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

const { PrivacyAuditReportPanel } = await import("./Reports");

/** Render the panel and run the REAL audit by clicking Generate. */
async function renderPanelWithRealAudit() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

/** Locate the single on-screen citation row produced for the ENTITY_* finding. */
function readOnlyCitationRow(container: HTMLElement): {
  name: string;
  category: string;
  address: string;
  sourceCell: HTMLElement;
} {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid^="row-privacy-citation-"]'),
  );
  expect(rows).toHaveLength(1);
  const cells = Array.from(rows[0].querySelectorAll<HTMLElement>("td"));
  return {
    name: cells[0].textContent!.trim(),
    category: cells[1].textContent!.trim(),
    address: cells[2].textContent!.trim(),
    sourceCell: cells[3],
  };
}

describe("a mismatched-citation entry imports (with a warning) and keeps its reason", () => {
  it("imports with a non-fatal warning, zero errors, and retains the entry", async () => {
    const parsed = JSON.parse(SNAPSHOT_JSON) as unknown;
    const result = await importEntitySnapshot(parsed, "user-snapshot.json", "replace");

    // The warned entry is NOT blocked: the import succeeds and keeps the entry.
    expect(result.valid).toBe(true);
    expect(result.count).toBe(1);
    expect(result.activeCount).toBe(1);
    expect(result.errors).toEqual([]);

    // Exactly one advisory: the sourceNote cites a different address.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].index).toBe(0);
    expect(result.warnings[0].address).toBe(ENTITY_ADDR);
    expect(result.warnings[0].citedAddresses).toEqual([WRONG_CITED_ADDR]);
  });

  it("attaches the warned entry's sourceNote citation to the real audit finding", async () => {
    await importEntitySnapshot(JSON.parse(SNAPSHOT_JSON), "user-snapshot.json", "replace");

    const result = await runPrivacyAudit([OWNED1]);
    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();

    const citations = getCitations(finding!.details);
    expect(citations).toEqual([
      {
        name: ENTITY_NAME,
        address: ENTITY_ADDR,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);
    // The (mismatched) attribution URL came through verbatim, untrimmed.
    expect(citations[0].sourceNote).toContain(SOURCE_URL);
  });

  it("surfaces the warned citation (name/category/address/source) in the on-screen panel", async () => {
    await importEntitySnapshot(JSON.parse(SNAPSHOT_JSON), "user-snapshot.json", "replace");

    const { container } = await renderPanelWithRealAudit();
    const row = readOnlyCitationRow(container);
    expect(row.name).toBe(ENTITY_NAME);
    expect(row.category).toBe(ENTITY_CATEGORY_LABEL);
    expect(row.address).toBe(ENTITY_ADDR);
    expect(row.sourceCell.textContent).toContain(SOURCE_NOTE);
    expect(row.sourceCell.textContent).toContain(SOURCE_URL);
  });

  it("serializes the warned citation into the JSON and printable PDF/HTML exports", async () => {
    await importEntitySnapshot(JSON.parse(SNAPSHOT_JSON), "user-snapshot.json", "replace");
    const result = await runPrivacyAudit([OWNED1]);

    // JSON export — round-trip through JSON.stringify to assert the serialized
    // shape the downloaded .json actually carries.
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
    ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };
    const exported = [...report.findings, ...report.warnings].find(
      (f) => f.type === "ENTITY_EXCHANGE",
    );
    expect(exported).toBeTruthy();
    expect(exported!.citations).toEqual([
      {
        name: ENTITY_NAME,
        address: ENTITY_ADDR,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);

    // Printable PDF/HTML export — every citation field reaches the report, and
    // the URL is reference text, never an anchor (offline-first).
    const html = buildPrintableReport(result, SCOPE, FIXED_NOW);
    expect(html).toContain(ENTITY_NAME);
    expect(html).toContain(ENTITY_CATEGORY_LABEL);
    expect(html).toContain(ENTITY_ADDR);
    expect(html).toContain(SOURCE_NOTE);
    expect(html).toContain(SOURCE_URL);
    expect(html).not.toContain(`href="${SOURCE_URL}"`);
    expect(html).not.toContain("<a href");
  });

  it("never fetches the embedded sourceNote URL across import, audit, render, and export", async () => {
    await importEntitySnapshot(JSON.parse(SNAPSHOT_JSON), "user-snapshot.json", "replace");

    const { container } = await renderPanelWithRealAudit();
    readOnlyCitationRow(container); // ensure the citation actually rendered

    const result = await runPrivacyAudit([OWNED1]);
    buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString());
    buildPrintableReport(result, SCOPE, FIXED_NOW);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
