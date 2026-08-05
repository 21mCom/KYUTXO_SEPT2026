// Single source of truth for the proof-of-control wording shared between the
// PDF builder sections and the PDF tests. The appendix signature-box headings
// and the DISCLAIMERS proof-of-control scaffolding used to be duplicated as
// literals across several tests, so a deliberate wording change cascaded into
// hand-edits everywhere. Exporting the strings (and the disclaimer builders)
// here means a wording change touches this file plus the ONE test that pins
// the exact wording (proof-of-funds-mixed-format-pdf.test.tsx).
import {
  signatureFormatLabel,
  type SignatureFormat,
} from "@/lib/signatureVerify";

// ── Appendix signature-box headings ─────────────────────────────────────────
export const WALLET_SIGNATURE_HEADING = "Wallet Signature (base64):";
export const BIP322_WITNESS_HEADING = "BIP-322 Witness (base64):";

/** Heading above the signature box for one appendix entry. */
export function signatureBoxHeading(format: SignatureFormat | undefined): string {
  return format === "bip322" ? BIP322_WITNESS_HEADING : WALLET_SIGNATURE_HEADING;
}

// ── Disclaimer scaffolding fragments (used by tests to locate the line) ─────
export const CONTROL_INCLUDED_FRAGMENT = "proof-of-control is included";
export const REMAINING_SELF_DECLARED_FRAGMENT =
  "The remaining addresses are self-declared";
export const ALL_ADDRESSES_FRAGMENT = "for all addresses";
export const NO_CONTROL_DISCLAIMER_LINE =
  "2. No cryptographic proof-of-control is included. All addresses are self-declared by the declarant.";

/**
 * Human phrase describing which signature scheme(s) back the verified
 * addresses, e.g. "Bitcoin Signed Message and BIP-322 signatures".
 */
export function buildFormatPhrase(
  verifiedFormats: ReadonlySet<SignatureFormat>,
): string {
  const legacy = signatureFormatLabel("legacy");
  const bip322 = signatureFormatLabel("bip322");
  return verifiedFormats.has("legacy") && verifiedFormats.has("bip322")
    ? `${legacy} and ${bip322} signatures`
    : verifiedFormats.has("bip322")
    ? `${bip322} signatures`
    : `${legacy} signatures`;
}

/** The "via <format phrase>." suffix used by the single/mixed-format branches. */
export function viaFormatPhrase(formatPhrase: string): string {
  return `via ${formatPhrase}.`;
}

/**
 * Disclaimer line #2 — the proof-of-control statement. Exactly one of three
 * phrasings: all-verified, partial ("N of M ... remaining self-declared"),
 * or none-verified.
 */
export function buildControlDisclaimerLine(args: {
  allVerified: boolean;
  hasVerified: boolean;
  verifiedCount: number;
  totalCount: number;
  formatPhrase: string;
}): string {
  const { allVerified, hasVerified, verifiedCount, totalCount, formatPhrase } =
    args;
  return allVerified
    ? `2. Cryptographic ${CONTROL_INCLUDED_FRAGMENT} ${ALL_ADDRESSES_FRAGMENT} ${viaFormatPhrase(formatPhrase)} An appendix contains the challenge messages and signatures for independent re-verification.`
    : hasVerified
    ? `2. Cryptographic ${CONTROL_INCLUDED_FRAGMENT} for ${verifiedCount} of ${totalCount} address${totalCount !== 1 ? "es" : ""} ${viaFormatPhrase(formatPhrase)} ${REMAINING_SELF_DECLARED_FRAGMENT}. An appendix contains the challenge messages and signatures for verified addresses.`
    : NO_CONTROL_DISCLAIMER_LINE;
}
