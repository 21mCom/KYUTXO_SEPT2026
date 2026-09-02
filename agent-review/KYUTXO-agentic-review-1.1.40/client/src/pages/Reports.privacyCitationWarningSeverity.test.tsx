// @vitest-environment jsdom
//
// Regression coverage for ENTITY_* source citations when the entity match lands
// in the LOWER-severity `warnings` bucket instead of the high-priority
// `findings` bucket.
//
// Reports.privacyCitationRenderEndToEnd.test.tsx, Reports.privacyCitationParity
// .test.tsx and privacy-report-export.test.ts all exercise an ENTITY_* finding
// that sits in `result.findings`. The Privacy Audit panel and both exporters
// render the union `[...findings, ...warnings]`, so a citation attached to a
// *warning* must surface exactly the same way. Nothing pinned that down: if an
// entity match were ever reclassified as a warning (e.g. a low-severity
// payment-service / mining-pool / mixer contact, or a future tweak to how
// entity contacts are bucketed), a rendering/serialization regression could
// silently drop its citations (name, categoryLabel, address, sourceNote) from
// the on-screen panel and the JSON/PDF exports with no test catching it.
//
// This test seeds real Dexie records + participants (fake-indexeddb) where an
// owned address pays directly to a known entity address, runs the REAL
// runPrivacyAudit() pipeline, then relocates the genuine ENTITY_* finding it
// produced from `findings` into `warnings` (citation data untouched — still the
// real audit's output, never a hand-built mock). It then drives that
// warning-bucketed result through the three surfaces users read:
//   - the on-screen Privacy Audit panel (PrivacyAuditReportPanel),
//   - the JSON export (buildPrivacyReport), and
//   - the printable PDF/HTML export (buildPrintableReport),
// asserting the citation still renders on every one.
//
// The citation's sourceNote embeds a URL. On screen it must render as an
// informational link that only opens on an explicit click; in the JSON and PDF
// exports it must appear verbatim as plain text and never be wrapped in an
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
  type PrivacyAuditResult,
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
// address — the audit itself (real) reads the seeded participants/transactions
// straight from Dexie, so the citation it produces is genuine, not mocked.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
      {
        id: 1,
        // Inlined (not the OWNED1 const) so the hoisted mock factory never
        // touches a not-yet-initialized top-level binding.
        inputString: "bc1qentitywarnowned10000000000000000000000aa",
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

// The panel calls runPrivacyAudit internally. Wrap the REAL implementation so
// the audit (and its genuine citation) still runs against the seeded Dexie data,
// then relocate the ENTITY_* finding into `warnings`. This simulates an entity
// match being bucketed as a lower-severity warning without fabricating any
// finding or citation — the data the panel renders is the real audit's output.
vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async (...args: Parameters<typeof actual.runPrivacyAudit>) => {
      const result = await actual.runPrivacyAudit(...args);
      return reclassifyEntityFindingsAsWarnings(result);
    }),
  };
});

// OWNED1 pays directly to ENTITY_ADDR in TX1 — a hop-1 (direct) contact that
// detectEntityContacts captures. Non-round amounts keep other heuristics from
// muddying the finding under test. Use a payment-service entity, a category the
// audit already assigns LOW severity — exactly the kind of lower-priority
// counterparty this test guards.
const OWNED1 = "bc1qentitywarnowned10000000000000000000000aa";
const ENTITY_ADDR = "bc1qentitywarndirect000000000000000000000cc";
const TX1 = "2222222222222222222222222222222222222222222222222222222222222222";

// A sourceNote that embeds a real URL so we can prove the URL is shown as
// informational text and is never auto-fetched on any surface.
const SOURCE_URL = "https://www.walletexplorer.com/address/warn-example";
const SOURCE_NOTE = `WalletExplorer.com service clustering — ${SOURCE_URL}`;

const ENTITY_NAME = "Test Payment Service";
// payment-service entities flag as ENTITY_EXCHANGE with the "Payment Service"
// category label (see categoryFindingType / ENTITY_CATEGORY_LABELS).
const ENTITY_FINDING_TYPE = "ENTITY_EXCHANGE";
const ENTITY_CATEGORY_LABEL = "Payment Service";

const SCOPE: ExportScope = { owner: null, wallet: null };
const FIXED_NOW = new Date("2026-06-27T12:00:00Z");

/**
 * Move every ENTITY_* finding from `findings` into `warnings`, leaving the
 * findings (and their citations) byte-for-byte intact. This is the only thing
 * the test fakes — it does not touch citation content, which remains the real
 * audit's output.
 */
function reclassifyEntityFindingsAsWarnings(
  result: PrivacyAuditResult,
): PrivacyAuditResult {
  const entityFindings = result.findings.filter((f) => f.type.startsWith("ENTITY_"));
  const otherFindings = result.findings.filter((f) => !f.type.startsWith("ENTITY_"));
  return {
    ...result,
    findings: otherFindings,
    warnings: [...result.warnings, ...entityFindings],
  };
}

async function seedDirectContact(): Promise<void> {
  await addTransaction(
    { txid: TX1, blockHeight: 800001, blockTime: 1_700_000_500, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
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
  await clearAllRecords({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await seedDirectContact();

  const entry: EntityEntry = {
    address: ENTITY_ADDR,
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

/** Run the audit (real, then relocated to warnings by the mock above). */
async function runWarningBucketedAudit(): Promise<PrivacyAuditResult> {
  return runPrivacyAudit([OWNED1]);
}

/** Render the panel and run the audit by clicking Generate. */
async function renderPanelWithWarningAudit() {
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

describe("ENTITY_* citations render when the match is a lower-severity warning", () => {
  it("places the real entity finding in warnings (not findings) before rendering", async () => {
    const result = await runWarningBucketedAudit();

    // The entity finding moved into warnings; none remain in findings.
    expect(result.findings.some((f) => f.type.startsWith("ENTITY_"))).toBe(false);
    const warning = result.warnings.find((f) => f.type === ENTITY_FINDING_TYPE);
    expect(warning).toBeTruthy();
    // Its citation is genuine (produced by the real audit, not hand-built).
    expect(getCitations(warning!.details)).toHaveLength(1);
  });

  it("surfaces the warning's citation (name/category/address/source) in the on-screen panel", async () => {
    const { container } = await renderPanelWithWarningAudit();

    const row = readOnlyCitationRow(container);
    expect(row.name).toBe(ENTITY_NAME);
    expect(row.category).toBe(ENTITY_CATEGORY_LABEL);
    expect(row.address).toBe(ENTITY_ADDR);
    expect(row.sourceCell.textContent).toContain(SOURCE_NOTE);
  });

  it("renders the warning citation's sourceNote URL as an informational link (never auto-fetched)", async () => {
    const { container } = await renderPanelWithWarningAudit();

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

  it("serializes the warning's citation into the JSON export with the URL as plain text", async () => {
    const result = await runWarningBucketedAudit();

    // Sanity: the citation rode along into the warnings bucket.
    const auditWarning = result.warnings.find((f) => f.type === ENTITY_FINDING_TYPE);
    expect(auditWarning).toBeTruthy();
    expect(getCitations(auditWarning!.details)).toHaveLength(1);

    // Round-trip through JSON.stringify so we assert the actual serialized shape
    // the exported .json download carries — not the in-memory object.
    const report = JSON.parse(
      JSON.stringify(buildPrivacyReport(result, SCOPE, FIXED_NOW.toISOString())),
    ) as { findings: ExportedFinding[]; warnings: ExportedFinding[] };

    // The entity finding (and its citation) is serialized under `warnings`.
    expect(report.findings.some((f) => f.type === ENTITY_FINDING_TYPE)).toBe(false);
    const exported = report.warnings.find((f) => f.type === ENTITY_FINDING_TYPE);
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

  it("renders the warning's citation into the printable PDF/HTML export with the URL as plain text", async () => {
    const result = await runWarningBucketedAudit();
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
