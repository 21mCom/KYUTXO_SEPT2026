/** PDF document format version embedded in every generated document. */
export const KYUTXO_APP_VERSION = "1.1.28";

// ────────────────────────────────────────────────────────────────────────────
// Persisted declaration preferences (attestation + glossary toggles)
// ────────────────────────────────────────────────────────────────────────────
export const DECLARATION_PREFS_KEY = "kyutxo.proofOfFunds.declarationPrefs";

export interface DeclarationPrefs {
  includeIntro: boolean;
  includeAttestation: boolean;
  attestationPlaceOfSigning: string;
  attestationWitnessLine: string;
  includeGlossary: boolean;
}

export const DEFAULT_DECLARATION_PREFS: DeclarationPrefs = {
  includeIntro: false,
  includeAttestation: false,
  attestationPlaceOfSigning: "",
  attestationWitnessLine: "",
  includeGlossary: false,
};

export function loadDeclarationPrefs(): DeclarationPrefs {
  try {
    const stored = localStorage.getItem(DECLARATION_PREFS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<DeclarationPrefs>;
      return {
        includeIntro:
          typeof parsed.includeIntro === "boolean"
            ? parsed.includeIntro
            : DEFAULT_DECLARATION_PREFS.includeIntro,
        includeAttestation:
          typeof parsed.includeAttestation === "boolean"
            ? parsed.includeAttestation
            : DEFAULT_DECLARATION_PREFS.includeAttestation,
        attestationPlaceOfSigning:
          typeof parsed.attestationPlaceOfSigning === "string"
            ? parsed.attestationPlaceOfSigning
            : DEFAULT_DECLARATION_PREFS.attestationPlaceOfSigning,
        attestationWitnessLine:
          typeof parsed.attestationWitnessLine === "string"
            ? parsed.attestationWitnessLine
            : DEFAULT_DECLARATION_PREFS.attestationWitnessLine,
        includeGlossary:
          typeof parsed.includeGlossary === "boolean"
            ? parsed.includeGlossary
            : DEFAULT_DECLARATION_PREFS.includeGlossary,
      };
    }
  } catch {
    // Ignore parse/storage errors — fall back to defaults
  }
  return DEFAULT_DECLARATION_PREFS;
}

export function saveDeclarationPrefs(prefs: DeclarationPrefs) {
  try {
    localStorage.setItem(DECLARATION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors
  }
}

// Optional introduction / preface. Plain-language explanation of what Bitcoin is
// and why this declaration can rely on publicly verifiable blockchain records.
// Rendered at the very top of the PDF (before the declarant details) when the
// user opts in. Kept ASCII-only so it round-trips cleanly through jsPDF's
// WinAnsi text path (see sanitizePdfText).
export const DECLARATION_INTRO_PARAGRAPHS: string[] = [
  "Bitcoin is a digital bearer asset that can be held in self-custody without the involvement of a financial intermediary. The Bitcoin blockchain acts as the pseudonymous ledger for self-custodied Bitcoin. Many objective aspects of Bitcoin can be independently verified through its publicly accessible blockchain ledger, including the existence of specific addresses, transaction history, and current balances. This declaration therefore relies on those publicly verifiable records wherever possible. Ownership and control are established through exclusive possession of the corresponding private cryptographic keys. As a result, the undersigned, as the holder of the private keys controlling the referenced Bitcoin address(es), is the individual best positioned to attest to the ownership and control of these assets.",
  "Where appropriate, supporting evidence may include blockchain explorer records, cryptographic message signing, and other technical means of demonstrating control over the referenced Bitcoin addresses.",
];
