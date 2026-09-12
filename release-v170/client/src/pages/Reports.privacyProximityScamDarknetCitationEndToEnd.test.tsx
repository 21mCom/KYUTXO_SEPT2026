// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for the highest-stakes indirect
// findings: PROXIMITY_SCAM and PROXIMITY_DARKNET.
//
// Reports.privacyProximityCitationRenderEndToEnd.test.tsx already proves the
// PROXIMITY_* citation pipeline for the EXCHANGE category (a hop-4 LOW
// PROXIMITY_EXCHANGE finding). But scam and darknet proximity are the findings
// a source-of-funds review leans on most heavily — detectEntityProximity even
// gives them distinct, sterner correction wording. They flow through the SAME
// category-driven citation code (PROXIMITY_CATEGORY_FINDING_TYPE +
// ENTITY_CATEGORY_LABELS), so a category-specific mapping mistake — a wrong
// finding type, a wrong categoryLabel ("Scam / Fraud" / "Darknet Market"), or a
// dropped sourceNote — would strip the evidence from exactly the findings that
// most need to be defensible, with no existing test catching it.
//
// This test closes that gap. It seeds two independent 2-hop chains of owned
// addresses (the riskiest indirect distance → HIGH severity):
//   OWNED_SCAM → MID_SCAM → SCAM_ENTITY      (PROXIMITY_SCAM,    hop 2, HIGH)
//   OWNED_DARK → MID_DARK → DARKNET_ENTITY   (PROXIMITY_DARKNET, hop 2, HIGH)
// (each link is its own transaction). Run through the REAL runPrivacyAudit(),
// this produces a PROXIMITY_SCAM and a PROXIMITY_DARKNET finding. We then drive
// that real audit output — never a hand-built mock finding — all the way to:
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

import {
  addTransaction,
  addParticipant,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { clearAllRecords } from "@/lib/data/record-crud";
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

// Proximity requires the intermediate transactions to be in the loaded audit
// graph, and buildAuditContext only loads transactions that involve a user
// address. So every link in each chain is an owned address: the panel reads the
// owned address list via getRecordsPageByTypeIdReverseKeyset — we return all
// four owned addresses so the BFS can walk OWNED_* → MID_* → ENTITY. The audit
// itself reads the seeded participants/transactions straight from Dexie, so the
// proximity findings (and their citations) it produces are genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      // Inlined (not the OWNED_*/MID_* consts) so the hoisted mock factory never
      // touches a not-yet-initialized top-level binding.
      { id: 4, inputString: "bc1qproxscamowned00000000000000000000000aa", owner: undefined, walletName: undefined },
      { id: 3, inputString: "bc1qproxscammid0000000000000000000000000bb", owner: undefined, walletName: undefined },
      { id: 2, inputString: "bc1qproxdarkowned00000000000000000000000cc", owner: undefined, walletName: undefined },
      { id: 1, inputString: "bc1qproxdarkmid0000000000000000000000000dd", owner: undefined, walletName: undefined },
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

// Two independent 2-hop chains of owned addresses, each ending at a known
// entity address. 2 hops is the closest indirect distance → HIGH severity.
const OWNED_SCAM = "bc1qproxscamowned00000000000000000000000aa";
const MID_SCAM = "bc1qproxscammid0000000000000000000000000bb";
const SCAM_ENTITY = "bc1qproxscamentity000000000000000000000ee";

const OWNED_DARK = "bc1qproxdarkowned00000000000000000000000cc";
const MID_DARK = "bc1qproxdarkmid0000000000000000000000000dd";
const DARKNET_ENTITY = "bc1qproxdarkentity000000000000000000000ff";

const TX_SCAM_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TX_SCAM_2 = "2222222222222222222222222222222222222222222222222222222222222222";
const TX_DARK_1 = "3333333333333333333333333333333333333333333333333333333333333333";
const TX_DARK_2 = "4444444444444444444444444444444444444444444444444444444444444444";

// sourceNotes that embed a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const SCAM_URL = "https://sanctions.example.org/sdn/scam-proximity-example";
const SCAM_SOURCE_NOTE = `OFAC SDN sanctioned address listing — ${SCAM_URL}`;
const SCAM_NAME = "Test Proximity Scam";
// detectEntityProximity derives this from ENTITY_CATEGORY_LABELS[scam].
const SCAM_CATEGORY_LABEL = "Scam / Fraud";

const DARK_URL = "https://www.walletexplorer.com/address/darknet-proximity-example";
const DARK_SOURCE_NOTE = `WalletExplorer.com darknet market clustering — ${DARK_URL}`;
const DARK_NAME = "Test Proximity Darknet";
// detectEntityProximity derives this from ENTITY_CATEGORY_LABELS[darknet].
const DARK_CATEGORY_LABEL = "Darknet Market";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

/** OWNED → MID → ENTITY, one tx per link (so ENTITY is hop 2 from OWNED). */
async function seedTwoHopChain(
  txid1: string,
  txid2: string,
  owned: string,
  mid: string,
  entity: string,
): Promise<void> {
  const hops: Array<{ txid: string; from: string; to: string; in: number; out: number }> = [
    { txid: txid1, from: owned, to: mid, in: 510_123, out: 500_111 },
    { txid: txid2, from: mid, to: entity, in: 500_111, out: 490_222 },
  ];
  for (const h of hops) {
    await addTransaction(
      { txid: h.txid, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
      { skipNotification: true },
    );
    await addParticipant(
      { txid: h.txid, role: "input", address: h.from, amount: h.in, vout: 0 },
      { skipNotification: true },
    );
    await addParticipant(
      { txid: h.txid, role: "output", address: h.to, amount: h.out, vout: 0 },
      { skipNotification: true },
    );
  }
}

function getCitations(details: Record<string, unknown>): EntityCitation[] {
  return (details.citations as EntityCitation[]) ?? [];
}

/** The real audit's HIGH-severity hop-2 proximity finding of the given type. */
function findHop2Proximity(
  findings: PrivacyFinding[],
  type: PrivacyFindingType,
): PrivacyFinding {
  const f = findings.find(
    (x) =>
      x.type === type &&
      (x.details as { hopDistance?: number }).hopDistance === 2,
  );
  expect(f, `expected a hop-2 ${type} finding`).toBeTruthy();
  expect(f!.severity).toBe("HIGH");
  return f!;
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedTwoHopChain(TX_SCAM_1, TX_SCAM_2, OWNED_SCAM, MID_SCAM, SCAM_ENTITY);
  await seedTwoHopChain(TX_DARK_1, TX_DARK_2, OWNED_DARK, MID_DARK, DARKNET_ENTITY);

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
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
});

const { PrivacyAuditReportPanel } = await import("./Reports");

const OWNED_ADDRESSES = [OWNED_SCAM, MID_SCAM, OWNED_DARK, MID_DARK];

/** Render the panel and run the REAL audit by clicking Generate. */
async function renderPanelWithRealAudit() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

/**
 * Find the on-screen finding card for the hop-2 finding of the given type (its
 * description text names the hop distance) and read its single citation row.
 */
function readHop2CitationRow(
  container: HTMLElement,
  type: PrivacyFindingType,
): {
  name: string;
  category: string;
  address: string;
  sourceCell: HTMLElement;
} {
  const cards = Array.from(
    container.querySelectorAll<HTMLElement>(`[data-finding-type="${type}"]`),
  );
  const card = cards.find((c) => /2 transaction hop\(s\)/.test(c.textContent ?? ""));
  expect(card, `expected an on-screen hop-2 ${type} finding card`).toBeTruthy();

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
    type: "PROXIMITY_SCAM",
    name: SCAM_NAME,
    categoryLabel: SCAM_CATEGORY_LABEL,
    address: SCAM_ENTITY,
    sourceNote: SCAM_SOURCE_NOTE,
    url: SCAM_URL,
  },
  {
    label: "darknet",
    type: "PROXIMITY_DARKNET",
    name: DARK_NAME,
    categoryLabel: DARK_CATEGORY_LABEL,
    address: DARKNET_ENTITY,
    sourceNote: DARK_SOURCE_NOTE,
    url: DARK_URL,
  },
];

describe.each(CASES)(
  "PROXIMITY_$label citations carry their source evidence end-to-end from the real audit",
  ({ type, name, categoryLabel, address, sourceNote, url }) => {
    it("the real audit produces a hop-2 HIGH proximity finding carrying the entity citation", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);

      const finding = findHop2Proximity(result.findings, type);
      const citations = getCitations(finding.details);
      expect(citations).toEqual([
        { name, address, categoryLabel, sourceNote },
      ]);
    });

    it("uses the sterner scam/darknet correction wording", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);
      const finding = findHop2Proximity(result.findings, type);
      // The distinct, higher-stakes correction for scam/darknet proximity.
      expect(finding.correction).toContain("source-of-funds analysis");
      expect(finding.correction).toContain(categoryLabel);
    });

    it("surfaces the citation (name/category/address/source) in the on-screen panel", async () => {
      const { container } = await renderPanelWithRealAudit();

      const row = readHop2CitationRow(container, type);
      expect(row.name).toBe(name);
      expect(row.category).toBe(categoryLabel);
      expect(row.address).toBe(address);
      expect(row.sourceCell.textContent).toContain(sourceNote);
    });

    it("renders the citation sourceNote URL as an informational link (never auto-fetched)", async () => {
      const { container } = await renderPanelWithRealAudit();

      const { sourceCell } = readHop2CitationRow(container, type);
      // The URL is visible verbatim within the surrounding note text.
      expect(sourceCell.textContent).toContain(url);

      // renderSourceNote turns the URL into an anchor that only navigates on an
      // explicit user click — it is shown for reference, not fetched at render.
      const anchor = sourceCell.querySelector("a");
      expect(anchor).not.toBeNull();
      expect(anchor!.getAttribute("href")).toBe(url);
    });

    it("serializes the hop-2 proximity citation into the JSON export with the URL as plain text", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);

      // Sanity: the real audit produced the HIGH hop-2 finding with its citation.
      findHop2Proximity(result.findings, type);

      // Round-trip through JSON.stringify so we assert the actual serialized
      // shape the exported .json download carries — not the in-memory object.
      const report = JSON.parse(
        JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
      ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

      const exported = [...report.findings, ...report.warnings].find(
        (f) =>
          f.type === type &&
          (f.details as { hopDistance?: number }).hopDistance === 2,
      );
      expect(exported).toBeTruthy();
      expect(exported!.severity).toBe("HIGH");
      expect(exported!.citations).toEqual([
        { name, address, categoryLabel, sourceNote },
      ]);
      // The URL survives serialization verbatim — JSON is data, not markup.
      expect(exported!.citations![0].sourceNote).toContain(url);
    });

    it("renders the proximity citation into the printable PDF/HTML export with the URL as plain text", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);
      findHop2Proximity(result.findings, type);

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
