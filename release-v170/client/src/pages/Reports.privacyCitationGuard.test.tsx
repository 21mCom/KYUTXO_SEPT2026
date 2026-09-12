// @vitest-environment jsdom
//
// Guards the citation-rendering gate in PrivacyAuditReportPanel (Reports.tsx):
// ONLY ENTITY_* findings carry source citations, so only they may render the
// on-screen "Source Citations" table (data-testid `table-privacy-citations-*`).
// A non-entity finding (e.g. ADDRESS_REUSE) must render NO citations table — a
// future change to the `extractCitations` guard could otherwise silently show
// an empty/stray box to users.
//
// This mirrors Reports.privacyCitationParity.test.tsx: only the data-fetching
// chain (owners/wallets hooks, the address page query, toast) and
// runPrivacyAudit are stubbed; the panel's citation rendering is left REAL.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

import type { PrivacyAuditResult, PrivacyFinding } from "@/lib/privacy-audit";

vi.mock("@/hooks/use-owners", () => ({
  useOwners: () => ({ owners: [], isLoading: false }),
}));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [], isLoading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsPageByTypeIdReverseKeyset: vi.fn(async () => [
    { id: 1, inputString: "bc1qexampleaddress", owner: undefined, walletName: undefined },
  ]),
}));

// An ENTITY_* finding carrying a citation — this one SHOULD render a table.
const ENTITY_FINDING: PrivacyFinding = {
  type: "ENTITY_SCAM",
  severity: "CRITICAL",
  description: "A transaction interacts with known counterparties.",
  correction: "Avoid reusing funds linked to these counterparties.",
  txids: ["tx_scam"],
  addresses: ["134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak"],
  scoreDelta: -28,
  details: {
    citations: [
      {
        name: "Lazarus Group (DPRK, OFAC-sanctioned)",
        address: "134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak",
        categoryLabel: "Scam / Fraud",
        sourceNote: "OFAC / US Treasury",
      },
    ],
  },
} as unknown as PrivacyFinding;

// A non-entity finding (ADDRESS_REUSE) — carries no citations and MUST render
// no citations table, even though it has its own details payload.
const NON_ENTITY_FINDING: PrivacyFinding = {
  type: "ADDRESS_REUSE",
  severity: "HIGH",
  description: "An address was used in more than one transaction.",
  correction: "Use a fresh address for each receive.",
  txids: ["tx_reuse_a", "tx_reuse_b"],
  addresses: ["1BoatSLRHtKNngkdXEeobR76b53LETtpyT"],
  scoreDelta: -12,
  details: {},
} as unknown as PrivacyFinding;

// Order is deterministic: findings render as [...findings] with the ENTITY_*
// at index 0 and the non-entity finding at index 1.
const mockResult: PrivacyAuditResult = {
  findings: [ENTITY_FINDING, NON_ENTITY_FINDING],
  warnings: [],
  transactionsAnalyzed: 10,
  addressesScanned: 5,
  isClean: false,
  score: 60,
  grade: "C",
  scoreWaterfall: [],
  needsResync: false,
  fingerprintCoverage: 1,
} as PrivacyAuditResult;

vi.mock("@/lib/privacy-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-audit")>();
  return {
    ...actual,
    runPrivacyAudit: vi.fn(async () => mockResult),
  };
});

const { PrivacyAuditReportPanel } = await import("./Reports");

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithResult() {
  const utils = render(<PrivacyAuditReportPanel />);
  fireEvent.click(utils.getByTestId("button-generate-privacy-report"));
  await waitFor(() => utils.getByTestId("container-privacy-report-findings"));
  return utils;
}

describe("PrivacyAuditReportPanel — citation table only for ENTITY_* findings", () => {
  it("renders a citations table for the ENTITY_* finding and none for the non-entity finding", async () => {
    const { container } = await renderWithResult();

    // Both findings rendered.
    expect(container.querySelector('[data-testid="row-privacy-finding-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-privacy-finding-1"]')).not.toBeNull();

    // The ENTITY_* finding (index 0) has its citations table...
    const entityRow = container.querySelector<HTMLElement>(
      '[data-finding-type="ENTITY_SCAM"]',
    );
    expect(entityRow).not.toBeNull();
    expect(
      entityRow!.querySelector('[data-testid="table-privacy-citations-0"]'),
    ).not.toBeNull();

    // ...while the non-entity finding (index 1) has NO citations table.
    const nonEntityRow = container.querySelector<HTMLElement>(
      '[data-finding-type="ADDRESS_REUSE"]',
    );
    expect(nonEntityRow).not.toBeNull();
    expect(
      nonEntityRow!.querySelector('[data-testid="table-privacy-citations-1"]'),
    ).toBeNull();
    // No stray citation rows under the non-entity finding either.
    expect(
      nonEntityRow!.querySelectorAll('[data-testid^="row-privacy-citation-"]'),
    ).toHaveLength(0);

    // Exactly one citations table exists across the whole panel.
    expect(
      container.querySelectorAll('[data-testid^="table-privacy-citations-"]'),
    ).toHaveLength(1);
  });
});
