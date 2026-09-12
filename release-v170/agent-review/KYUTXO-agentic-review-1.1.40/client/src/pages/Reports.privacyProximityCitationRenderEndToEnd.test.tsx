// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for PROXIMITY_* (indirect)
// source citations.
//
// Reports.privacyCitationRenderEndToEnd.test.tsx proves that DIRECT (hop-1)
// ENTITY_* findings carry their attribution citations all the way to the three
// surfaces users read. But detectEntityProximity emits PROXIMITY_* findings for
// entities that are 2–4 transaction hops away from an owned address (severity
// decreasing by hop: HIGH/MEDIUM/LOW), and those indirect findings ALSO build
// citations from the public entity list. A rendering/serialization regression
// specific to the PROXIMITY_* prefix — e.g. a citation gate that only matched
// "ENTITY_" — would silently drop those citations from the panel and exports
// with no test catching it.
//
// This test closes that gap. It seeds real Dexie records + participants
// (fake-indexeddb) forming a chain of owned addresses:
//   OWNED_FAR → MID_A → MID_B → MID_C → ENTITY_ADDR
// (each link is its own transaction). Run through the REAL runPrivacyAudit(),
// this produces a PROXIMITY_EXCHANGE finding for ENTITY_ADDR. Because every link
// is owned, detectEntityProximity reaches the entity from several owned
// addresses at increasing hop distances, and the audit de-duplicates each entity
// address to its CLOSEST owned hop: here MID_B is 2 transaction hops away, so the
// surviving proximity finding is hopDistance 2 with HIGH severity (the hop-1
// neighbour MID_C is a direct ENTITY_EXCHANGE, not a proximity finding; the
// farther hop-3/hop-4 paths to the same entity are collapsed by the dedup). The
// LOW-severity hop-4 tier is exercised directly at the engine level in
// privacy-audit.proximity.test.ts. What matters here is the PROXIMITY_* prefix:
// any citation-rendering regression specific to that prefix would surface on this
// hop-2 finding exactly as it would on a hop-4 one. We then drive that real audit
// output — never a hand-built mock finding — all the way to:
//   - the on-screen Privacy Audit findings UI (PrivacyAuditReportPanel), and
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport),
// asserting the finding's citation (name, categoryLabel, address, sourceNote)
// renders on every surface. The sourceNote embeds a URL: on screen it must
// render as an informational link (opened only on explicit click); in the JSON
// and PDF exports it must appear verbatim as plain text, never wrapped in an
// anchor (offline-first — citation URLs are never fetched).

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
  buildPrivacyTextReport,
  type ExportScope,
  type ExportedFinding,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";

// Proximity requires the intermediate transactions to be in the loaded audit
// graph, and buildAuditContext only loads transactions that involve a user
// address. So every link in the chain is an owned address: the panel reads the
// owned address list via getRecordsPageByTypeIdReverseKeyset — we return all
// four owned addresses so the BFS can walk OWNED_FAR → … → ENTITY_ADDR. The
// audit itself reads the seeded participants/transactions straight from Dexie,
// so the proximity finding (and its citation) it produces is genuine, not
// mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      // Inlined (not the OWNED_* consts) so the hoisted mock factory never
      // touches a not-yet-initialized top-level binding.
      { id: 4, inputString: "bc1qproxfar000000000000000000000000000000aa", owner: undefined, walletName: undefined },
      { id: 3, inputString: "bc1qproxmida00000000000000000000000000000bb", owner: undefined, walletName: undefined },
      { id: 2, inputString: "bc1qproxmidb00000000000000000000000000000cc", owner: undefined, walletName: undefined },
      { id: 1, inputString: "bc1qproxmidc00000000000000000000000000000dd", owner: undefined, walletName: undefined },
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

// A chain of owned addresses ending at a known entity address. Every link is
// owned, so the audit reaches ENTITY_ADDR from several owned addresses and keeps
// only the closest-hop proximity finding (MID_B, 2 hops → HIGH-severity
// PROXIMITY_EXCHANGE). Non-round amounts keep other heuristics from muddying the
// findings.
const OWNED_FAR = "bc1qproxfar000000000000000000000000000000aa";
const MID_A = "bc1qproxmida00000000000000000000000000000bb";
const MID_B = "bc1qproxmidb00000000000000000000000000000cc";
const MID_C = "bc1qproxmidc00000000000000000000000000000dd";
const ENTITY_ADDR = "bc1qproxentity0000000000000000000000000000ee";

const TX1 = "1111111111111111111111111111111111111111111111111111111111111111";
const TX2 = "2222222222222222222222222222222222222222222222222222222222222222";
const TX3 = "3333333333333333333333333333333333333333333333333333333333333333";
const TX4 = "4444444444444444444444444444444444444444444444444444444444444444";

// A sourceNote that embeds a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const SOURCE_URL = "https://www.walletexplorer.com/address/proximity-example";
const SOURCE_NOTE = `WalletExplorer.com service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Test Proximity Exchange";
const ENTITY_CATEGORY_LABEL = "Exchange";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

/** OWNED_FAR → MID_A → MID_B → MID_C → ENTITY_ADDR, one tx per link. */
async function seedProximityChain(): Promise<void> {
  const hops: Array<{ txid: string; from: string; to: string; in: number; out: number }> = [
    { txid: TX1, from: OWNED_FAR, to: MID_A, in: 510_123, out: 500_111 },
    { txid: TX2, from: MID_A, to: MID_B, in: 500_111, out: 490_222 },
    { txid: TX3, from: MID_B, to: MID_C, in: 490_222, out: 480_333 },
    { txid: TX4, from: MID_C, to: ENTITY_ADDR, in: 480_333, out: 470_444 },
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

/** The real audit's HIGH-severity hop-2 (closest-hop) PROXIMITY_EXCHANGE finding. */
function findProximityFinding(findings: PrivacyFinding[]): PrivacyFinding {
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
  await seedProximityChain();

  const entry: EntityEntry = {
    address: ENTITY_ADDR,
    name: ENTITY_NAME,
    category: "exchange",
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

/** Render the panel and run the REAL audit by clicking Generate. */
async function renderPanelWithRealAudit() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

/**
 * Find the on-screen finding card for the hop-2 HIGH proximity finding (its
 * description text names the hop distance) and read its single citation row.
 */
function readProximityCitationRow(container: HTMLElement): {
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

describe("PROXIMITY_* citations render end-to-end from the real audit", () => {
  it("the real audit produces a hop-2 HIGH proximity finding carrying the entity citation", async () => {
    const result = await runPrivacyAudit([OWNED_FAR, MID_A, MID_B, MID_C]);

    const finding = findProximityFinding(result.findings);
    const citations = getCitations(finding.details);
    expect(citations).toEqual([
      {
        name: ENTITY_NAME,
        address: ENTITY_ADDR,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);
  });

  it("surfaces the citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const row = readProximityCitationRow(container);
    expect(row.name).toBe(ENTITY_NAME);
    expect(row.category).toBe(ENTITY_CATEGORY_LABEL);
    expect(row.address).toBe(ENTITY_ADDR);
    expect(row.sourceCell.textContent).toContain(SOURCE_NOTE);
  });

  it("renders the citation sourceNote URL as an informational link (never auto-fetched)", async () => {
    const { container } = await renderPanelWithRealAudit();

    const { sourceCell } = readProximityCitationRow(container);
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

  it("serializes the hop-2 proximity citation into the JSON export with the URL as plain text", async () => {
    const result = await runPrivacyAudit([OWNED_FAR, MID_A, MID_B, MID_C]);

    // Sanity: the real audit produced the HIGH hop-2 finding with its citation.
    findProximityFinding(result.findings);

    // Round-trip through JSON.stringify so we assert the actual serialized shape
    // the exported .json download carries — not the in-memory object.
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
        address: ENTITY_ADDR,
        categoryLabel: ENTITY_CATEGORY_LABEL,
        sourceNote: SOURCE_NOTE,
      },
    ]);
    // The URL survives serialization verbatim — JSON is data, not markup.
    expect(exported!.citations![0].sourceNote).toContain(SOURCE_URL);
  });

  it("emits the hop-2 proximity citation in the plain-text (Copy / .txt) report", async () => {
    const result = await runPrivacyAudit([OWNED_FAR, MID_A, MID_B, MID_C]);

    // Sanity: the real audit produced the HIGH hop-2 finding with its citation.
    findProximityFinding(result.findings);

    // This is the surface behind both "Copy report" and "Download .txt".
    const text = buildPrivacyTextReport(result, SCOPE, FIXED_NOW.toLocaleString());

    // Every citation field reaches the plain-text report.
    expect(text).toContain(ENTITY_NAME);
    expect(text).toContain(ENTITY_CATEGORY_LABEL);
    expect(text).toContain(ENTITY_ADDR);
    expect(text).toContain(SOURCE_NOTE);

    // The URL appears verbatim as plain text (offline-first — never fetched).
    expect(text).toContain(SOURCE_URL);

    // It is surfaced under a Source Citations block, not just incidentally
    // present somewhere in the report body.
    expect(text).toContain("Source Citations:");
  });

  it("renders the proximity citation into the printable PDF/HTML export with the URL as plain text", async () => {
    const result = await runPrivacyAudit([OWNED_FAR, MID_A, MID_B, MID_C]);
    findProximityFinding(result.findings);

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
});
