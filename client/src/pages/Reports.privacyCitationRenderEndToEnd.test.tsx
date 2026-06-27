// @vitest-environment jsdom
//
// End-to-end render/serialization coverage for ENTITY_* source citations
// (Task: "Make sure flag reasons also show up in the privacy report and
// exports").
//
// privacy-audit.e2e-entity-citations.test.ts proves that a real owned→entity
// contact, run through the FULL runPrivacyAudit() pipeline, attaches the
// attribution citation (name, categoryLabel, address, sourceNote) to the
// ENTITY_* finding's `details.citations`. That test stops at the audit layer.
//
// A regression in the rendering/serialization layer could still drop that
// attribution even though the audit data is correct. This test closes that gap:
// it seeds real Dexie records + participants (fake-indexeddb) where an owned
// address pays directly to a known entity address, swaps the active entity list
// with setActiveEntityList, and then drives the REAL audit output (never a
// hand-built mock finding) all the way to the three surfaces users actually
// read:
//   - the on-screen Privacy Audit findings UI (PrivacyAuditReportPanel), and
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport).
//
// The citation's sourceNote embeds a URL. On screen it must render as an
// informational link that only opens on an explicit click (it carries no href
// a crawler/preview could auto-fetch beyond user intent); in the JSON and PDF
// exports it must appear verbatim as plain text and never be wrapped in an
// anchor (offline-first — citation URLs are never fetched).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import { db } from "@/lib/database";
import { addTransaction, addParticipant } from "@/lib/data/transaction-crud";
import { runPrivacyAudit, type EntityCitation } from "@/lib/privacy-audit";
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
        inputString: "bc1qentityowned100000000000000000000000000aa",
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
// detectEntityContacts captures. Non-round amounts keep other heuristics from
// muddying the finding under test.
const OWNED1 = "bc1qentityowned100000000000000000000000000aa";
const ENTITY_ADDR = "bc1qentitydirect00000000000000000000000000cc";
const TX1 = "1111111111111111111111111111111111111111111111111111111111111111";

// A sourceNote that embeds a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const SOURCE_URL = "https://www.walletexplorer.com/address/example";
const SOURCE_NOTE = `WalletExplorer.com service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Test Exchange";
const ENTITY_CATEGORY_LABEL = "Exchange";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

async function seedDirectContact(): Promise<void> {
  await addTransaction(
    { txid: TX1, blockHeight: 800000, blockTime: 1_700_000_000, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
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

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
  await seedDirectContact();

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
  await db.records.clear();
  await db.blockchainTransactions.clear();
  await db.transactionParticipants.clear();
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

describe("ENTITY_* citations render end-to-end from the real audit", () => {
  it("surfaces the citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithRealAudit();

    const row = readOnlyCitationRow(container);
    expect(row.name).toBe(ENTITY_NAME);
    expect(row.category).toBe(ENTITY_CATEGORY_LABEL);
    expect(row.address).toBe(ENTITY_ADDR);
    expect(row.sourceCell.textContent).toContain(SOURCE_NOTE);
  });

  it("renders the citation sourceNote URL as an informational link (never auto-fetched)", async () => {
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

  it("serializes the citation into the JSON export with the URL as plain text", async () => {
    const result = await runPrivacyAudit([OWNED1]);

    // Sanity: the real audit produced the entity finding with its citation.
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

  it("renders the citation into the printable PDF/HTML export with the URL as plain text", async () => {
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
});
