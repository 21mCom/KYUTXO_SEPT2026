// @vitest-environment jsdom
//
// Regression coverage for the merge-mode OVERRIDE case of the Privacy Audit
// entity list.
//
// Reports.privacyCitationMergedList.test.tsx already proves the merge-mode ADD
// path: a user imports (merge mode) a BRAND-NEW address that is not in the
// bundled list, and its citation survives the audit + exports. But merge mode
// has a second half — the OVERRIDE case. A user can import an entry whose
// address ALSO exists in the bundled list, where the snapshot is supposed to
// WIN on that duplicate. mergeWithBundled() does `merged.set(entry.address,
// entry)`, so the user entry must overwrite the bundled one (different name,
// category, AND sourceNote). Nothing exercised this against the real Privacy
// Audit: a merge bug could silently keep showing the BUNDLED name/category/
// sourceNote for an overridden counterparty.
//
// This test imports a user-supplied snapshot in 'merge' mode through the REAL
// importEntitySnapshot(..., 'merge') path. The single imported entry targets a
// KNOWN BUNDLED address (Binance, an exchange) but re-attributes it with a
// different name, a different category (darknet), and a different sourceNote.
// It then runs the REAL runPrivacyAudit() against a seeded owned→that-address
// contact and asserts the USER-supplied name / categoryLabel / sourceNote
// surface — and the bundled name ("Binance"), bundled categoryLabel
// ("Exchange"), and bundled sourceNote do NOT — on all three surfaces users
// read:
//   - the on-screen Privacy Audit panel (PrivacyAuditReportPanel),
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport).
//
// It also proves:
//   - the override did NOT grow the list (active count stays == bundled count,
//     because the duplicate address overwrote an existing bundled entry),
//   - other bundled entries remain untouched by the override, and
//   - the override survives a simulated restart (loadEntitySnapshotFromStorage
//     re-applies it as a MERGE, still overridden).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchCallsWithNoteUrl } from "@/test/noteFetchCalls";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { clearAllRecords } from "@/lib/data/record-crud";
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
// detectEntityContacts captures. ENTITY_ADDR is a KNOWN BUNDLED address
// (Binance, category "exchange") so the merge import overrides it. Non-round
// amounts keep other heuristics from muddying the finding under test.
const OWNED1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
// A bundled address: { name: "Binance", category: "exchange", sourceNote: ... }.
const ENTITY_ADDR = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo";
const TX1 = "3333333333333333333333333333333333333333333333333333333333333333";

// A second known BUNDLED address — used to prove the override did NOT disturb
// other bundled entries.
const OTHER_BUNDLED_ADDR = "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s";

// The values the BUNDLED list carries for ENTITY_ADDR — these MUST NOT surface
// once the user snapshot overrides them.
const BUNDLED_NAME = "Binance";
const BUNDLED_CATEGORY_LABEL = "Exchange";
const BUNDLED_SOURCE_FRAGMENT = "Widely published / tagged on public blockchain explorers";

// The USER's re-attribution: a different name, a different category, and a
// different sourceNote (with a URL citing the SAME address to avoid a
// mismatched-citation warning).
const OVERRIDE_URL = `https://www.walletexplorer.com/address/${ENTITY_ADDR}`;
const OVERRIDE_NOTE = `Reclassified by analyst — ${OVERRIDE_URL}`;
const OVERRIDE_NAME = "Reclassified Darknet Cluster";
const OVERRIDE_CATEGORY = "darknet";
const OVERRIDE_CATEGORY_LABEL = "Darknet Market";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

// The exact bytes a user would have in their snapshot file: the `{ entries: [] }`
// envelope form, a single entry whose address collides with a bundled one so a
// merge OVERRIDES (not adds) it.
const SNAPSHOT_JSON = JSON.stringify({
  entries: [
    {
      address: ENTITY_ADDR,
      name: OVERRIDE_NAME,
      category: OVERRIDE_CATEGORY,
      sourceNote: OVERRIDE_NOTE,
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
 * Drive the user snapshot through the REAL MERGE import path. Because the entry
 * address already exists in the bundled list, the merge OVERRIDES it rather than
 * adding, so the active count stays equal to the bundled count.
 */
async function importOverrideSnapshot(): Promise<void> {
  const parsed = JSON.parse(SNAPSHOT_JSON) as unknown;
  const result = await importEntitySnapshot(parsed, "user-snapshot.json", "merge");
  expect(result.valid).toBe(true);
  expect(result.mode).toBe("merge");
  // One USER entry, but it overrides a duplicate so the merged total is unchanged.
  expect(result.count).toBe(1);
  expect(result.activeCount).toBe(getBundledEntityCount());
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

  // Seed the active list the way production does for a merge-mode OVERRIDE: a
  // validated user JSON import unioned on top of the bundled list, winning on a
  // duplicate address.
  await importOverrideSnapshot();
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

describe("A merge OVERRIDE re-categorizes a bundled entry (snapshot wins)", () => {
  it("overwrites the bundled entry in place without growing the list or disturbing others", () => {
    // The override targeted a duplicate address, so the merged list did not grow.
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());

    // The overridden address now resolves to the USER values, not the bundled ones.
    const overridden = lookupEntity(ENTITY_ADDR);
    expect(overridden).toEqual({
      address: ENTITY_ADDR,
      name: OVERRIDE_NAME,
      category: OVERRIDE_CATEGORY,
      sourceNote: OVERRIDE_NOTE,
    });
    expect(overridden!.name).not.toBe(BUNDLED_NAME);

    // A different bundled entry is untouched by the override.
    expect(lookupEntity(OTHER_BUNDLED_ADDR)?.name).toBe("Binance Cold Wallet");
  });

  it("attaches the OVERRIDDEN (not bundled) citation to the real audit finding", async () => {
    const result = await runPrivacyAudit([OWNED1]);

    // The category changed to darknet, so the finding type changed too.
    const finding = result.findings.find((f) => f.type === "ENTITY_DARKNET");
    expect(finding).toBeTruthy();
    // And there is no longer an exchange finding for this contact.
    expect(result.findings.some((f) => f.type === "ENTITY_EXCHANGE")).toBe(false);

    const citations = getCitations(finding!.details);
    expect(citations).toEqual([
      {
        name: OVERRIDE_NAME,
        address: ENTITY_ADDR,
        categoryLabel: OVERRIDE_CATEGORY_LABEL,
        sourceNote: OVERRIDE_NOTE,
      },
    ]);
    // The bundled attribution must be gone entirely.
    expect(citations[0].name).not.toBe(BUNDLED_NAME);
    expect(citations[0].categoryLabel).not.toBe(BUNDLED_CATEGORY_LABEL);
    expect(citations[0].sourceNote).not.toContain(BUNDLED_SOURCE_FRAGMENT);
  });

  it("surfaces the OVERRIDDEN citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const row = readOnlyCitationRow(container);
    expect(row.name).toBe(OVERRIDE_NAME);
    expect(row.category).toBe(OVERRIDE_CATEGORY_LABEL);
    expect(row.address).toBe(ENTITY_ADDR);
    expect(row.sourceCell.textContent).toContain(OVERRIDE_NOTE);

    // None of the bundled values leak onto the panel.
    expect(row.name).not.toBe(BUNDLED_NAME);
    expect(row.category).not.toBe(BUNDLED_CATEGORY_LABEL);
    expect(row.sourceCell.textContent).not.toContain(BUNDLED_SOURCE_FRAGMENT);
  });

  it("serializes the OVERRIDDEN citation into the JSON export (not the bundled one)", async () => {
    const result = await runPrivacyAudit([OWNED1]);

    const auditFinding = result.findings.find((f) => f.type === "ENTITY_DARKNET");
    expect(auditFinding).toBeTruthy();
    expect(getCitations(auditFinding!.details)).toHaveLength(1);

    // Round-trip through JSON.stringify so we assert the actual serialized shape
    // the exported .json download carries — not the in-memory object.
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
    ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

    const exported = [...report.findings, ...report.warnings].find(
      (f) => f.type === "ENTITY_DARKNET",
    );
    expect(exported).toBeTruthy();
    expect(exported!.citations).toEqual([
      {
        name: OVERRIDE_NAME,
        address: ENTITY_ADDR,
        categoryLabel: OVERRIDE_CATEGORY_LABEL,
        sourceNote: OVERRIDE_NOTE,
      },
    ]);
    // The bundled name/source never appear in any exported entity finding.
    const allExported = [...report.findings, ...report.warnings];
    expect(allExported.some((f) => f.type === "ENTITY_EXCHANGE")).toBe(false);
  });

  it("renders the OVERRIDDEN citation into the printable PDF/HTML export (not the bundled one)", async () => {
    const result = await runPrivacyAudit([OWNED1]);
    const html = buildPrintableReport(result, SCOPE, FIXED_NOW);

    // Every overridden citation field reaches the printable report.
    expect(html).toContain(OVERRIDE_NAME);
    expect(html).toContain(OVERRIDE_CATEGORY_LABEL);
    expect(html).toContain(ENTITY_ADDR);
    expect(html).toContain(OVERRIDE_NOTE);

    // The bundled name and bundled sourceNote prose are gone from the export.
    expect(html).not.toContain(BUNDLED_SOURCE_FRAGMENT);

    // The URL appears verbatim and is NEVER wrapped in an anchor in the export
    // (offline-first — printable citation URLs are reference text, not links).
    expect(html).toContain(OVERRIDE_URL);
    expect(html).not.toContain(`href="${OVERRIDE_URL}"`);
    expect(html).not.toContain("<a href");
  });

  it("re-applies the OVERRIDE as a MERGE on a simulated restart (still overridden)", async () => {
    // Simulate an app restart: wipe the in-memory active list, then re-hydrate
    // it solely from settings.entityListSnapshot, exactly as startup does.
    resetActiveEntityList();
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());
    // Before re-applying, the address resolves to the BUNDLED entry again.
    expect(lookupEntity(ENTITY_ADDR)?.name).toBe(BUNDLED_NAME);

    const status = await loadEntitySnapshotFromStorage();
    expect(status.source).toBe("imported");

    // The re-apply was a MERGE override: count unchanged, other bundled entries
    // intact, and the address overridden again with the USER values.
    expect(getActiveEntityCount()).toBe(getBundledEntityCount());
    expect(lookupEntity(OTHER_BUNDLED_ADDR)?.name).toBe("Binance Cold Wallet");
    expect(lookupEntity(ENTITY_ADDR)).toEqual({
      address: ENTITY_ADDR,
      name: OVERRIDE_NAME,
      category: OVERRIDE_CATEGORY,
      sourceNote: OVERRIDE_NOTE,
    });

    // The audit now runs against the re-applied merged list — the OVERRIDDEN
    // citation must come back byte-for-byte after persistence + re-hydration.
    const result = await runPrivacyAudit([OWNED1]);
    const finding = result.findings.find((f) => f.type === "ENTITY_DARKNET");
    expect(finding).toBeTruthy();
    expect(getCitations(finding!.details)).toEqual([
      {
        name: OVERRIDE_NAME,
        address: ENTITY_ADDR,
        categoryLabel: OVERRIDE_CATEGORY_LABEL,
        sourceNote: OVERRIDE_NOTE,
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
    expect(fetchCallsWithNoteUrl(fetchSpy, OVERRIDE_URL)).toEqual([]);
  });
});
