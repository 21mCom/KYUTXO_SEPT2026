import { version as _pkgVersion } from "../../../../package.json";

/** PDF document format version embedded in every generated document. */
export const KYUTXO_APP_VERSION: string = _pkgVersion;

// ────────────────────────────────────────────────────────────────────────────
// Persisted declaration preferences
//
// Persistence boundary: only SECTION TOGGLES and non-identifying formatting
// preferences are persisted to localStorage (attestation/glossary/intro,
// QR explorer choice, provenance + fiat currency/rate, and the AML section
// on/off switch). Sensitive free-text identity data — declarant name, contact,
// residential address, DOB, tax ID, ID number, nationality, purpose,
// statement, and the AML free-text answers (source of wealth/funds, tax
// jurisdiction/statement, PEP status) — is deliberately NEVER auto-persisted:
// this page can be used on shared machines and those answers describe a
// person, not a document style. Persisting/restoring preferences only seeds
// the form's initial state; it never alters previously generated declarations.
// ────────────────────────────────────────────────────────────────────────────
import { type ExplorerId, QR_EXPLORERS } from "./explorer-helpers";

export const DECLARATION_PREFS_KEY = "kyutxo.proofOfFunds.declarationPrefs";

export interface DeclarationPrefs {
  includeIntro: boolean;
  includeAttestation: boolean;
  attestationPlaceOfSigning: string;
  attestationWitnessLine: string;
  includeGlossary: boolean;
  // QR codes section
  includeQr: boolean;
  qrExplorerId: ExplorerId;
  // Acquisition & Provenance section
  includeProvenance: boolean;
  provenanceFiatCurrency: string;
  // Fiat equivalent
  fiatCurrency: string;
  fiatRate: string;
  // AML / Risk Screening — toggle only; the free-text answers are identity
  // data and are intentionally not persisted (see boundary note above).
  includeAml: boolean;
}

export const DEFAULT_DECLARATION_PREFS: DeclarationPrefs = {
  includeIntro: false,
  includeAttestation: false,
  attestationPlaceOfSigning: "",
  attestationWitnessLine: "",
  includeGlossary: false,
  includeQr: false,
  qrExplorerId: "mempool",
  includeProvenance: false,
  provenanceFiatCurrency: "USD",
  fiatCurrency: "USD",
  fiatRate: "",
  includeAml: false,
};

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function explorerId(v: unknown, fallback: ExplorerId): ExplorerId {
  return typeof v === "string" && QR_EXPLORERS.some((e) => e.id === v)
    ? (v as ExplorerId)
    : fallback;
}

export function loadDeclarationPrefs(): DeclarationPrefs {
  const d = DEFAULT_DECLARATION_PREFS;
  try {
    const stored = localStorage.getItem(DECLARATION_PREFS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<DeclarationPrefs>;
      return {
        includeIntro: bool(parsed.includeIntro, d.includeIntro),
        includeAttestation: bool(parsed.includeAttestation, d.includeAttestation),
        attestationPlaceOfSigning: str(parsed.attestationPlaceOfSigning, d.attestationPlaceOfSigning),
        attestationWitnessLine: str(parsed.attestationWitnessLine, d.attestationWitnessLine),
        includeGlossary: bool(parsed.includeGlossary, d.includeGlossary),
        includeQr: bool(parsed.includeQr, d.includeQr),
        qrExplorerId: explorerId(parsed.qrExplorerId, d.qrExplorerId),
        includeProvenance: bool(parsed.includeProvenance, d.includeProvenance),
        provenanceFiatCurrency: str(parsed.provenanceFiatCurrency, d.provenanceFiatCurrency),
        fiatCurrency: str(parsed.fiatCurrency, d.fiatCurrency),
        fiatRate: str(parsed.fiatRate, d.fiatRate),
        includeAml: bool(parsed.includeAml, d.includeAml),
      };
    }
  } catch {
    // Ignore parse/storage errors — fall back to defaults
  }
  return d;
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
