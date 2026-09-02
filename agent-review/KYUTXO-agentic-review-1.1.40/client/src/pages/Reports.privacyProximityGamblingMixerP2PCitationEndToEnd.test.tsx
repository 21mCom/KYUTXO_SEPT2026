// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for the remaining indirect
// (proximity) findings: PROXIMITY_GAMBLING, PROXIMITY_MIXER, and PROXIMITY_P2P.
//
// Reports.privacyProximityCitationRenderEndToEnd.test.tsx already proves the
// PROXIMITY_* citation pipeline for the EXCHANGE category, and
// Reports.privacyProximityScamDarknetCitationEndToEnd.test.tsx proves it for
// the two highest-stakes categories (PROXIMITY_SCAM / PROXIMITY_DARKNET). But
// the lower-stakes proximity categories — gambling, mixer, and p2p-exchange —
// had no end-to-end coverage that their category label and sourceNote survive
// to the on-screen panel, the JSON export, and the printable PDF. They flow
// through the SAME category-driven citation code (detectEntityProximity's
// PROXIMITY_CATEGORY_FINDING_TYPE + ENTITY_CATEGORY_LABELS) as the high-stakes
// findings, so a category-specific mapping mistake — a wrong finding type, a
// wrong categoryLabel ("Gambling" / "Mixer / CoinJoin Service" / "P2P
// Exchange"), or a dropped sourceNote — would strip the evidence from these
// findings with no existing test catching it.
//
// This test closes that gap. It seeds three independent 2-hop chains of owned
// addresses (the riskiest indirect distance → HIGH severity), each ending at a
// known entity address (each link is its own transaction):
//   OWNED_GAMB → MID_GAMB → GAMB_ENTITY (PROXIMITY_GAMBLING, hop 2, HIGH)
//   OWNED_MIX  → MID_MIX  → MIX_ENTITY  (PROXIMITY_MIXER,    hop 2, HIGH)
//   OWNED_P2P  → MID_P2P  → P2P_ENTITY  (PROXIMITY_P2P,      hop 2, HIGH)
// Run through the REAL runPrivacyAudit(), this produces a PROXIMITY_GAMBLING, a
// PROXIMITY_MIXER, and a PROXIMITY_P2P finding. We then drive that real audit
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
// owned address list via getRecordsPageByTypeIdReverseKeyset — we return all six
// owned addresses so the BFS can walk OWNED_* → MID_* → ENTITY. The audit itself
// reads the seeded participants/transactions straight from Dexie, so the
// proximity findings (and their citations) it produces are genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      // Inlined (not the OWNED_*/MID_* consts) so the hoisted mock factory never
      // touches a not-yet-initialized top-level binding.
      { id: 6, inputString: "bc1qproxgambowned00000000000000000000000aa", owner: undefined, walletName: undefined },
      { id: 5, inputString: "bc1qproxgambmid0000000000000000000000000bb", owner: undefined, walletName: undefined },
      { id: 4, inputString: "bc1qproxmixrowned00000000000000000000000dd", owner: undefined, walletName: undefined },
      { id: 3, inputString: "bc1qproxmixrmid0000000000000000000000000ee", owner: undefined, walletName: undefined },
      { id: 2, inputString: "bc1qproxptpeowned00000000000000000000000gg", owner: undefined, walletName: undefined },
      { id: 1, inputString: "bc1qproxptpemid0000000000000000000000000hh", owner: undefined, walletName: undefined },
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

// Three independent 2-hop chains of owned addresses, each ending at a known
// entity address. 2 hops is the closest indirect distance → HIGH severity.
const OWNED_GAMB = "bc1qproxgambowned00000000000000000000000aa";
const MID_GAMB = "bc1qproxgambmid0000000000000000000000000bb";
const GAMB_ENTITY = "bc1qproxgambentity000000000000000000000cc";

const OWNED_MIX = "bc1qproxmixrowned00000000000000000000000dd";
const MID_MIX = "bc1qproxmixrmid0000000000000000000000000ee";
const MIX_ENTITY = "bc1qproxmixrentity000000000000000000000ff";

const OWNED_P2P = "bc1qproxptpeowned00000000000000000000000gg";
const MID_P2P = "bc1qproxptpemid0000000000000000000000000hh";
const P2P_ENTITY = "bc1qproxptpeentity000000000000000000000ii";

const TX_GAMB_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TX_GAMB_2 = "2222222222222222222222222222222222222222222222222222222222222222";
const TX_MIX_1 = "3333333333333333333333333333333333333333333333333333333333333333";
const TX_MIX_2 = "4444444444444444444444444444444444444444444444444444444444444444";
const TX_P2P_1 = "5555555555555555555555555555555555555555555555555555555555555555";
const TX_P2P_2 = "6666666666666666666666666666666666666666666666666666666666666666";

// sourceNotes that embed a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const GAMB_URL = "https://www.walletexplorer.com/address/gambling-proximity-example";
const GAMB_SOURCE_NOTE = `WalletExplorer.com gambling service clustering — ${GAMB_URL}`;
const GAMB_NAME = "Test Proximity Gambling";
// detectEntityProximity derives this from ENTITY_CATEGORY_LABELS[gambling].
const GAMB_CATEGORY_LABEL = "Gambling";

const MIX_URL = "https://graphsense.example.org/tagpack/mixer-proximity-example";
const MIX_SOURCE_NOTE = `GraphSense TagPack mixer attribution — ${MIX_URL}`;
const MIX_NAME = "Test Proximity Mixer";
// detectEntityProximity derives this from ENTITY_CATEGORY_LABELS[mixer].
const MIX_CATEGORY_LABEL = "Mixer / CoinJoin Service";

const P2P_URL = "https://www.walletexplorer.com/address/p2p-proximity-example";
const P2P_SOURCE_NOTE = `WalletExplorer.com peer-to-peer exchange clustering — ${P2P_URL}`;
const P2P_NAME = "Test Proximity P2P";
// detectEntityProximity derives this from ENTITY_CATEGORY_LABELS[p2p-exchange].
const P2P_CATEGORY_LABEL = "P2P Exchange";

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
  await seedTwoHopChain(TX_GAMB_1, TX_GAMB_2, OWNED_GAMB, MID_GAMB, GAMB_ENTITY);
  await seedTwoHopChain(TX_MIX_1, TX_MIX_2, OWNED_MIX, MID_MIX, MIX_ENTITY);
  await seedTwoHopChain(TX_P2P_1, TX_P2P_2, OWNED_P2P, MID_P2P, P2P_ENTITY);

  const entries: EntityEntry[] = [
    { address: GAMB_ENTITY, name: GAMB_NAME, category: "gambling", sourceNote: GAMB_SOURCE_NOTE },
    { address: MIX_ENTITY, name: MIX_NAME, category: "mixer", sourceNote: MIX_SOURCE_NOTE },
    { address: P2P_ENTITY, name: P2P_NAME, category: "p2p-exchange", sourceNote: P2P_SOURCE_NOTE },
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

const OWNED_ADDRESSES = [
  OWNED_GAMB,
  MID_GAMB,
  OWNED_MIX,
  MID_MIX,
  OWNED_P2P,
  MID_P2P,
];

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
    label: "gambling",
    type: "PROXIMITY_GAMBLING",
    name: GAMB_NAME,
    categoryLabel: GAMB_CATEGORY_LABEL,
    address: GAMB_ENTITY,
    sourceNote: GAMB_SOURCE_NOTE,
    url: GAMB_URL,
  },
  {
    label: "mixer",
    type: "PROXIMITY_MIXER",
    name: MIX_NAME,
    categoryLabel: MIX_CATEGORY_LABEL,
    address: MIX_ENTITY,
    sourceNote: MIX_SOURCE_NOTE,
    url: MIX_URL,
  },
  {
    label: "p2p",
    type: "PROXIMITY_P2P",
    name: P2P_NAME,
    categoryLabel: P2P_CATEGORY_LABEL,
    address: P2P_ENTITY,
    sourceNote: P2P_SOURCE_NOTE,
    url: P2P_URL,
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

    it("uses the standard proximity correction wording naming the category", async () => {
      const result = await runPrivacyAudit(OWNED_ADDRESSES);
      const finding = findHop2Proximity(result.findings, type);
      // The non-scam/darknet proximity correction names the category label and
      // explains the on-chain linkage these indirect contacts create.
      expect(finding.correction).toContain(categoryLabel);
      expect(finding.correction).toContain("on-chain linkage");
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
