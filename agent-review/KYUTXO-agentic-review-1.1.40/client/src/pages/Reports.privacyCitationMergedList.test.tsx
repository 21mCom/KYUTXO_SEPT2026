// @vitest-environment jsdom
//
// Regression coverage for ENTITY_* source citations when the active entity list
// came from a USER-IMPORTED JSON snapshot applied in 'merge' mode rather than
// 'replace' mode.
//
// Reports.privacyCitationImportedList.test.tsx already proves the 'replace'
// path: a user-imported snapshot whose sourceNote citation survives the
// import/validate/persist path all the way to a Privacy Audit finding and its
// exports. But users can also import in 'merge' mode, where their entries are
// unioned on top of the bundled list (the snapshot wins on duplicate addresses)
// and ONLY the user-supplied entries are persisted to settings.entityListSnapshot
// so future bundled updates still flow through. mergeWithBundled() and the merge
// re-apply branch in loadEntitySnapshotFromStorage() are a separate code path —
// nothing exercised it end to end against the audit. A normalization/merge bug
// there could strip or alter the sourceNote attribution for a merged-in
// counterparty (or drop the bundled entries it was supposed to union onto)
// without any test catching it.
//
// This test imports a user-supplied snapshot in 'merge' mode through the REAL
// importEntitySnapshot(..., 'merge') path — with a sourceNote containing a URL
// on a BRAND-NEW address that is not in the bundled list — runs the REAL
// runPrivacyAudit() against a seeded owned→entity contact, and asserts the
// citation (name, categoryLabel, address, sourceNote) still surfaces on all
// three surfaces users read:
//   - the on-screen Privacy Audit panel (PrivacyAuditReportPanel),
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport).
//
// It also proves:
//   - the merge actually unioned onto the bundled list (bundled entries are
//     still present; the active count is bundled + 1),
//   - the snapshot persisted to settings.entityListSnapshot is re-applied as a
//     MERGE (not a replace) on a simulated restart (loadEntitySnapshotFromStorage)
//     with the sourceNote intact and the bundled entries still resolvable, and
//   - the sourceNote URL is never fetched at any point — KYUTXO is strictly
//     offline.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchCallsWithNoteUrl } from "@/test/noteFetchCalls";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import { clearAllRecords } from "@/lib/data/record-crud";
import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { runPrivacyAudit, type EntityCitation } from "@/lib/privacy-audit";
import {
  resetActiveEntityList,
  lookupEntity,
  getActiveEntityCount,
  getBundledEntityCount,
} from "@/lib/privacy-entity-list";
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
// ENTITY_ADDR is deliberately NOT in the bundled list so it can only be flagged
// because the merged-in user entry surfaced it. Non-round amounts keep other
// heuristics from muddying the finding under test.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ENTITY_ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// A known BUNDLED address (Binance) — used to prove the merge unioned onto the
// bundled defaults rather than replacing them.
const BUNDLED_ADDR = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";

// A sourceNote that embeds a real URL so we can prove the URL survives the
// merge/validate/persist round-trip and is never auto-fetched on any surface.
const SOURCE_URL = "https://www.walletexplorer.com/address/imported-example";
const SOURCE_NOTE = `WalletExplorer.com service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Merged Test Exchange";
const ENTITY_CATEGORY_LABEL = "Exchange";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

// The exact bytes a user would have in their snapshot file: the `{ entries: [] }`
// envelope form, with the sourceNote carrying a URL inside surrounding prose.
// A single brand-new entry that a merge will add on top of the bundled list.
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
 * Drive a user-supplied JSON snapshot through the REAL MERGE import path:
 * parse → validateEntitySnapshot → applyEntitySnapshot('merge') (unions the
 * snapshot on top of the bundled list, sets the active list, AND persists ONLY
 * the user-supplied entries to settings.entityListSnapshot with mode: 'merge').
 * Throws if the import did not succeed so a validation regression fails loudly.
 */
async function importMergedSnapshot(): Promise<void> {
  const parsed = JSON.parse(SNAPSHOT_JSON) as unknown;
  const result = await importEntitySnapshot(parsed, "user-snapshot.json", "merge");
  expect(result.valid).toBe(true);
  expect(result.mode).toBe("merge");
  // count is the number of USER entries; activeCount is the merged total.
  expect(result.count).toBe(1);
  expect(result.activeCount).toBe(getBundledEntityCount() + 1);
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

  // Seed the active list the way production does for merge mode: a validated
  // user JSON import unioned on top of the bundled list.
  await importMergedSnapshot();
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

describe("ENTITY_* citations survive a MERGED (not replaced) entity list", () => {
  it("unions the user entry onto the bundled list without dropping bundled entries", () => {
    // The merge added exactly one entry on top of the full bundled list.
    expect(getActiveEntityCount()).toBe(getBundledEntityCount() + 1);

    // The merged-in user entry resolves with its sourceNote intact.
    const merged = lookupEntity(ENTITY_ADDR);
    expect(merged).toEqual({
      address: ENTITY_ADDR,
      name: ENTITY_NAME,
      category: "exchange",
      sourceNote: SOURCE_NOTE,
    });

    // A known bundled entry is still present (the merge did not replace it).
    expect(lookupEntity(BUNDLED_ADDR)?.name).toBe("Binance");
  });

  it("attaches the merged-in sourceNote citation to the real audit finding", async () => {
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
    // The attribution URL came through the merge path verbatim, untrimmed.
    expect(citations[0].sourceNote).toContain(SOURCE_URL);
  });

  it("surfaces the merged-in citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const row = readOnlyCitationRow(container);
    expect(row.name).toBe(ENTITY_NAME);
    expect(row.category).toBe(ENTITY_CATEGORY_LABEL);
    expect(row.address).toBe(ENTITY_ADDR);
    expect(row.sourceCell.textContent).toContain(SOURCE_NOTE);
  });

  it("renders the merged-in citation sourceNote URL as an informational link (never auto-fetched)", async () => {
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

  it("serializes the merged-in citation into the JSON export with the URL as plain text", async () => {
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

  it("renders the merged-in citation into the printable PDF/HTML export with the URL as plain text", async () => {
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

  it("re-applies the persisted snapshot as a MERGE (sourceNote + bundled entries intact) on a simulated restart", async () => {
    // Simulate an app restart: wipe the in-memory active list, then re-hydrate
    // it solely from settings.entityListSnapshot, exactly as startup does.
    resetActiveEntityList();
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());

    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");

    // The re-apply was a MERGE, not a replace: the bundled entries came back and
    // the single user entry is unioned on top (bundled + 1).
    expect(getActiveEntityCount()).toBe(getBundledEntityCount() + 1);
    expect(lookupEntity(BUNDLED_ADDR)?.name).toBe("Binance");
    expect(lookupEntity(ENTITY_ADDR)).toEqual({
      address: ENTITY_ADDR,
      name: ENTITY_NAME,
      category: "exchange",
      sourceNote: SOURCE_NOTE,
    });

    // The audit now runs against the re-applied merged list — the citation (and
    // its URL) must come back byte-for-byte after persistence + re-hydration.
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

  it("never fetches the embedded sourceNote URL across merge import, audit, render, and export", async () => {
    const { container } = await renderPanelWithRealAudit();
    readOnlyCitationRow(container); // ensure the citation actually rendered

    const result = await runPrivacyAudit([OWNED1]);
    buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString());
    buildPrintableReport(result, SCOPE, FIXED_NOW);

    // The whole offline pipeline must never have fetched the citation URL.
    // Unrelated app-level background fetches (e.g. Tor proxy settings-token
    // sync) can legitimately fire while real app components mount, so we
    // assert narrowly instead of expecting zero fetch calls overall.
    expect(fetchCallsWithNoteUrl(fetchSpy, SOURCE_URL)).toEqual([]);
  });
});
