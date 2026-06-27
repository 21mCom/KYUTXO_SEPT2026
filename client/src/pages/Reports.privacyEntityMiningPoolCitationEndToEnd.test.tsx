// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for the last remaining direct
// (hop-1) ENTITY_* finding with no end-to-end test: ENTITY_MINING_POOL.
//
// Reports.privacyCitationRenderEndToEnd.test.tsx already proves the ENTITY_*
// citation pipeline for the EXCHANGE category,
// Reports.privacyEntityScamDarknetCitationEndToEnd.test.tsx proves it for the
// two CRITICAL categories (ENTITY_SCAM / ENTITY_DARKNET), and
// Reports.privacyEntityGamblingMixerP2PCitationEndToEnd.test.tsx proves it for
// gambling (MEDIUM), mixer (LOW), and p2p-exchange (LOW). The one direct
// ENTITY_* category still uncovered is mining-pool (LOW). It flows through the
// SAME category-driven citation code (categoryFindingType + categorySeverity +
// ENTITY_CATEGORY_LABELS) as every other entity finding, so a category-specific
// mapping mistake — a wrong finding type, a wrong categoryLabel ("Mining Pool"),
// or a dropped sourceNote — would strip the evidence from mining-pool findings
// with no existing test catching it.
//
// This test closes that gap. It seeds one owned→entity DIRECT contact:
//   OWNED_POOL → POOL_ENTITY (ENTITY_MINING_POOL, LOW)
// Run through the REAL runPrivacyAudit(), this produces an ENTITY_MINING_POOL
// finding. We then drive that real audit output — never a hand-built mock
// finding — all the way to:
//   - the on-screen Privacy Audit findings UI (PrivacyAuditReportPanel), and
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport),
// asserting the finding's citation (name, "Mining Pool" category label, address,
// sourceNote) renders on every surface. The sourceNote embeds a URL: on screen
// it must render as an informational link (opened only on explicit click); in
// the JSON and PDF exports it must appear verbatim as plain text, never wrapped
// in an anchor (offline-first — citation URLs are never fetched).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import { db } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import {
  runPrivacyAudit,
  type EntityCitation,
  type PrivacyFinding,
  type PrivacyFindingType,
  type PrivacySeverity,
} from "@/lib/privacy-audit";
import {
  setActiveEntityList,
  resetActiveEntityList,
  type EntityEntry,
} from "@/lib/privacy-entity-list";
import {
  buildPrivacyReport,
  type ExportScope,
  type ExportedFinding,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";

// The panel reads address records via getRecordsPageByTypeIdReverseKeyset to
// build the audit's address list. Stub just that one read to return the owned
// address — the audit itself (runPrivacyAudit, real) reads the seeded
// participants/transactions straight from Dexie, so the citation it produces
// is genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      // Inlined (not the OWNED_* const) so the hoisted mock factory never
      // touches a not-yet-initialized top-level binding.
      { id: 1, inputString: "bc1qentitypoolowned0000000000000000000000aa", owner: undefined, walletName: undefined },
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

// One DIRECT (hop-1) contact: an owned address pays straight to a known
// mining-pool entity address. Non-round amounts keep other heuristics from
// muddying the finding under test.
const OWNED_POOL = "bc1qentitypoolowned0000000000000000000000aa";
const POOL_ENTITY = "bc1qentitypooltarget000000000000000000000ee";

const TX_POOL = "1111111111111111111111111111111111111111111111111111111111111111";

// sourceNote that embeds a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const POOL_URL = "https://www.walletexplorer.com/address/mining-pool-direct-example";
const POOL_SOURCE_NOTE = `WalletExplorer.com mining-pool service clustering — ${POOL_URL}`;
const POOL_NAME = "Test Direct Mining Pool";
// detectEntityContacts derives this from ENTITY_CATEGORY_LABELS[mining-pool].
const POOL_CATEGORY_LABEL = "Mining Pool";

const TYPE: PrivacyFindingType = "ENTITY_MINING_POOL";
const SEVERITY: PrivacySeverity = "LOW";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

/** OWNED → ENTITY in a single transaction (ENTITY is a direct, hop-1 contact). */
async function seedDirectContact(
  txid: string,
  owned: string,
  entity: string,
): Promise<void> {
  await addTransaction(
    { txid, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
    { skipNotification: true },
  );
  await addParticipant(
    { txid, role: "input", address: owned, amount: 250_123, vout: 0 },
    { skipNotification: true },
  );
  await addParticipant(
    { txid, role: "output", address: entity, amount: 199_111, vout: 0 },
    { skipNotification: true },
  );
}

function getCitations(details: Record<string, unknown>): EntityCitation[] {
  return (details.citations as EntityCitation[]) ?? [];
}

/** The real audit's direct entity finding of the given type and severity. */
function findDirectEntity(
  findings: PrivacyFinding[],
  type: PrivacyFindingType,
  severity: PrivacySeverity,
): PrivacyFinding {
  const f = findings.find((x) => x.type === type);
  expect(f, `expected a direct ${type} finding`).toBeTruthy();
  expect(f!.severity).toBe(severity);
  return f!;
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await seedDirectContact(TX_POOL, OWNED_POOL, POOL_ENTITY);

  const entries: EntityEntry[] = [
    { address: POOL_ENTITY, name: POOL_NAME, category: "mining-pool", sourceNote: POOL_SOURCE_NOTE },
  ];
  setActiveEntityList(entries);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  resetActiveEntityList();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
});

const { PrivacyAuditReportPanel } = await import("./Reports");

const OWNED_ADDRESSES = [OWNED_POOL];

/** Render the panel and run the REAL audit by clicking Generate. */
async function renderPanelWithRealAudit() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

/**
 * Find the on-screen finding card for the direct finding of the given type and
 * read its single citation row.
 */
function readDirectCitationRow(
  container: HTMLElement,
  type: PrivacyFindingType,
): {
  name: string;
  category: string;
  address: string;
  sourceCell: HTMLElement;
} {
  const card = container.querySelector<HTMLElement>(
    `[data-finding-type="${type}"]`,
  );
  expect(card, `expected an on-screen ${type} finding card`).toBeTruthy();

  const rows = Array.from(
    card!.querySelectorAll<HTMLElement>('[data-testid^="row-privacy-citation-"]'),
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

describe("ENTITY_MINING_POOL citations carry their source evidence end-to-end from the real audit", () => {
  it("the real audit produces a direct finding carrying the entity citation", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);

    const finding = findDirectEntity(result.findings, TYPE, SEVERITY);
    const citations = getCitations(finding.details);
    expect(citations).toEqual([
      { name: POOL_NAME, address: POOL_ENTITY, categoryLabel: POOL_CATEGORY_LABEL, sourceNote: POOL_SOURCE_NOTE },
    ]);
  });

  it("surfaces the citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const row = readDirectCitationRow(container, TYPE);
    expect(row.name).toBe(POOL_NAME);
    expect(row.category).toBe(POOL_CATEGORY_LABEL);
    expect(row.address).toBe(POOL_ENTITY);
    expect(row.sourceCell.textContent).toContain(POOL_SOURCE_NOTE);
  });

  it("renders the citation sourceNote URL as an informational link (never auto-fetched)", async () => {
    const { container } = await renderPanelWithRealAudit();

    const { sourceCell } = readDirectCitationRow(container, TYPE);
    // The URL is visible verbatim within the surrounding note text.
    expect(sourceCell.textContent).toContain(POOL_URL);

    // renderSourceNote turns the URL into an anchor that only navigates on an
    // explicit user click — it is shown for reference, not fetched at render.
    const anchor = sourceCell.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe(POOL_URL);
  });

  it("serializes the direct entity citation into the JSON export with the URL as plain text", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);

    // Sanity: the real audit produced the finding with its citation.
    findDirectEntity(result.findings, TYPE, SEVERITY);

    // Round-trip through JSON.stringify so we assert the actual serialized
    // shape the exported .json download carries — not the in-memory object.
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
    ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

    const exported = [...report.findings, ...report.warnings].find(
      (f) => f.type === TYPE,
    );
    expect(exported).toBeTruthy();
    expect(exported!.severity).toBe(SEVERITY);
    expect(exported!.citations).toEqual([
      { name: POOL_NAME, address: POOL_ENTITY, categoryLabel: POOL_CATEGORY_LABEL, sourceNote: POOL_SOURCE_NOTE },
    ]);
    // The URL survives serialization verbatim — JSON is data, not markup.
    expect(exported!.citations![0].sourceNote).toContain(POOL_URL);
  });

  it("renders the direct entity citation into the printable PDF/HTML export with the URL as plain text", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);
    findDirectEntity(result.findings, TYPE, SEVERITY);

    const html = buildPrintableReport(result, SCOPE, FIXED_NOW);

    // Every citation field reaches the printable report.
    expect(html).toContain(POOL_NAME);
    expect(html).toContain(POOL_CATEGORY_LABEL);
    expect(html).toContain(POOL_ENTITY);
    expect(html).toContain(POOL_SOURCE_NOTE);

    // The URL appears verbatim and is NEVER wrapped in an anchor in the export
    // (offline-first — printable citation URLs are reference text, not links).
    expect(html).toContain(POOL_URL);
    expect(html).not.toContain(`href="${POOL_URL}"`);
  });
});
