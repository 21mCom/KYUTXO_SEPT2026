// @vitest-environment jsdom
//
// Regression coverage for ENTITY_* source citations when the active entity list
// came from a USER-IMPORTED JSON snapshot rather than the in-code helper.
//
// Reports.privacyCitationRenderEndToEnd.test.tsx (and the parity / warning /
// export tests) all seed the entity via setActiveEntityList() — the in-memory
// helper that bypasses validation and persistence entirely. But in production a
// user replaces the active list by importing a JSON snapshot through
// Settings > Privacy Audit Entity List, which runs the REAL
// validate → normalize → persist → re-apply path in
// client/src/lib/data/entity-list-store.ts. A validation/normalization bug there
// (e.g. trimming, dropping, or otherwise mangling the optional `sourceNote`, the
// public attribution citation) could silently strip the "why" from a flagged
// counterparty before it ever reaches a finding — and no test exercised the
// imported-list → audit → citation path end to end.
//
// This test imports a user-supplied snapshot (a JSON file's parsed contents,
// with a sourceNote containing a URL) through importEntitySnapshot(), runs the
// REAL runPrivacyAudit() against a seeded owned→entity contact, and asserts the
// citation (name, categoryLabel, address, sourceNote) still surfaces on all
// three surfaces users read:
//   - the on-screen Privacy Audit panel (PrivacyAuditReportPanel),
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport).
//
// It also proves the snapshot persisted to settings.entityListSnapshot is
// re-applied verbatim on a simulated app restart (loadEntitySnapshotFromStorage)
// with the sourceNote intact, and that the sourceNote URL is never fetched at
// any point — KYUTXO is strictly offline.

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
  loadEntitySnapshotFromStorage,
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
// detectEntityContacts captures. Both are REAL, checksum-valid mainnet addresses
// because the import path validates every address (unlike setActiveEntityList).
// Non-round amounts keep other heuristics from muddying the finding under test.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ENTITY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// A sourceNote that embeds a real URL so we can prove the URL survives the
// import/validate/persist round-trip and is never auto-fetched on any surface.
const SOURCE_URL = "https://www.walletexplorer.com/address/imported-example";
const SOURCE_NOTE = `WalletExplorer.com service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Imported Test Exchange";
const ENTITY_CATEGORY_LABEL = "Exchange";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

// The exact bytes a user would have in their snapshot file: the `{ entries: [] }`
// envelope form, with the sourceNote carrying a URL inside surrounding prose.
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

/**
 * Drive a user-supplied JSON snapshot through the REAL import path:
 * parse → validateEntitySnapshot → applyEntitySnapshot (sets the active list AND
 * persists to settings.entityListSnapshot). Returns nothing; throws if the
 * import did not succeed so a validation regression fails loudly here.
 */
async function importUserSnapshot(): Promise<void> {
  const parsed = JSON.parse(SNAPSHOT_JSON) as unknown;
  const result = await importEntitySnapshot(parsed, "user-snapshot.json", "replace");
  expect(result.valid).toBe(true);
  expect(result.count).toBe(1);
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
  // The db `ready` hook seeds the `default` settings record; clear only the
  // snapshot field (updateSettings uses .update, a no-op on a missing row, so
  // we must keep the record itself) for a clean starting point.
  await resetEntitySnapshot();
  resetActiveEntityList();

  // Seed the active list the way production does: a validated user JSON import.
  await importUserSnapshot();
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

describe("ENTITY_* citations survive a user-imported entity list", () => {
  it("attaches the imported sourceNote citation to the real audit finding", async () => {
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
    // The attribution URL came through the import path verbatim, untrimmed.
    expect(citations[0].sourceNote).toContain(SOURCE_URL);
  });

  it("surfaces the imported citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const row = readOnlyCitationRow(container);
    expect(row.name).toBe(ENTITY_NAME);
    expect(row.category).toBe(ENTITY_CATEGORY_LABEL);
    expect(row.address).toBe(ENTITY_ADDR);
    expect(row.sourceCell.textContent).toContain(SOURCE_NOTE);
  });

  it("renders the imported citation sourceNote URL as an informational link (never auto-fetched)", async () => {
    const { container } = await renderPanelWithRealAudit();

    const { sourceCell } = readOnlyCitationRow(container);
    // The URL is visible verbatim within the surrounding note text.
    expect(sourceCell.textContent).toContain(SOURCE_URL);

    // renderSourceNote turns the URL into an anchor that only navigates on an
    // explicit user click — it is shown for reference, not fetched at render.
    const anchor = sourceCell.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe(SOURCE_URL);
    // The surrounding non-URL prose stays plain text in the same cell.
    expect(sourceCell.textContent).toContain("WalletExplorer.com service clustering");
  });

  it("serializes the imported citation into the JSON export with the URL as plain text", async () => {
    const result = await runPrivacyAudit([OWNED1]);

    const auditFinding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(auditFinding).toBeTruthy();
    expect(getCitations(auditFinding!.details)).toHaveLength(1);

    // Round-trip through JSON.stringify so we assert the actual serialized shape
    // the exported .json download carries — not the in-memory object.
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
    // The URL survives serialization verbatim — JSON is data, not markup.
    expect(exported!.citations![0].sourceNote).toContain(SOURCE_URL);
  });

  it("renders the imported citation into the printable PDF/HTML export with the URL as plain text", async () => {
    const result = await runPrivacyAudit([OWNED1]);
    const html = buildPrintableReport(result, SCOPE, FIXED_NOW);

    // Every citation field reaches the printable report.
    expect(html).toContain(ENTITY_NAME);
    expect(html).toContain(ENTITY_CATEGORY_LABEL);
    expect(html).toContain(ENTITY_ADDR);
    expect(html).toContain(SOURCE_NOTE);

    // The URL appears verbatim and is NEVER wrapped in an anchor in the export
    // (offline-first — printable citation URLs are reference text, not links).
    expect(html).toContain(SOURCE_URL);
    expect(html).not.toContain(`href="${SOURCE_URL}"`);
    expect(html).not.toContain("<a href");
  });

  it("re-applies the persisted snapshot (sourceNote intact) on a simulated restart", async () => {
    // Simulate an app restart: wipe the in-memory active list, then re-hydrate
    // it solely from settings.entityListSnapshot, exactly as startup does.
    resetActiveEntityList();
    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");

    // The audit now runs against the re-applied list — the citation (and its
    // URL) must come back byte-for-byte after persistence + re-hydration.
    const result = await runPrivacyAudit([OWNED1]);
    const finding = result.findings.find((f) => f.type === "ENTITY_EXCHANGE");
    expect(finding).toBeTruthy();
    expect(getCitations(finding!.details)).toEqual([
      {
        name: ENTITY_NAME,
        address: ENTITY_ADDR,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);
  });

  it("never fetches the embedded sourceNote URL across import, audit, render, and export", async () => {
    const { container } = await renderPanelWithRealAudit();
    readOnlyCitationRow(container); // ensure the citation actually rendered

    const result = await runPrivacyAudit([OWNED1]);
    buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString());
    buildPrintableReport(result, SCOPE, FIXED_NOW);

    // The whole offline pipeline must never have reached for the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
