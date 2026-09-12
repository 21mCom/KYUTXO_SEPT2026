// Regression guard for dotted (and otherwise punctuated) declarant names in
// the Proof of Funds PDF download filename (Task: verify dots in user text
// fields). The name sanitizer intentionally STRIPS dots from the name portion
// (unlike the fund-trail sanitizer, which keeps them), so the ".pdf"
// extension appended afterwards is always the only dot-suffix in the file —
// a trailing-dot name like "Alice." can never produce "….pdf.pdf" or a
// mangled extension.
import { describe, it, expect } from "vitest";

import { pofPdfFileName } from "./pof-pdf-output";

describe("pofPdfFileName", () => {
  it("strips interior dots from the name portion and keeps a single .pdf extension", () => {
    expect(pofPdfFileName("J. R. Smith v1.2", "2026-07-28", false)).toBe(
      "proof-of-funds-J_R_Smith_v12-2026-07-28.pdf",
    );
  });

  it("handles a trailing-dot name without doubling or losing the extension", () => {
    const name = pofPdfFileName("Alice.", "2026-07-28", false);
    expect(name).toBe("proof-of-funds-Alice-2026-07-28.pdf");
    expect(name.match(/\.pdf/g)).toHaveLength(1);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("falls back to declaration/specimen when the name is dots only", () => {
    expect(pofPdfFileName("...", "2026-07-28", false)).toBe(
      "proof-of-funds-declaration-2026-07-28.pdf",
    );
    expect(pofPdfFileName("...", "2026-07-28", true)).toBe(
      "proof-of-funds-SAMPLE-specimen-2026-07-28.pdf",
    );
  });

  it("uses the SAMPLE prefix in sample mode with a dotted name", () => {
    expect(pofPdfFileName("Bob.Jones", "2026-07-28", true)).toBe(
      "proof-of-funds-SAMPLE-BobJones-2026-07-28.pdf",
    );
  });
});
