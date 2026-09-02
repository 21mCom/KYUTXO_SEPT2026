// Guards the Proof-of-Funds declarant self-attestation lines against drift
// between the on-screen "Attestation preview" sub-box and the PDF's "DECLARANT
// SELF-ATTESTATIONS" section.
//
// Both surfaces are produced by `buildAttestationLines`: the preview calls it
// with no sanitizer (identity), the PDF calls it with `sanitizePdfText`. This
// test seeds the attestation fields across every branch (PEP yes/no/not-stated,
// wealth, funds, tax jurisdiction with and without a statement) and asserts:
//
//   1. the exact strings each branch produces (so a change to ANY line in the
//      builder fails the test — i.e. neither the preview nor the PDF can change
//      without the other);
//   2. that the preview output and the PDF output are identical whenever the
//      user-supplied values contain only WinAnsi-safe characters (the only
//      intended difference between the two surfaces is sanitizePdfText);
//   3. that sanitizePdfText-only differences (a non-WinAnsi glyph) appear in the
//      PDF output but not the preview, and affect nothing else.

import { describe, it, expect } from "vitest";
import {
  buildAttestationLines,
  type AttestationFields,
} from "@/lib/attestationLines";
import { sanitizePdfText } from "@/lib/pdfText";

const base: AttestationFields = {
  pepStatus: "not-stated",
  sourceOfWealth: "",
  sourceOfFunds: "",
  taxJurisdiction: "",
  taxStatement: "",
};

describe("buildAttestationLines — preview/PDF parity", () => {
  it("produces the exact strings for a fully populated declaration (PEP yes)", () => {
    const fields: AttestationFields = {
      pepStatus: "yes",
      sourceOfWealth: "Sale of a software company in 2019",
      sourceOfFunds: "Proceeds held in cold storage since 2020",
      taxJurisdiction: "Portugal",
      taxStatement: "Filed under NHR regime, reference 12345.",
    };

    expect(buildAttestationLines(fields)).toEqual([
      "PEP Status: The declarant confirms they ARE a Politically Exposed Person (PEP).",
      "Source of Wealth: Sale of a software company in 2019",
      "Source of Funds: Proceeds held in cold storage since 2020",
      "Tax Residency & Compliance: The declarant is resident for tax purposes in Portugal. Filed under NHR regime, reference 12345.",
    ]);
  });

  it("produces the exact strings for PEP=no with a tax jurisdiction but no statement", () => {
    const fields: AttestationFields = {
      ...base,
      pepStatus: "no",
      sourceOfWealth: "Salaried employment",
      sourceOfFunds: "Monthly savings",
      taxJurisdiction: "Germany",
      taxStatement: "",
    };

    expect(buildAttestationLines(fields)).toEqual([
      "PEP Status: The declarant confirms they are NOT a Politically Exposed Person (PEP).",
      "Source of Wealth: Salaried employment",
      "Source of Funds: Monthly savings",
      "Tax Residency: The declarant is resident for tax purposes in Germany.",
    ]);
  });

  it("produces the exact fallback strings when everything is blank/not-stated", () => {
    expect(buildAttestationLines(base)).toEqual([
      "PEP Status: Not stated by declarant (no selection made).",
      "Source of Wealth: Not provided by declarant.",
      "Source of Funds: Not provided by declarant.",
    ]);
    // No tax jurisdiction → no tax line at all.
    expect(buildAttestationLines(base)).toHaveLength(3);
  });

  it("omits the tax line when only a statement (no jurisdiction) is given", () => {
    const fields: AttestationFields = {
      ...base,
      taxStatement: "I have a statement but did not name a country",
    };
    expect(buildAttestationLines(fields)).toHaveLength(3);
    expect(
      buildAttestationLines(fields).some((l) => l.startsWith("Tax Residency")),
    ).toBe(false);
  });

  it("trims user values identically in preview and PDF", () => {
    const fields: AttestationFields = {
      ...base,
      sourceOfWealth: "   Inheritance   ",
      sourceOfFunds: "\tBrokerage transfer\n",
      taxJurisdiction: "  France  ",
    };
    const lines = buildAttestationLines(fields);
    expect(lines[1]).toBe("Source of Wealth: Inheritance");
    expect(lines[2]).toBe("Source of Funds: Brokerage transfer");
    expect(lines[3]).toBe(
      "Tax Residency: The declarant is resident for tax purposes in France.",
    );
  });

  it("preview and PDF outputs are identical for WinAnsi-safe values across all branches", () => {
    const variants: AttestationFields[] = [
      base,
      { ...base, pepStatus: "yes" },
      { ...base, pepStatus: "no" },
      {
        pepStatus: "yes",
        sourceOfWealth: "Business sale - net of taxes",
        sourceOfFunds: "Cold-storage holdings (café résumé)",
        taxJurisdiction: "Ireland",
        taxStatement: "Self-assessed; ref 99.",
      },
      {
        ...base,
        pepStatus: "no",
        sourceOfWealth: "Salary",
        sourceOfFunds: "Savings",
        taxJurisdiction: "Spain",
      },
    ];

    for (const fields of variants) {
      const preview = buildAttestationLines(fields);
      const pdf = buildAttestationLines(fields, sanitizePdfText);
      // Every char above is WinAnsi-safe (U+0000–U+00FF), so sanitizePdfText is
      // a no-op and the two surfaces must be byte-for-byte identical.
      expect(pdf).toEqual(preview);
    }
  });

  it("differs ONLY by sanitizePdfText when a value contains a non-WinAnsi glyph", () => {
    // U+21B3 (↳) is above U+00FF, so sanitizePdfText replaces it with "?".
    const fields: AttestationFields = {
      ...base,
      pepStatus: "yes",
      sourceOfWealth: "Trust payout ↳ family office",
      taxJurisdiction: "Japan 日本",
    };

    const preview = buildAttestationLines(fields);
    const pdf = buildAttestationLines(fields, sanitizePdfText);

    // Preview keeps the original glyphs.
    expect(preview[1]).toBe("Source of Wealth: Trust payout ↳ family office");
    expect(preview[3]).toBe(
      "Tax Residency: The declarant is resident for tax purposes in Japan 日本.",
    );

    // PDF replaces only the out-of-range glyphs; everything else is unchanged.
    expect(pdf[1]).toBe("Source of Wealth: Trust payout ? family office");
    expect(pdf[3]).toBe(
      "Tax Residency: The declarant is resident for tax purposes in Japan ??.",
    );

    // Lines whose values are pure ASCII are byte-for-byte identical.
    expect(pdf[0]).toBe(preview[0]);
    expect(pdf[2]).toBe(preview[2]);

    // The PDF output equals the preview output once we apply sanitizePdfText to
    // each preview line — proving the ONLY difference is sanitization.
    expect(pdf).toEqual(preview.map((l) => sanitizePdfText(l)));
  });
});
