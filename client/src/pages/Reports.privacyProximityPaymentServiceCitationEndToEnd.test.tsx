// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for the PAYMENT-SERVICE proximity
// finding — the one proximity category that does NOT get its own finding type.
//
// detectEntityProximity collapses BOTH the `exchange` and `payment-service`
// entity categories onto the SAME PROXIMITY_EXCHANGE finding type (see
// PROXIMITY_CATEGORY_FINDING_TYPE in client/src/lib/privacy-audit.ts).
// Reports.privacyProximityCitationRenderEndToEnd.test.tsx already proves the
// EXCHANGE case end-to-end, but because the two categories share one finding
// type, the only thing distinguishing a payment-service proximity finding from
// an exchange one is its categoryLabel — derived from
// ENTITY_CATEGORY_LABELS["payment-service"] = "Payment Service". A label-mapping
// mistake between the two collapsed categories (e.g. always labelling the shared
// PROXIMITY_EXCHANGE type "Exchange") would mislabel payment-service findings
// with no existing test catching it.
//
// This test closes that gap. It seeds a 2-hop chain of owned addresses ending
// at a known `payment-service` entity (2 hops = the closest indirect distance →
// HIGH severity):
//   OWNED_PS → MID_PS → PS_ENTITY (PROXIMITY_EXCHANGE, hop 2, HIGH)
// Run through the REAL runPrivacyAudit(), this produces a PROXIMITY_EXCHANGE
// finding whose citation must carry the "Payment Service" category label (NOT
// "Exchange"). We then drive that real audit output — never a hand-built mock
// finding — all the way to:
//   - the on-screen Privacy Audit findings UI (PrivacyAuditReportPanel), and
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport),
// asserting the finding's citation (name, the "Payment Service" category label,
// address, sourceNote) renders on every surface. The sourceNote embeds a URL:
// on screen it must render as an informational link (opened only on explicit
// click); in the JSON and PDF exports it must appear verbatim as plain text,
// never wrapped in an anchor (offline-first — citation URLs are never fetched).

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

// Proximity requires the intermediate transactions to be in the loaded audit
// graph, and buildAuditContext only loads transactions that involve a user
// address. So every link in the chain is an owned address: the panel reads the
// owned address list via getRecordsPageByTypeIdReverseKeyset — we return both
// owned addresses so the BFS can walk OWNED_PS → MID_PS → PS_ENTITY. The audit
// itself reads the seeded participants/transactions straight from Dexie, so the
// proximity finding (and its citation) it produces is genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      // Inlined (not the OWNED_*/MID_* consts) so the hoisted mock factory never
      // touches a not-yet-initialized top-level binding.
      { id: 2, inputString: "bc1qproxpaysvcowned000000000000000000000aa", owner: undefined, walletName: undefined },
      { id: 1, inputString: "bc1qproxpaysvcmid00000000000000000000000bb", owner: undefined, walletName: undefined },
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

// A 2-hop chain of owned addresses ending at a known payment-service entity
// address. 2 hops is the closest indirect distance → HIGH severity. Non-round
// amounts keep other heuristics from muddying the findings.
const OWNED_PS = "bc1qproxpaysvcowned000000000000000000000aa";
const MID_PS = "bc1qproxpaysvcmid00000000000000000000000bb";
const PS_ENTITY = "bc1qproxpaysvcentity0000000000000000000cc";

const TX1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TX2 = "2222222222222222222222222222222222222222222222222222222222222222";

// A sourceNote that embeds a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const SOURCE_URL = "https://www.walletexplorer.com/address/payment-service-proximity-example";
const SOURCE_NOTE = `WalletExplorer.com payment-service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Test Proximity Payment Service";
// detectEntityProximity derives this from ENTITY_CATEGORY_LABELS["payment-service"].
// Crucially NOT "Exchange", even though both categories share PROXIMITY_EXCHANGE.
const ENTITY_CATEGORY_LABEL = "Payment Service";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

/** OWNED_PS → MID_PS → PS_ENTITY, one tx per link (so PS_ENTITY is hop 2). */
async function seedTwoHopChain(): Promise<void> {
  const hops: Array<{ txid: string; from: string; to: string; in: number; out: number }> = [
    { txid: TX1, from: OWNED_PS, to: MID_PS, in: 510_123, out: 500_111 },
    { txid: TX2, from: MID_PS, to: PS_ENTITY, in: 500_111, out: 490_222 },
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

/** The real audit's HIGH-severity hop-2 PROXIMITY_EXCHANGE finding. */
function findHop2Proximity(findings: PrivacyFinding[]): PrivacyFinding {
  const f = findings.find(
    (x) =>
      x.type === "PROXIMITY_EXCHANGE" &&
      (x.details as { hopDistance?: number }).hopDistance === 2,
  );
  expect(f, "expected a hop-2 PROXIMITY_EXCHANGE finding").toBeTruthy();
  expect(f!.severity).toBe("HIGH");
  return f!;
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedTwoHopChain();

  const entry: EntityEntry = {
    address: PS_ENTITY,
    name: ENTITY_NAME,
    category: "payment-service",
    sourceNote: SOURCE_NOTE,
  };
  setActiveEntityList([entry]);
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

const OWNED_ADDRESSES = [OWNED_PS, MID_PS];

/** Render the panel and run the REAL audit by clicking Generate. */
async function renderPanelWithRealAudit() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

/**
 * Find the on-screen finding card for the hop-2 PROXIMITY_EXCHANGE finding (its
 * description text names the hop distance) and read its single citation row.
 */
function readHop2CitationRow(container: HTMLElement): {
  name: string;
  category: string;
  address: string;
  sourceCell: HTMLElement;
} {
  const cards = Array.from(
    container.querySelectorAll<HTMLElement>('[data-finding-type="PROXIMITY_EXCHANGE"]'),
  );
  const card = cards.find((c) => /2 transaction hop\(s\)/.test(c.textContent ?? ""));
  expect(card, "expected an on-screen hop-2 proximity finding card").toBeTruthy();

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

describe("PROXIMITY payment-service citations carry their source evidence end-to-end from the real audit", () => {
  it("the real audit produces a hop-2 HIGH proximity finding labelled 'Payment Service' (not 'Exchange')", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);

    const finding = findHop2Proximity(result.findings);
    const citations = getCitations(finding.details);
    expect(citations).toEqual([
      {
        name: ENTITY_NAME,
        address: PS_ENTITY,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);
    // Guard the collapsed-category trap explicitly: the shared PROXIMITY_EXCHANGE
    // finding type must NOT borrow the "Exchange" label for a payment-service.
    expect(citations[0].categoryLabel).not.toBe("Exchange");
  });

  it("uses the standard proximity correction wording naming the 'Payment Service' category", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);
    const finding = findHop2Proximity(result.findings);
    expect(finding.correction).toContain(ENTITY_CATEGORY_LABEL);
    expect(finding.correction).toContain("on-chain linkage");
  });

  it("surfaces the citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const row = readHop2CitationRow(container);
    expect(row.name).toBe(ENTITY_NAME);
    expect(row.category).toBe(ENTITY_CATEGORY_LABEL);
    expect(row.address).toBe(PS_ENTITY);
    expect(row.sourceCell.textContent).toContain(SOURCE_NOTE);
  });

  it("renders the citation sourceNote URL as an informational link (never auto-fetched)", async () => {
    const { container } = await renderPanelWithRealAudit();

    const { sourceCell } = readHop2CitationRow(container);
    // The URL is visible verbatim within the surrounding note text.
    expect(sourceCell.textContent).toContain(SOURCE_URL);

    // renderSourceNote turns the URL into an anchor that only navigates on an
    // explicit user click — it is shown for reference, not fetched at render.
    const anchor = sourceCell.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe(SOURCE_URL);
  });

  it("serializes the hop-2 proximity citation into the JSON export with the 'Payment Service' label and URL as plain text", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);

    // Sanity: the real audit produced the HIGH hop-2 finding with its citation.
    findHop2Proximity(result.findings);

    // Round-trip through JSON.stringify so we assert the actual serialized
    // shape the exported .json download carries — not the in-memory object.
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
    ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

    const exported = [...report.findings, ...report.warnings].find(
      (f) =>
        f.type === "PROXIMITY_EXCHANGE" &&
        (f.details as { hopDistance?: number }).hopDistance === 2,
    );
    expect(exported).toBeTruthy();
    expect(exported!.severity).toBe("HIGH");
    expect(exported!.citations).toEqual([
      {
        name: ENTITY_NAME,
        address: PS_ENTITY,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);
    // The URL survives serialization verbatim — JSON is data, not markup.
    expect(exported!.citations![0].sourceNote).toContain(SOURCE_URL);
  });

  it("renders the proximity citation into the printable PDF/HTML export with the 'Payment Service' label and URL as plain text", async () => {
    const result = await runPrivacyAudit(OWNED_ADDRESSES);
    findHop2Proximity(result.findings);

    const html = buildPrintableReport(result, SCOPE, FIXED_NOW);

    // Every citation field reaches the printable report.
    expect(html).toContain(ENTITY_NAME);
    expect(html).toContain(ENTITY_CATEGORY_LABEL);
    expect(html).toContain(PS_ENTITY);
    expect(html).toContain(SOURCE_NOTE);

    // The URL appears verbatim and is NEVER wrapped in an anchor in the export
    // (offline-first — printable citation URLs are reference text, not links).
    expect(html).toContain(SOURCE_URL);
    expect(html).not.toContain(`href="${SOURCE_URL}"`);
  });
});
