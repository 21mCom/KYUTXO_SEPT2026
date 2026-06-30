/**
 * Shared builder for the declarant self-attestation lines.
 *
 * The Proof-of-Funds declaration renders these attestation lines in two places
 * that must stay word-for-word identical:
 *
 *   1. Step 7's live "Attestation preview" sub-box (derived from state, no
 *      sanitization — the screen can draw any character).
 *   2. The PDF's "DECLARANT SELF-ATTESTATIONS" section, where each user-supplied
 *      value is routed through `sanitizePdfText` so jsPDF's Standard-14 Helvetica
 *      font never falls back to a garbled UTF-16BE byte-stream.
 *
 * Previously these were two independent string builders, so a future edit to one
 * could silently diverge from the other and make the on-screen preview
 * misleading. Routing both through this single function makes that drift
 * impossible by construction: the only intended difference between the preview
 * and the PDF is the optional `sanitize` callback applied to user-supplied
 * values (jurisdiction/statement/wealth/funds), never the fixed boilerplate.
 */

export type AmlPepStatus = "not-stated" | "yes" | "no";

export interface AttestationFields {
  pepStatus: AmlPepStatus;
  sourceOfWealth: string;
  sourceOfFunds: string;
  taxJurisdiction: string;
  taxStatement: string;
}

/**
 * Build the ordered attestation lines from the raw attestation inputs.
 *
 * @param fields   The attestation state (PEP status + free-text fields).
 * @param sanitize Optional transform applied only to user-supplied values
 *                 (defaults to identity for the on-screen preview; the PDF
 *                 passes `sanitizePdfText`). Fixed boilerplate is never
 *                 sanitized because it is already WinAnsi-safe.
 */
export function buildAttestationLines(
  fields: AttestationFields,
  sanitize: (s: string) => string = (s) => s,
): string[] {
  const lines: string[] = [];

  lines.push(
    fields.pepStatus === "yes"
      ? "PEP Status: The declarant confirms they ARE a Politically Exposed Person (PEP)."
      : fields.pepStatus === "no"
      ? "PEP Status: The declarant confirms they are NOT a Politically Exposed Person (PEP)."
      : "PEP Status: Not stated by declarant (no selection made).",
  );

  lines.push(
    fields.sourceOfWealth.trim()
      ? `Source of Wealth: ${sanitize(fields.sourceOfWealth.trim())}`
      : "Source of Wealth: Not provided by declarant.",
  );

  lines.push(
    fields.sourceOfFunds.trim()
      ? `Source of Funds: ${sanitize(fields.sourceOfFunds.trim())}`
      : "Source of Funds: Not provided by declarant.",
  );

  if (fields.taxJurisdiction.trim()) {
    lines.push(
      fields.taxStatement.trim()
        ? `Tax Residency & Compliance: The declarant is resident for tax purposes in ${sanitize(
            fields.taxJurisdiction.trim(),
          )}. ${sanitize(fields.taxStatement.trim())}`
        : `Tax Residency: The declarant is resident for tax purposes in ${sanitize(
            fields.taxJurisdiction.trim(),
          )}.`,
    );
  }

  return lines;
}
