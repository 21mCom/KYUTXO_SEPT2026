// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for the remaining direct (hop-1)
// ENTITY_* findings: ENTITY_GAMBLING, ENTITY_MIXER, and ENTITY_P2P.
//
// Reports.privacyCitationRenderEndToEnd.test.tsx already proves the ENTITY_*
// citation pipeline for the EXCHANGE category, and
// Reports.privacyEntityScamDarknetCitationEndToEnd.test.tsx proves it for the
// two CRITICAL categories (ENTITY_SCAM / ENTITY_DARKNET). But the lower-stakes
// direct categories — gambling (MEDIUM), mixer (LOW), and p2p-exchange (LOW) —
// had no end-to-end coverage that their category label and sourceNote survive
// to the on-screen panel, the JSON export, and the printable PDF. They flow
// through the SAME category-driven citation code (categoryFindingType +
// ENTITY_CATEGORY_LABELS) as the high-stakes findings, so a category-specific
// mapping mistake — a wrong finding type, a wrong categoryLabel ("Gambling" /
// "Mixer / CoinJoin Service" / "P2P Exchange"), or a dropped sourceNote — would
// strip the evidence from these findings with no existing test catching it.
//
// This test closes that gap. It seeds three independent owned→entity DIRECT
// contacts (each its own transaction):
//   OWNED_GAMBLE → GAMBLING_ENTITY (ENTITY_GAMBLING, MEDIUM)
//   OWNED_MIX    → MIXER_ENTITY    (ENTITY_MIXER,    LOW)
//   OWNED_P2P    → P2P_ENTITY      (ENTITY_P2P,      LOW)
// Run through the REAL runPrivacyAudit(), this produces an ENTITY_GAMBLING, an
// ENTITY_MIXER, and an ENTITY_P2P finding. We then drive that real audit
// output — never a hand-built mock finding — all the way to:
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
// build the audit's address list. Stub just that one read to return the three
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
      { id: 3, inputString: "bc1qentitygambleowned00000000000000000000aa", owner: undefined, walletName: undefined },
      { id: 2, inputString: "bc1qentitymixerowned000000000000000000000bb", owner: undefined, walletName: undefined },
      { id: 1, inputString: "bc1qentityp2powned00000000000000000000000cc", owner: undefined, walletName: undefined },
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

// Three independent DIRECT (hop-1) contacts: an owned address pays straight to a
// known entity address. Non-round amounts keep other heuristics from muddying
// the findings under test.
const OWNED_GAMBLE = "bc1qentitygambleowned00000000000000000000aa";
const GAMBLING_ENTITY = "bc1qentitygambletarget0000000000000000000ee";

const OWNED_MIX = "bc1qentitymixerowned000000000000000000000bb";
const MIXER_ENTITY = "bc1qentitymixertarget00000000000000000000ff";

const OWNED_P2P = "bc1qentityp2powned00000000000000000000000cc";
const P2P_ENTITY = "bc1qentityp2ptarget0000000000000000000000gg";

const TX_GAMBLE = "1111111111111111111111111111111111111111111111111111111111111111";
const TX_MIX = "2222222222222222222222222222222222222222222222222222222222222222";
const TX_P2P = "3333333333333333333333333333333333333333333333333333333333333333";

// sourceNotes that embed a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const GAMBLE_URL = "https://www.walletexplorer.com/address/gambling-direct-example";
const GAMBLE_SOURCE_NOTE = `WalletExplorer.com gambling service clustering — ${GAMBLE_URL}`;
const GAMBLE_NAME = "Test Direct Gambling";
// detectEntityContacts derives this from ENTITY_CATEGORY_LABELS[gambling].
const GAMBLE_CATEGORY_LABEL = "Gambling";

const MIXER_URL = "https://graphsense.example.org/tagpacks/mixer-direct-example";
const MIXER_SOURCE_NOTE = `GraphSense TagPacks mixer attribution — ${MIXER_URL}`;
const MIXER_NAME = "Test Direct Mixer";
// detectEntityContacts derives this from ENTITY_CATEGORY_LABELS[mixer].
const MIXER_CATEGORY_LABEL = "Mixer / CoinJoin Service";

const P2P_URL = "https://www.walletexplorer.com/address/p2p-direct-example";
const P2P_SOURCE_NOTE = `WalletExplorer.com P2P exchange clustering — ${P2P_URL}`;
const P2P_NAME = "Test Direct P2P";
// detectEntityContacts derives this from ENTITY_CATEGORY_LABELS[p2p-exchange].
const P2P_CATEGORY_LABEL = "P2P Exchange";

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
  await seedDirectContact(TX_GAMBLE, OWNED_GAMBLE, GAMBLING_ENTITY);
  await seedDirectContact(TX_MIX, OWNED_MIX, MIXER_ENTITY);
  await seedDirectContact(TX_P2P, OWNED_P2P, P2P_ENTITY);

  const entries: EntityEntry[] = [
    { address: GAMBLING_ENTITY, name: GAMBLE_NAME, category: "gambling", sourceNote: GAMBLE_SOURCE_NOTE },
    { address: MIXER_ENTITY, name: MIXER_NAME, category: "mixer", sourceNote: MIXER_SOURCE_NOTE },
    { address: P2P_ENTITY, name: P2P_NAME, category: "p2p-exchange", sourceNote: P2P_SOURCE_NOTE },
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

const OWNED_ADDRESSES = [OWNED_GAMBLE, OWNED_MIX, OWNED_P2P];

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
  severity: PrivacySeverity;
  name: string;
  categoryLabel: string;
  address: string;
  sourceNote: string;
  url: string;
}> = [
  {
    label: "gambling",
    type: "ENTITY_GAMBLING",
    severity: "MEDIUM",
    name: GAMBLE_NAME,
    categoryLabel: GAMBLE_CATEGORY_LABEL,
    address: GAMBLING_ENTITY,
    sourceNote: GAMBLE_SOURCE_NOTE,
    url: GAMBLE_URL,
  },
  {
    label: "mixer",
    type: "ENTITY_MIXER",
    severity: "LOW",
    name: MIXER_NAME,
    categoryLabel: MIXER_CATEGORY_LABEL,
    address: MIXER_ENTITY,
    sourceNote: MIXER_SOURCE_NOTE,
    url: MIXER_URL,
  },
  {
    label: "p2p",
    type: "ENTITY_P2P",
    severity: "LOW",
    name: P2P_NAME,
    categoryLabel: P2P_CATEGORY_LABEL,
    address: P2P_ENTITY,
    sourceNote: P2P_SOURCE_NOTE,
    url: P2P_URL,
  },
];

describe.each(CASES)(
  "ENTITY_$label citations carry their source evidence end-to-end from the real audit",
  ({ type, severity, name, categoryLabel, address, sourceNote, url }) => {
    it("the real audit produces a direct finding carrying the entity citation", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);

      const finding = findDirectEntity(result.findings, type, severity);
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

      // Sanity: the real audit produced the finding with its citation.
      findDirectEntity(result.findings, type, severity);

      // Round-trip through JSON.stringify so we assert the actual serialized
      // shape the exported .json download carries — not the in-memory object.
      const report = JSON.parse(
        JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
      ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

      const exported = [...report.findings, ...report.warnings].find(
        (f) => f.type === type,
      );
      expect(exported).toBeTruthy();
      expect(exported!.severity).toBe(severity);
      expect(exported!.citations).toEqual([
        { name, address, categoryLabel, sourceNote },
      ]);
      // The URL survives serialization verbatim — JSON is data, not markup.
      expect(exported!.citations![0].sourceNote).toContain(url);
    });

    it("renders the direct entity citation into the printable PDF/HTML export with the URL as plain text", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);
      findDirectEntity(result.findings, type, severity);

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
