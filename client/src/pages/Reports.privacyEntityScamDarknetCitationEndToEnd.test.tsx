// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for the highest-stakes DIRECT
// (hop-1) findings: ENTITY_SCAM and ENTITY_DARKNET.
//
// Reports.privacyCitationRenderEndToEnd.test.tsx already proves the ENTITY_*
// citation pipeline for the EXCHANGE category (a MEDIUM ENTITY_EXCHANGE direct
// contact). And Reports.privacyProximityScamDarknetCitationEndToEnd.test.tsx
// proves the INDIRECT scam/darknet equivalents (PROXIMITY_SCAM /
// PROXIMITY_DARKNET). But the DIRECT scam/darknet findings — ENTITY_SCAM and
// ENTITY_DARKNET, emitted by detectEntityContacts — are the most severe of all
// (CRITICAL severity). They flow through the SAME category-driven citation code
// (categoryFindingType + ENTITY_CATEGORY_LABELS), so a category-specific
// mapping mistake — a wrong finding type, a wrong categoryLabel ("Scam / Fraud"
// / "Darknet Market"), or a dropped sourceNote — would strip the evidence from
// exactly the findings that most need to be defensible, with no existing test
// catching it.
//
// This test closes that gap. It seeds two independent owned→entity DIRECT
// contacts (each its own transaction):
//   OWNED_SCAM → SCAM_ENTITY      (ENTITY_SCAM,    CRITICAL)
//   OWNED_DARK → DARKNET_ENTITY   (ENTITY_DARKNET, CRITICAL)
// Run through the REAL runPrivacyAudit(), this produces an ENTITY_SCAM and an
// ENTITY_DARKNET finding. We then drive that real audit output — never a
// hand-built mock finding — all the way to:
//   - the on-screen Privacy Audit findings UI (PrivacyAuditReportPanel), and
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport),
// asserting each finding's citation (name, the correct category label, address,
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
// build the audit's address list. Stub just that one read to return the two
// owned addresses — the audit itself (runPrivacyAudit, real) reads the seeded
// participants/transactions straight from Dexie, so the citations it produces
// are genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      // Inlined (not the OWNED_* consts) so the hoisted mock factory never
      // touches a not-yet-initialized top-level binding.
      { id: 2, inputString: "bc1qentityscamowned0000000000000000000000aa", owner: undefined, walletName: undefined },
      { id: 1, inputString: "bc1qentitydarkowned0000000000000000000000bb", owner: undefined, walletName: undefined },
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

// Two independent DIRECT (hop-1) contacts: an owned address pays straight to a
// known entity address. Non-round amounts keep other heuristics from muddying
// the findings under test.
const OWNED_SCAM = "bc1qentityscamowned0000000000000000000000aa";
const SCAM_ENTITY = "bc1qentityscamtarget000000000000000000000ee";

const OWNED_DARK = "bc1qentitydarkowned0000000000000000000000bb";
const DARKNET_ENTITY = "bc1qentitydarktarget000000000000000000000ff";

const TX_SCAM = "1111111111111111111111111111111111111111111111111111111111111111";
const TX_DARK = "2222222222222222222222222222222222222222222222222222222222222222";

// sourceNotes that embed a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const SCAM_URL = "https://sanctions.example.org/sdn/scam-direct-example";
const SCAM_SOURCE_NOTE = `OFAC SDN sanctioned address listing — ${SCAM_URL}`;
const SCAM_NAME = "Test Direct Scam";
// detectEntityContacts derives this from ENTITY_CATEGORY_LABELS[scam].
const SCAM_CATEGORY_LABEL = "Scam / Fraud";

const DARK_URL = "https://www.walletexplorer.com/address/darknet-direct-example";
const DARK_SOURCE_NOTE = `WalletExplorer.com darknet market clustering — ${DARK_URL}`;
const DARK_NAME = "Test Direct Darknet";
// detectEntityContacts derives this from ENTITY_CATEGORY_LABELS[darknet].
const DARK_CATEGORY_LABEL = "Darknet Market";

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

/** The real audit's CRITICAL direct entity finding of the given type. */
function findDirectEntity(
  findings: PrivacyFinding[],
  type: PrivacyFindingType,
): PrivacyFinding {
  const f = findings.find((x) => x.type === type);
  expect(f, `expected a direct ${type} finding`).toBeTruthy();
  expect(f!.severity).toBe("CRITICAL");
  return f!;
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await seedDirectContact(TX_SCAM, OWNED_SCAM, SCAM_ENTITY);
  await seedDirectContact(TX_DARK, OWNED_DARK, DARKNET_ENTITY);

  const entries: EntityEntry[] = [
    { address: SCAM_ENTITY, name: SCAM_NAME, category: "scam", sourceNote: SCAM_SOURCE_NOTE },
    { address: DARKNET_ENTITY, name: DARK_NAME, category: "darknet", sourceNote: DARK_SOURCE_NOTE },
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

const OWNED_ADDRESSES = [OWNED_SCAM, OWNED_DARK];

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

const CASES: Array<{
  label: string;
  type: PrivacyFindingType;
  name: string;
  categoryLabel: string;
  address: string;
  sourceNote: string;
  url: string;
}> = [
  {
    label: "scam",
    type: "ENTITY_SCAM",
    name: SCAM_NAME,
    categoryLabel: SCAM_CATEGORY_LABEL,
    address: SCAM_ENTITY,
    sourceNote: SCAM_SOURCE_NOTE,
    url: SCAM_URL,
  },
  {
    label: "darknet",
    type: "ENTITY_DARKNET",
    name: DARK_NAME,
    categoryLabel: DARK_CATEGORY_LABEL,
    address: DARKNET_ENTITY,
    sourceNote: DARK_SOURCE_NOTE,
    url: DARK_URL,
  },
];

describe.each(CASES)(
  "ENTITY_$label citations carry their source evidence end-to-end from the real audit",
  ({ type, name, categoryLabel, address, sourceNote, url }) => {
    it("the real audit produces a CRITICAL direct finding carrying the entity citation", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);

      const finding = findDirectEntity(result.findings, type);
      const citations = getCitations(finding.details);
      expect(citations).toEqual([
        { name, address, categoryLabel, sourceNote },
      ]);
    });

    it("surfaces the citation (name/category/address/source) in the on-screen panel", async () => {
      const { container } = await renderPanelWithRealAudit();

      const row = readDirectCitationRow(container, type);
      expect(row.name).toBe(name);
      expect(row.category).toBe(categoryLabel);
      expect(row.address).toBe(address);
      expect(row.sourceCell.textContent).toContain(sourceNote);
    });

    it("renders the citation sourceNote URL as an informational link (never auto-fetched)", async () => {
      const { container } = await renderPanelWithRealAudit();

      const { sourceCell } = readDirectCitationRow(container, type);
      // The URL is visible verbatim within the surrounding note text.
      expect(sourceCell.textContent).toContain(url);

      // renderSourceNote turns the URL into an anchor that only navigates on an
      // explicit user click — it is shown for reference, not fetched at render.
      const anchor = sourceCell.querySelector("a");
      expect(anchor).not.toBeNull();
      expect(anchor!.getAttribute("href")).toBe(url);
    });

    it("serializes the direct entity citation into the JSON export with the URL as plain text", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);

      // Sanity: the real audit produced the CRITICAL finding with its citation.
      findDirectEntity(result.findings, type);

      // Round-trip through JSON.stringify so we assert the actual serialized
      // shape the exported .json download carries — not the in-memory object.
      const report = JSON.parse(
        JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
      ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

      const exported = [...report.findings, ...report.warnings].find(
        (f) => f.type === type,
      );
      expect(exported).toBeTruthy();
      expect(exported!.severity).toBe("CRITICAL");
      expect(exported!.citations).toEqual([
        { name, address, categoryLabel, sourceNote },
      ]);
      // The URL survives serialization verbatim — JSON is data, not markup.
      expect(exported!.citations![0].sourceNote).toContain(url);
    });

    it("renders the direct entity citation into the printable PDF/HTML export with the URL as plain text", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);
      findDirectEntity(result.findings, type);

      const html = buildPrintableReport(result, SCOPE, FIXED_NOW);

      // Every citation field reaches the printable report.
      expect(html).toContain(name);
      expect(html).toContain(categoryLabel);
      expect(html).toContain(address);
      expect(html).toContain(sourceNote);

      // The URL appears verbatim and is NEVER wrapped in an anchor in the export
      // (offline-first — printable citation URLs are reference text, not links).
      expect(html).toContain(url);
      expect(html).not.toContain(`href="${url}"`);
    });
  },
);
