// Pins the exact wording and branch logic of the AML / Risk-Screening appendix
// string builders (`@/lib/amlAppendixStrings`).
//
// These strings used to be inlined inside the PDF generator (and the
// entity-list description was duplicated again in the on-screen preview), so a
// future wording or branch-logic change could silently make the appendix
// inconsistent or wrong with no test catching it. This test fails the moment
// any fixed string or branch behaviour drifts.

import { describe, it, expect } from "vitest";
import {
  AML_APPENDIX_STRINGS,
  AML_PREVIEW_STRINGS,
  formatHopLabel,
  buildScreeningDateLine,
  buildAddressesScreenedLine,
  buildDirectMatchResultLine,
  buildPreviewDirectMatchLine,
  buildEntityListDescription,
  buildNearestEntityLine,
} from "@/lib/amlAppendixStrings";

describe("AML_APPENDIX_STRINGS — fixed boilerplate (word-for-word)", () => {
  it("pins the appendix title and section headings", () => {
    expect(AML_APPENDIX_STRINGS.appendixTitle).toBe(
      "APPENDIX: AML / RISK SCREENING",
    );
    expect(AML_APPENDIX_STRINGS.screeningParametersHeading).toBe(
      "SCREENING PARAMETERS",
    );
    expect(AML_APPENDIX_STRINGS.directMatchResultsHeading).toBe(
      "DIRECT MATCH RESULTS",
    );
    expect(AML_APPENDIX_STRINGS.indirectProximityAnalysisHeading).toBe(
      "INDIRECT PROXIMITY ANALYSIS",
    );
    expect(AML_APPENDIX_STRINGS.declarantSelfAttestationsHeading).toBe(
      "DECLARANT SELF-ATTESTATIONS",
    );
    expect(AML_APPENDIX_STRINGS.screeningDisclaimerHeading).toBe(
      "SCREENING DISCLAIMER",
    );
  });

  it("pins the direct-match (no matches) verdict lines", () => {
    expect(AML_APPENDIX_STRINGS.noDirectMatchesResult).toBe(
      "Result: No direct matches detected.",
    );
    expect(AML_APPENDIX_STRINGS.noDirectMatchesDetail).toBe(
      "None of the declared addresses appear in the active entity list.",
    );
  });

  it("pins the indirect-proximity verdict lines", () => {
    expect(AML_APPENDIX_STRINGS.noGraphDataDetail).toBe(
      "No transaction history is available for these addresses in the local vault. " +
        "Indirect proximity analysis requires synced transaction data.",
    );
    expect(AML_APPENDIX_STRINGS.noProximityMatchResult).toBe(
      "No flagged counterparty detected within 4 transaction hops.",
    );
    expect(AML_APPENDIX_STRINGS.noProximityMatchDetail).toBe(
      "The declared addresses have no indirect on-chain links to known flagged entities within the analysed transaction graph (up to 4 hops).",
    );
  });

  it("pins the general attestation and the screening disclaimer", () => {
    expect(AML_APPENDIX_STRINGS.generalAttestation).toBe(
      "General attestation: The declarant attests that the declared funds are not derived from, do not represent proceeds of, and are not intended to be used in connection with any criminal activity, money laundering, terrorist financing, tax evasion, or sanctions evasion.",
    );
    expect(AML_APPENDIX_STRINGS.screeningDisclaimer).toBe(
      'IMPORTANT — LIMITATIONS OF THIS SCREENING: This AML / risk screening is a best-effort, offline check performed by KYUTXO against a bundled dataset of publicly documented addresses compiled from open sources (WalletExplorer.com address clustering, GraphSense TagPacks, OFAC SDN designations, and published incident reports). It is NOT a substitute for the financial institution\'s own KYC/AML procedures, licensed chain-analysis tooling, or regulatory obligations. A "no direct match" result does not guarantee the funds are free of risk, and this document does not constitute a legal clearance opinion. The declarant\'s self-attestations are unverified statements and must be independently assessed by the receiving institution. All risk decisions remain the sole responsibility of the institution\'s compliance function.',
    );
  });
});

describe("AML_PREVIEW_STRINGS — on-screen preview verdicts (word-for-word)", () => {
  it("pins the no-direct-matches verdict (distinct from the PDF wording)", () => {
    expect(AML_PREVIEW_STRINGS.noDirectMatches).toBe(
      "No direct matches — none of the declared addresses appear in the entity list.",
    );
  });

  it("pins the no-proximity-match verdict", () => {
    expect(AML_PREVIEW_STRINGS.noProximityMatch).toBe(
      "No flagged counterparty within 4 hops.",
    );
  });

  it("pins the no-graph-data verdict", () => {
    expect(AML_PREVIEW_STRINGS.noGraphData).toBe(
      "No transaction data available for hop analysis — sync addresses to enable this.",
    );
  });

  it("keeps the preview verdicts deliberately different from the PDF wording", () => {
    expect(AML_PREVIEW_STRINGS.noDirectMatches).not.toBe(
      AML_APPENDIX_STRINGS.noDirectMatchesDetail,
    );
    expect(AML_PREVIEW_STRINGS.noProximityMatch).not.toBe(
      AML_APPENDIX_STRINGS.noProximityMatchResult,
    );
    expect(AML_PREVIEW_STRINGS.noGraphData).not.toBe(
      AML_APPENDIX_STRINGS.noGraphDataDetail,
    );
  });
});

describe("buildPreviewDirectMatchLine", () => {
  it("singularises a single match", () => {
    expect(buildPreviewDirectMatchLine(1, ["Test Mixer"])).toBe(
      "1 direct match detected: Test Mixer",
    );
  });

  it("pluralises and comma-joins multiple matches", () => {
    expect(
      buildPreviewDirectMatchLine(2, ["Test Mixer", "Bad Exchange"]),
    ).toBe("2 direct matches detected: Test Mixer, Bad Exchange");
  });

  it("uses the plural form for a zero count and an empty name list", () => {
    expect(buildPreviewDirectMatchLine(0, [])).toBe(
      "0 direct matches detected: ",
    );
  });
});

describe("formatHopLabel", () => {
  it("singularises one hop", () => {
    expect(formatHopLabel(1)).toBe("1 hop");
  });

  it("pluralises 2 and 3 hops", () => {
    expect(formatHopLabel(2)).toBe("2 hops");
    expect(formatHopLabel(3)).toBe("3 hops");
  });

  it("renders 4+ hops with a plus suffix (the MAX_HOPS ceiling)", () => {
    expect(formatHopLabel(4)).toBe("4+ hops");
    expect(formatHopLabel(7)).toBe("7+ hops");
  });
});

describe("buildScreeningDateLine / buildAddressesScreenedLine", () => {
  it("formats the screening date line", () => {
    expect(buildScreeningDateLine("2026-06-30")).toBe(
      "Screening date: 2026-06-30",
    );
  });

  it("formats the addresses-screened line", () => {
    expect(buildAddressesScreenedLine(0)).toBe("Addresses screened: 0");
    expect(buildAddressesScreenedLine(12)).toBe("Addresses screened: 12");
  });
});

describe("buildDirectMatchResultLine", () => {
  it("formats the matches-detected result line", () => {
    expect(buildDirectMatchResultLine(1)).toBe(
      "Result: 1 direct match(es) detected — see table below.",
    );
    expect(buildDirectMatchResultLine(3)).toBe(
      "Result: 3 direct match(es) detected — see table below.",
    );
  });
});

describe("buildEntityListDescription — branch logic", () => {
  it("describes the bundled entity list with a thousands-separated count", () => {
    const line = buildEntityListDescription({
      entityListSource: "bundled",
      entityListCount: 12_345,
      entityListImportedAt: null,
      entityListSourceLabel: null,
    });
    expect(line).toBe(
      `Entity list: Bundled (KYUTXO default) — ${(12_345).toLocaleString()} known addresses`,
    );
  });

  it("describes a bare imported snapshot (no file label, no timestamp)", () => {
    const line = buildEntityListDescription({
      entityListSource: "imported",
      entityListCount: 42,
      entityListImportedAt: null,
      entityListSourceLabel: null,
    });
    expect(line).toBe("Entity list: User-imported snapshot — 42 known addresses");
  });

  it("appends file label and ISO import date when present", () => {
    const line = buildEntityListDescription({
      entityListSource: "imported",
      entityListCount: 42,
      entityListImportedAt: 1_700_000_000_000,
      entityListSourceLabel: "my-list.json",
    });
    expect(line).toBe(
      `Entity list: User-imported snapshot — 42 known addresses, file: my-list.json, imported: ${new Date(
        1_700_000_000_000,
      )
        .toISOString()
        .slice(0, 10)}`,
    );
  });

  it("applies the optional sanitize callback only to the user-supplied file label", () => {
    const line = buildEntityListDescription(
      {
        entityListSource: "imported",
        entityListCount: 5,
        entityListImportedAt: null,
        entityListSourceLabel: "weird\u0007name.json",
      },
      (s) => s.replace(/[^\x20-\x7e]/g, "?"),
    );
    expect(line).toBe(
      "Entity list: User-imported snapshot — 5 known addresses, file: weird?name.json",
    );
  });

  it("omits the file label when it is an empty string", () => {
    const line = buildEntityListDescription({
      entityListSource: "imported",
      entityListCount: 5,
      entityListImportedAt: 0,
      entityListSourceLabel: "",
    });
    // Empty label and falsy (0) timestamp are both omitted.
    expect(line).toBe("Entity list: User-imported snapshot — 5 known addresses");
  });
});

describe("buildNearestEntityLine", () => {
  it("formats a one-hop proximity line", () => {
    expect(
      buildNearestEntityLine({
        nearestHopDistance: 1,
        nearestHopEntityName: "Test Mixer",
        nearestHopCategoryLabel: "Mixer / CoinJoin Service",
      }),
    ).toBe(
      "Nearest flagged entity: 1 hop away — Test Mixer (Mixer / CoinJoin Service)",
    );
  });

  it("uses the 4+ hop ceiling label", () => {
    expect(
      buildNearestEntityLine({
        nearestHopDistance: 4,
        nearestHopEntityName: "Far Entity",
        nearestHopCategoryLabel: "Exchange",
      }),
    ).toBe("Nearest flagged entity: 4+ hops away — Far Entity (Exchange)");
  });

  it("renders empty parens for null name/category", () => {
    expect(
      buildNearestEntityLine({
        nearestHopDistance: 2,
        nearestHopEntityName: null,
        nearestHopCategoryLabel: null,
      }),
    ).toBe("Nearest flagged entity: 2 hops away —  ()");
  });

  it("applies the optional sanitize callback to name and category", () => {
    expect(
      buildNearestEntityLine(
        {
          nearestHopDistance: 1,
          nearestHopEntityName: "Bad\u0007Co",
          nearestHopCategoryLabel: "Cat\u0007",
        },
        (s) => s.replace(/[^\x20-\x7e]/g, "?"),
      ),
    ).toBe("Nearest flagged entity: 1 hop away — Bad?Co (Cat?)");
  });
});

describe("on-screen preview nearest-entity line uses the shared builder", () => {
  // The Step 7 preview's "Nearest flagged entity: …" line used to be assembled
  // inline in JSX (formatHopLabel + raw name/category), so a wording change to
  // the template would silently change the live preview while the builder
  // tests above kept passing. This test reads the page source and fails if the
  // preview ever stops calling buildNearestEntityLine or reintroduces the
  // inline "Nearest flagged entity:" template.
  it("ProofOfFundsDeclaration.tsx renders the line via buildNearestEntityLine, never inline", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "../../pages/ProofOfFundsDeclaration.tsx"),
      "utf8",
    );

    // The preview block must call the shared builder.
    expect(source).toContain("buildNearestEntityLine({");

    // No JSX/inline reassembly of the template: the literal prefix must not
    // appear anywhere in the page source (it lives only in the builder).
    expect(source).not.toContain("Nearest flagged entity:");
  });

  it("default sanitize is the identity, so preview output matches raw values", () => {
    const raw = buildNearestEntityLine({
      nearestHopDistance: 3,
      nearestHopEntityName: "Ünïcode — Entity",
      nearestHopCategoryLabel: "Darknet Market",
    });
    expect(raw).toBe(
      "Nearest flagged entity: 3 hops away — Ünïcode — Entity (Darknet Market)",
    );
  });
});
