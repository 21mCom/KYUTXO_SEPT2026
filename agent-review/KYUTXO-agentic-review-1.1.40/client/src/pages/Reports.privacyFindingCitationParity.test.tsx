// @vitest-environment jsdom
//
// Parity coverage for per-entity SOURCE CITATIONS (extractCitations).
//
// Entity findings (ENTITY_*) and indirect proximity findings (PROXIMITY_*) carry
// source citations — name, category label, address, and an optional public
// attribution note (sourceNote). These citations are rendered INDEPENDENTLY in
// two exported surfaces that must never drift apart:
//   - the plain-text export ("Source Citations:" block in buildPrivacyTextReport), and
//   - the print/PDF HTML export (the .citations-table in buildPrintableReport,
//     which additionally escapes every value via escapeHtml).
//
// Nothing else asserts the two surfaces enumerate the SAME citation fields, in
// the same order, for the same finding — so a change to which fields appear,
// their order, or the "—" empty-sourceNote fallback could diverge silently.
//
// This test builds BOTH exports from ONE shared audit result containing an
// ENTITY_* finding with multiple citations (including one with NO sourceNote,
// exercising the "—" fallback, and values with HTML-significant characters to
// exercise escaping). The exporters are left REAL so the comparison is against
// production output. extractCitations is the single source of truth; both
// surfaces are asserted against it AND against each other.

import { describe, it, expect } from "vitest";

import {
  buildPrivacyTextReport,
  extractCitations,
  type ExportScope,
} from "@/lib/privacy-report-export";
import { buildPrintableReport } from "@/lib/privacy-report-html";
import type { EntityCitation } from "@/lib/privacy-audit";

const SCOPE: ExportScope = { owner: null, wallet: null };

// Citations deliberately include HTML-significant characters (&, <, >, ') so the
// HTML export's escapeHtml round-trips through DOMParser back to the raw value,
// and one citation with NO sourceNote to exercise the "—" empty fallback.
const CITATIONS: EntityCitation[] = [
  {
    name: "Acme Exchange & Co",
    address: "bc1qexchangeaddrone",
    categoryLabel: "Exchange",
    sourceNote: "https://walletexplorer.com/acme?ref=a&b",
  },
  {
    name: "Mixer <Pro>",
    address: "bc1qmixeraddrtwo",
    categoryLabel: "Mixer",
    // No sourceNote — must render as the "—" fallback in HTML and be omitted
    // (no "Source:" line) in the text export.
  },
  {
    name: "P2P 'Market'",
    address: "bc1qp2paddrthree",
    categoryLabel: "P2P Exchange",
    sourceNote: "OFAC SDN list",
  },
];

const entityFinding = {
  type: "ENTITY_EXCHANGE",
  severity: "HIGH",
  description: "Your transactions interact with known Exchange address(es).",
  correction: "Consider intermediate wallets to reduce on-chain linkability.",
  txids: [],
  addresses: CITATIONS.map((c) => c.address),
  details: { citations: CITATIONS },
  scoreDelta: -12,
};

// A second, non-entity finding without citations ensures the parsers correctly
// isolate the entity finding's citation block rather than greedily matching.
const noiseFinding = {
  type: "ADDRESS_REUSE",
  severity: "MEDIUM",
  description: "An address was reused.",
  correction: "",
  txids: [],
  addresses: ["bc1qreuse"],
  details: {},
  scoreDelta: -3,
};

const mockResult = {
  findings: [entityFinding, noiseFinding],
  warnings: [],
  warningsList: [],
  transactionsAnalyzed: 5,
  addressesScanned: 3,
  isClean: false,
  score: 70,
  grade: "C",
  scoreWaterfall: [],
  needsResync: false,
  fingerprintCoverage: 1,
};

interface ParsedCitation {
  name: string;
  category: string;
  address: string;
  source: string | null;
}

/**
 * Pull the citations rendered under the FIRST finding in the plain-text export.
 * The block looks like:
 *   N. [Severity] Label
 *      ...
 *      Source Citations:
 *        - <name> (<category>)
 *          Address: <address>
 *          Source: <sourceNote>      (omitted when there is no sourceNote)
 * Parsing stops at the next numbered finding so the noise finding is excluded.
 */
function readTextCitations(text: string): ParsedCitation[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\d+\.\s+\[/.test(l));
  expect(start, "the entity finding should appear in the text export").toBeGreaterThanOrEqual(0);
  const nextFinding = lines.findIndex((l, i) => i > start && /^\d+\.\s+\[/.test(l));
  const end = nextFinding === -1 ? lines.length : nextFinding;

  const out: ParsedCitation[] = [];
  let current: ParsedCitation | null = null;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^\s+- (.+) \((.+)\)\s*$/);
    if (nameMatch) {
      if (current) out.push(current);
      current = { name: nameMatch[1], category: nameMatch[2], address: "", source: null };
      continue;
    }
    if (!current) continue;
    const addrMatch = line.match(/^\s+Address:\s*(.+)$/);
    if (addrMatch) {
      current.address = addrMatch[1].trim();
      continue;
    }
    const srcMatch = line.match(/^\s+Source:\s*(.+)$/);
    if (srcMatch) {
      current.source = srcMatch[1].trim();
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Pull the citations rendered under the FIRST finding in the printable HTML.
 * Each finding's .citations-table has one row per citation with four cells:
 * Entity, Category, Address, Source ("—" when there is no sourceNote).
 * DOMParser decodes HTML entities, so escaped values round-trip to raw text.
 */
function readHtmlCitations(html: string): ParsedCitation[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const finding = doc.querySelector(".finding");
  expect(finding, "the entity finding should appear in the HTML export").not.toBeNull();
  const rows = Array.from(finding!.querySelectorAll<HTMLElement>(".citations-table tbody tr"));
  return rows.map((row) => {
    const cells = Array.from(row.querySelectorAll("td"));
    return {
      name: cells[0]!.textContent!.trim(),
      category: cells[1]!.textContent!.trim(),
      address: cells[2]!.textContent!.trim(),
      source: cells[3]!.textContent!.trim(),
    };
  });
}

describe("Privacy report — source-citation parity across the text and PDF exports", () => {
  it("enumerates the same citation fields for the same finding in both surfaces", () => {
    // extractCitations is the single source of truth both exporters consume.
    const canonical = extractCitations(entityFinding as never);
    expect(canonical, "the fixture finding should carry citations").toBeDefined();
    expect(canonical!.length).toBe(CITATIONS.length);

    const textCitations = readTextCitations(
      buildPrivacyTextReport(mockResult as never, SCOPE, "fixed"),
    );
    const htmlCitations = readHtmlCitations(
      buildPrintableReport(mockResult as never, SCOPE, new Date("2026-06-27T00:00:00Z")),
    );

    // Both surfaces emit one citation per canonical citation, in the same order.
    expect(textCitations).toHaveLength(canonical!.length);
    expect(htmlCitations).toHaveLength(canonical!.length);

    canonical!.forEach((c, i) => {
      const t = textCitations[i];
      const h = htmlCitations[i];

      // Name / category / address must match the canonical citation exactly in
      // both surfaces (HTML escaping is transparent after DOMParser decoding).
      expect(t.name).toBe(c.name);
      expect(h.name).toBe(c.name);
      expect(t.category).toBe(c.categoryLabel);
      expect(h.category).toBe(c.categoryLabel);
      expect(t.address).toBe(c.address);
      expect(h.address).toBe(c.address);

      // Source: when present it matches the note in both; when absent the text
      // omits the line (null) while the HTML shows the "—" fallback.
      if (c.sourceNote) {
        expect(t.source).toBe(c.sourceNote);
        expect(h.source).toBe(c.sourceNote);
      } else {
        expect(t.source).toBeNull();
        expect(h.source).toBe("—");
      }

      // Cross-surface: the two exports agree on every field, accounting for the
      // text-omits / HTML-"—" empty-source convention.
      expect(h.name).toBe(t.name);
      expect(h.category).toBe(t.category);
      expect(h.address).toBe(t.address);
      expect(h.source).toBe(t.source ?? "—");
    });
  });

  it("round-trips HTML-escaped citation values back to their raw text", () => {
    const html = buildPrintableReport(mockResult as never, SCOPE, new Date("2026-06-27T00:00:00Z"));

    // The raw HTML must NOT contain the unescaped special characters inside the
    // citation cells — they must be entity-encoded by escapeHtml.
    expect(html).toContain("Acme Exchange &amp; Co");
    expect(html).toContain("Mixer &lt;Pro&gt;");
    expect(html).toContain("P2P &#39;Market&#39;");

    // And after decoding, those cells read back as the original raw values,
    // identical to what the plain-text export emits.
    const htmlCitations = readHtmlCitations(html);
    expect(htmlCitations.map((c) => c.name)).toEqual(
      CITATIONS.map((c) => c.name),
    );
  });
});
