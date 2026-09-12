// @vitest-environment jsdom
//
// End-to-end proof that a SINGLE proximity finding lists EVERY nearby risky
// entity of the same category — not just the first one discovered.
//
// detectEntityProximity groups proximity findings by (category × hop-distance)
// and accumulates MULTIPLE citations into one finding when several distinct
// entity addresses of the same category sit at the same hop distance (see the
// `existing.citations.push(citation)` / `citationAddrs` dedupe logic in
// client/src/lib/privacy-audit.ts). Every other end-to-end proximity test seeds
// exactly one entity per category, so each produces a single-citation finding —
// leaving the multi-citation accumulation path with no end-to-end coverage. A
// grouping or dedupe regression could silently drop the second entity's
// evidence (its own name / address / sourceNote) and no existing test would
// notice.
//
// This test seeds TWO independent 2-hop chains of owned addresses, each ending
// at a DISTINCT known entity of the SAME category (exchange). 2 hops is the
// closest indirect distance → HIGH severity. Because both entities share the
// category and hop distance, they collapse into ONE PROXIMITY_EXCHANGE finding
// that must carry BOTH citations:
//   OWNED_A → MID_A → EXCH_ENTITY_A (exchange, hop 2)
//   OWNED_B → MID_B → EXCH_ENTITY_B (exchange, hop 2)
// The chains never share an address or txid, so each owned address's BFS reaches
// exactly one entity; the second citation only survives if the accumulation +
// dedupe logic keeps both. We drive the REAL runPrivacyAudit() output — never a
// hand-built finding — all the way to:
//   - the on-screen Privacy Audit findings UI (PrivacyAuditReportPanel),
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport),
// asserting BOTH entities' name / category / address / sourceNote render on
// every surface. Each sourceNote embeds a URL: on screen it must render as an
// informational link (opened only on explicit click); in the JSON and PDF
// exports it must appear verbatim as plain text, never wrapped in an anchor
// (offline-first — citation URLs are never fetched).

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

// Proximity requires every intermediate transaction to be in the loaded audit
// graph, and buildAuditContext only loads transactions that involve a user
// address. So every link in each chain (owned + intermediary) is an owned
// address: the panel reads the owned address list via
// getRecordsPageByTypeIdReverseKeyset — we return all four so the BFS can walk
// OWNED_* → MID_* → ENTITY. The audit reads the seeded participants/transactions
// straight from Dexie, so the proximity finding (and its citations) it produces
// is genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      // Inlined (not the OWNED_*/MID_* consts) so the hoisted mock factory never
      // touches a not-yet-initialized top-level binding.
      { id: 4, inputString: "bc1qmultiexchaowned000000000000000000aa", owner: undefined, walletName: undefined },
      { id: 3, inputString: "bc1qmultiexchamida0000000000000000000bb", owner: undefined, walletName: undefined },
      { id: 2, inputString: "bc1qmultiexchbowned000000000000000000dd", owner: undefined, walletName: undefined },
      { id: 1, inputString: "bc1qmultiexchbmidb0000000000000000000ee", owner: undefined, walletName: undefined },
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

// Two independent 2-hop chains of owned addresses, each ending at a DISTINCT
// known exchange entity. 2 hops is the closest indirect distance → HIGH.
const OWNED_A = "bc1qmultiexchaowned000000000000000000aa";
const MID_A = "bc1qmultiexchamida0000000000000000000bb";
const EXCH_ENTITY_A = "bc1qmultiexchaentity00000000000000000cc";

const OWNED_B = "bc1qmultiexchbowned000000000000000000dd";
const MID_B = "bc1qmultiexchbmidb0000000000000000000ee";
const EXCH_ENTITY_B = "bc1qmultiexchbentity00000000000000000ff";

const TX_A_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TX_A_2 = "2222222222222222222222222222222222222222222222222222222222222222";
const TX_B_1 = "3333333333333333333333333333333333333333333333333333333333333333";
const TX_B_2 = "4444444444444444444444444444444444444444444444444444444444444444";

// detectEntityProximity derives this from ENTITY_CATEGORY_LABELS[exchange].
const EXCHANGE_LABEL = "Exchange";

// Two distinct entities, same category — each with its own name + sourceNote.
// sourceNotes embed real URLs so we can prove the URL is shown as informational
// text and is never auto-fetched on any surface.
const ENTITY_A_NAME = "Test Proximity Exchange Alpha";
const ENTITY_A_URL = "https://www.walletexplorer.com/address/exchange-proximity-alpha";
const ENTITY_A_SOURCE_NOTE = `WalletExplorer.com exchange clustering (alpha) — ${ENTITY_A_URL}`;

const ENTITY_B_NAME = "Test Proximity Exchange Bravo";
const ENTITY_B_URL = "https://graphsense.example.org/tagpack/exchange-proximity-bravo";
const ENTITY_B_SOURCE_NOTE = `GraphSense TagPack exchange attribution (bravo) — ${ENTITY_B_URL}`;

const PROXIMITY_EXCHANGE = "PROXIMITY_EXCHANGE" as const;

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

/** The real audit's single HIGH-severity hop-2 PROXIMITY_EXCHANGE finding. */
function findHop2ExchangeProximity(findings: PrivacyFinding[]): PrivacyFinding {
  const matches = findings.filter(
    (x) =>
      x.type === PROXIMITY_EXCHANGE &&
      (x.details as { hopDistance?: number }).hopDistance === 2,
  );
  // The whole point: the two same-category entities collapse into ONE finding.
  expect(matches, "expected exactly one hop-2 PROXIMITY_EXCHANGE finding").toHaveLength(1);
  expect(matches[0].severity).toBe("HIGH");
  return matches[0];
}

const EXPECTED_CITATIONS: EntityCitation[] = [
  { name: ENTITY_A_NAME, address: EXCH_ENTITY_A, categoryLabel: EXCHANGE_LABEL, sourceNote: ENTITY_A_SOURCE_NOTE },
  { name: ENTITY_B_NAME, address: EXCH_ENTITY_B, categoryLabel: EXCHANGE_LABEL, sourceNote: ENTITY_B_SOURCE_NOTE },
];

/** Order-independent comparison (BFS visits owned addresses in input order). */
function sortByAddress(citations: EntityCitation[]): EntityCitation[] {
  return [...citations].sort((a, b) => a.address.localeCompare(b.address));
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedTwoHopChain(TX_A_1, TX_A_2, OWNED_A, MID_A, EXCH_ENTITY_A);
  await seedTwoHopChain(TX_B_1, TX_B_2, OWNED_B, MID_B, EXCH_ENTITY_B);

  const entries: EntityEntry[] = [
    { address: EXCH_ENTITY_A, name: ENTITY_A_NAME, category: "exchange", sourceNote: ENTITY_A_SOURCE_NOTE },
    { address: EXCH_ENTITY_B, name: ENTITY_B_NAME, category: "exchange", sourceNote: ENTITY_B_SOURCE_NOTE },
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

const OWNED_ADDRESSES = [OWNED_A, MID_A, OWNED_B, MID_B];

/** Render the panel and run the REAL audit by clicking Generate. */
async function renderPanelWithRealAudit() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

/**
 * Find the on-screen hop-2 PROXIMITY_EXCHANGE finding card and read EVERY
 * citation row it renders, returning one descriptor per row.
 */
function readHop2CitationRows(container: HTMLElement): Array<{
  name: string;
  category: string;
  address: string;
  sourceCell: HTMLElement;
}> {
  const cards = Array.from(
    container.querySelectorAll<HTMLElement>(`[data-finding-type="${PROXIMITY_EXCHANGE}"]`),
  );
  const card = cards.find((c) => /2 transaction hop\(s\)/.test(c.textContent ?? ""));
  expect(card, "expected an on-screen hop-2 PROXIMITY_EXCHANGE finding card").toBeTruthy();

  const rows = Array.from(
    card!.querySelectorAll<HTMLElement>('[data-testid^="row-privacy-citation-"]'),
  );
  return rows.map((row) => {
    const cells = Array.from(row.querySelectorAll<HTMLElement>("td"));
    return {
      name: cells[0].textContent!.trim(),
      category: cells[1].textContent!.trim(),
      address: cells[2].textContent!.trim(),
      sourceCell: cells[3],
    };
  });
}

describe("a proximity finding lists EVERY nearby same-category entity, not just the first", () => {
  it("the real audit collapses two distinct same-category entities into ONE finding carrying BOTH citations", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);

    const finding = findHop2ExchangeProximity(result.findings);
    const citations = getCitations(finding.details);
    expect(citations).toHaveLength(2);
    expect(sortByAddress(citations)).toEqual(sortByAddress(EXPECTED_CITATIONS));

    // The two owned start addresses both contributed to the same grouped finding.
    expect(finding.addresses).toEqual(expect.arrayContaining([OWNED_A, OWNED_B]));
    // And both entity addresses are recorded on the finding details.
    expect((finding.details as { entityAddresses: string[] }).entityAddresses).toEqual(
      expect.arrayContaining([EXCH_ENTITY_A, EXCH_ENTITY_B]),
    );
  });

  it("surfaces BOTH citations (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const rows = readHop2CitationRows(container);
    expect(rows).toHaveLength(2);

    const byAddress = new Map(rows.map((r) => [r.address, r]));
    for (const expected of EXPECTED_CITATIONS) {
      const row = byAddress.get(expected.address);
      expect(row, `expected an on-screen citation row for ${expected.address}`).toBeTruthy();
      expect(row!.name).toBe(expected.name);
      expect(row!.category).toBe(expected.categoryLabel);
      expect(row!.sourceCell.textContent).toContain(expected.sourceNote);
    }
  });

  it("renders each citation's sourceNote URL as an informational link (never auto-fetched)", async () => {
    const { container } = await renderPanelWithRealAudit();

    const rows = readHop2CitationRows(container);
    const byAddress = new Map(rows.map((r) => [r.address, r]));

    for (const { address, url } of [
      { address: EXCH_ENTITY_A, url: ENTITY_A_URL },
      { address: EXCH_ENTITY_B, url: ENTITY_B_URL },
    ]) {
      const row = byAddress.get(address)!;
      // The URL is visible verbatim within the surrounding note text.
      expect(row.sourceCell.textContent).toContain(url);
      // renderSourceNote turns the URL into an anchor that only navigates on an
      // explicit user click — shown for reference, not fetched at render.
      const anchor = row.sourceCell.querySelector("a");
      expect(anchor).not.toBeNull();
      expect(anchor!.getAttribute("href")).toBe(url);
    }
  });

  it("serializes BOTH hop-2 proximity citations into the JSON export with the URLs as plain text", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);

    // Sanity: the real audit produced the single HIGH hop-2 finding.
    findHop2ExchangeProximity(result.findings);

    // Round-trip through JSON.stringify so we assert the actual serialized shape
    // the exported .json download carries — not the in-memory object.
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
    ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

    const exportedMatches = [...report.findings, ...report.warnings].filter(
      (f) =>
        f.type === PROXIMITY_EXCHANGE &&
        (f.details as { hopDistance?: number }).hopDistance === 2,
    );
    expect(exportedMatches).toHaveLength(1);
    const exported = exportedMatches[0];
    expect(exported.severity).toBe("HIGH");
    expect(exported.citations).toHaveLength(2);
    expect(sortByAddress(exported.citations!)).toEqual(sortByAddress(EXPECTED_CITATIONS));

    // Both URLs survive serialization verbatim — JSON is data, not markup.
    const serialized = sortByAddress(exported.citations!);
    expect(serialized.find((c) => c.address === EXCH_ENTITY_A)!.sourceNote).toContain(ENTITY_A_URL);
    expect(serialized.find((c) => c.address === EXCH_ENTITY_B)!.sourceNote).toContain(ENTITY_B_URL);
  });

  it("renders BOTH proximity citations into the printable PDF/HTML export with the URLs as plain text", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);
    findHop2ExchangeProximity(result.findings);

    const html = buildPrintableReport(result, SCOPE, FIXED_NOW);

    // Every field of BOTH citations reaches the printable report.
    for (const c of EXPECTED_CITATIONS) {
      expect(html).toContain(c.name);
      expect(html).toContain(c.address);
      expect(html).toContain(c.sourceNote);
    }
    expect(html).toContain(EXCHANGE_LABEL);

    // Both URLs appear verbatim and are NEVER wrapped in an anchor in the export
    // (offline-first — printable citation URLs are reference text, not links).
    for (const url of [ENTITY_A_URL, ENTITY_B_URL]) {
      expect(html).toContain(url);
      expect(html).not.toContain(`href="${url}"`);
    }
  });
});
