import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import {
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle,
  Clock,
  X,
  RefreshCw,
  Wifi,
  Database,
  ChevronDown,
  ChevronUp,
  Download,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Copy,
  ClipboardCheck,
  QrCode as QrCodeIcon,
  Globe,
  Upload,
  Trash2,
  Image as ImageIcon,
  Paperclip,
} from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "wouter";
import {
  createProviderFromSettings,
  isNodeUnreachableError,
  NODE_PROBE_TIMEOUT_MS,
  NODE_UNREACHABLE_CONSECUTIVE_LIMIT,
} from "@/lib/blockchain-api";
import { validateAddress, formatBTC, truncateAddress } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { mergeEvidencePdfs, countPdfPages, type PdfExhibit } from "@/lib/pdfMerge";
import { buildAttestationLines } from "@/lib/attestationLines";
import {
  AML_APPENDIX_STRINGS,
  AML_PREVIEW_STRINGS,
  buildScreeningDateLine,
  buildAddressesScreenedLine,
  buildDirectMatchResultLine,
  buildPreviewDirectMatchLine,
  buildEntityListDescription,
  buildNearestEntityLine,
} from "@/lib/amlAppendixStrings";
import { computeStatsForAddresses } from "@/lib/data/address-stats";
import { getRecordsByType } from "@/lib/data/record-crud";
import { getLatestPriceOnOrBefore } from "@/lib/data/price-data-crud";
import { getAttachmentsByRecordId } from "@/lib/data/attachments-crud";
import { ACQUISITION_METHOD_OPTIONS, COUNTERPARTY_TYPE_OPTIONS } from "@/lib/db-types";
import { useToast } from "@/hooks/use-toast";
import {
  buildChallengeMessage,
  verifyBitcoinSignature,
  generateDeclarationNonce,
  signatureFormatLabel,
  type SignatureFormat,
  type FreshnessAnchor,
} from "@/lib/signatureVerify";
import {
  lookupEntities,
  getActiveEntityCount,
  getActiveEntitySource,
  ENTITY_CATEGORY_LABELS,
} from "@/lib/privacy-entity-list";

type BalanceSource = "live" | "offline";
type RowStatus = "pending" | "loading" | "done" | "empty" | "error";
type ControlStatus = "idle" | "verifying" | "verified" | "failed";

// ── Supporting Evidence (optional) ──────────────────────────────────────────
// Declarants may attach screenshots/photos (embedded into the dossier PDF) and
// PDF documents (merged onto the end as extra pages). Files are held in memory
// only for the current session — never written to localStorage or IndexedDB —
// and processed entirely offline.
type EvidenceKind = "image" | "pdf";

interface EvidenceItem {
  id: string;
  name: string;
  kind: EvidenceKind;
  mime: string;
  /** Raw file bytes; hashed for the fingerprint and used for embed/merge. */
  bytes: Uint8Array;
  /** Images only: data URL for the form thumbnail and jsPDF embedding. */
  dataUrl?: string;
  caption: string;
  sha256: string;
  size: number;
  /** PDFs only: page count, validated and shown in the exhibit index. */
  pageCount?: number;
}

const EVIDENCE_MAX_ITEMS = 20;
const EVIDENCE_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
// Cumulative cap across all attachments. Image data URLs, jsPDF's embedded
// copies, and pdf-lib's in-memory merge all multiply the raw bytes, so a
// generous per-file cap with no overall ceiling could still exhaust memory and
// freeze the renderer. Bound the total to keep PDF generation safe.
const EVIDENCE_MAX_TOTAL_BYTES = 75 * 1024 * 1024; // 75 MB combined
const EVIDENCE_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";
const EVIDENCE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"];

let evidenceIdCounter = 0;
function nextEvidenceId(): string {
  evidenceIdCounter += 1;
  return `ev-${Date.now().toString(36)}-${evidenceIdCounter}`;
}

async function hashBytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Browser-safe base64 (no Node Buffer): chunk to stay within the
// String.fromCharCode argument limit for large images.
function imageBytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function formatEvidenceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AddressRow {
  raw: string;
  isInvalid: boolean;
  invalidReason?: string;
  status: RowStatus;
  balanceSats?: number;
  error?: string;
  lastSyncTime?: number;
}

interface ControlState {
  paste: string;
  status: ControlStatus;
  error?: string;
  verifiedSig?: string;
  // True when a previously-verified signature was cleared because the declarant
  // details (name/date/purpose) changed, so the signed challenge message no
  // longer matches. Surfaces an inline "re-verify" warning until re-verified.
  staleAfterVerify?: boolean;
  verifiedFormat?: SignatureFormat;
}

interface BalanceSummary {
  totalSats: number;
  source: BalanceSource;
  asOfLabel: string;
  blockHeight?: number;
  timestamp?: number;
}

function parseAddressInput(text: string): { rows: AddressRow[]; dupes: number } {
  const lines = text
    .split(/[\n,;]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const seen = new Set<string>();
  const rows: AddressRow[] = [];
  let dupes = 0;

  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      dupes++;
      continue;
    }
    seen.add(key);

    const result = validateAddress(line);
    if (!result.isValid) {
      rows.push({
        raw: line,
        isInvalid: true,
        invalidReason: result.error || "Not a valid Bitcoin address",
        status: "pending",
      });
    } else {
      rows.push({ raw: line, isInvalid: false, status: "pending" });
    }
  }

  return { rows, dupes };
}

function formatUnix(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Public block-explorer services a recipient can use to independently look up an
// address's balance. The QR code simply ENCODES the explorer URL as text — it is
// generated entirely offline (no network call, no remote QR image service). The
// recipient chooses whether to scan it and contact the third-party explorer.
type ExplorerId = "mempool" | "blockstream" | "blockchain" | "blockchair";

interface ExplorerDef {
  id: ExplorerId;
  label: string;
  // Human-readable host shown under each QR code in the UI and PDF.
  host: string;
  // Builds the public address page URL that the QR code encodes.
  addressUrl: (address: string) => string;
}

const QR_EXPLORERS: ExplorerDef[] = [
  {
    id: "mempool",
    label: "mempool.space",
    host: "mempool.space",
    addressUrl: (a) => `https://mempool.space/address/${a}`,
  },
  {
    id: "blockstream",
    label: "Blockstream.info",
    host: "blockstream.info",
    addressUrl: (a) => `https://blockstream.info/address/${a}`,
  },
  {
    id: "blockchain",
    label: "Blockchain.com",
    host: "blockchain.com",
    addressUrl: (a) => `https://www.blockchain.com/explorer/addresses/btc/${a}`,
  },
  {
    id: "blockchair",
    label: "Blockchair",
    host: "blockchair.com",
    addressUrl: (a) => `https://blockchair.com/bitcoin/address/${a}`,
  },
];

function getExplorer(id: ExplorerId): ExplorerDef {
  return QR_EXPLORERS.find((e) => e.id === id) ?? QR_EXPLORERS[0];
}

// ─── AML Screening ──────────────────────────────────────────────────────────

interface AmlDirectMatch {
  address: string;
  entityName: string;
  categoryLabel: string;
  sourceNote?: string;
}

interface AmlScreeningResult {
  screeningDate: string;
  entityListSource: "bundled" | "imported";
  entityListCount: number;
  /** Unix timestamp (ms) when the snapshot was imported, if applicable. */
  entityListImportedAt: number | null;
  /** User-supplied label for the imported snapshot file, if applicable. */
  entityListSourceLabel: string | null;
  screenedCount: number;
  directMatches: AmlDirectMatch[];
  nearestHopDistance: number | null;
  nearestHopEntityName: string | null;
  nearestHopCategoryLabel: string | null;
  hasGraphData: boolean;
}

export async function runAmlScreening(addresses: string[]): Promise<AmlScreeningResult> {
  const screeningDate = new Date().toISOString().slice(0, 10);
  const entityListSource = getActiveEntitySource();
  const entityListCount = getActiveEntityCount();

  // Fetch optional snapshot metadata (importedAt + sourceLabel) from settings.
  const { getSettings } = await import("@/lib/data/settings-crud");
  const settings = await getSettings("default");
  const snap = (settings as any)?.entityListSnapshot as
    | { importedAt?: number; sourceLabel?: string }
    | undefined;
  const entityListImportedAt = snap?.importedAt ?? null;
  const entityListSourceLabel = snap?.sourceLabel ?? null;

  const directEntityMap = lookupEntities(addresses);
  const directMatches: AmlDirectMatch[] = [];
  for (const [addr, entry] of directEntityMap) {
    directMatches.push({
      address: addr,
      entityName: entry.name,
      categoryLabel: ENTITY_CATEGORY_LABELS[entry.category],
      sourceNote: entry.sourceNote,
    });
  }

  const { getParticipantsByAddresses } = await import("@/lib/data/record-queries");
  const { getParticipantsByTxids } = await import("@/lib/data/transaction-crud");

  const ownParticipants = await getParticipantsByAddresses(addresses);

  if (ownParticipants.length === 0) {
    return {
      screeningDate,
      entityListSource,
      entityListCount,
      entityListImportedAt,
      entityListSourceLabel,
      screenedCount: addresses.length,
      directMatches,
      nearestHopDistance: null,
      nearestHopEntityName: null,
      nearestHopCategoryLabel: null,
      hasGraphData: false,
    };
  }

  const ourTxids = [...new Set(ownParticipants.map((p) => p.txid))];
  const MAX_TXIDS = 2000;
  const txidSlice = ourTxids.slice(0, MAX_TXIDS);

  const BATCH = 500;
  const allParts: typeof ownParticipants = [];
  for (let i = 0; i < txidSlice.length; i += BATCH) {
    const batch = txidSlice.slice(i, i + BATCH);
    const parts = await getParticipantsByTxids(batch);
    allParts.push(...parts);
  }

  const addressToTxids = new Map<string, string[]>();
  for (const p of allParts) {
    const list = addressToTxids.get(p.address);
    if (list) list.push(p.txid);
    else addressToTxids.set(p.address, [p.txid]);
  }

  const txidToParticipants = new Map<string, typeof allParts>();
  for (const p of allParts) {
    const list = txidToParticipants.get(p.txid);
    if (list) list.push(p);
    else txidToParticipants.set(p.txid, [p]);
  }

  const graphAddresses = Array.from(addressToTxids.keys());
  const entityInGraph = lookupEntities(graphAddresses);

  if (entityInGraph.size === 0) {
    return {
      screeningDate,
      entityListSource,
      entityListCount,
      entityListImportedAt,
      entityListSourceLabel,
      screenedCount: addresses.length,
      directMatches,
      nearestHopDistance: null,
      nearestHopEntityName: null,
      nearestHopCategoryLabel: null,
      hasGraphData: true,
    };
  }

  const ownedSet = new Set(addresses);
  const MAX_HOPS = 4;
  const MAX_NODES = 500;

  let globalMinHop = Infinity;
  let globalMinEntityName: string | null = null;
  let globalMinCategoryLabel: string | null = null;

  for (const startAddr of addresses) {
    if (!addressToTxids.has(startAddr)) continue;

    const visited = new Set<string>([startAddr]);
    const visitedTxids = new Set<string>();
    let frontier = [startAddr];

    for (let hop = 1; hop <= MAX_HOPS && frontier.length > 0; hop++) {
      const nextFrontier: string[] = [];
      for (const addr of frontier) {
        const txids = addressToTxids.get(addr) ?? [];
        for (const txid of txids) {
          if (visitedTxids.has(txid)) continue;
          visitedTxids.add(txid);
          const parts = txidToParticipants.get(txid) ?? [];
          for (const p of parts) {
            if (!p.address || visited.has(p.address)) continue;
            visited.add(p.address);
            const entity = entityInGraph.get(p.address);
            if (entity) {
              if (hop < globalMinHop) {
                globalMinHop = hop;
                globalMinEntityName = entity.name;
                globalMinCategoryLabel = ENTITY_CATEGORY_LABELS[entity.category];
              }
            } else if (!ownedSet.has(p.address)) {
              nextFrontier.push(p.address);
            }
          }
        }
      }
      frontier = nextFrontier;
      if (visited.size > MAX_NODES) break;
    }
  }

  return {
    screeningDate,
    entityListSource,
    entityListCount,
    entityListImportedAt,
    entityListSourceLabel,
    screenedCount: addresses.length,
    directMatches,
    nearestHopDistance: globalMinHop === Infinity ? null : globalMinHop,
    nearestHopEntityName: globalMinEntityName,
    nearestHopCategoryLabel: globalMinCategoryLabel,
    hasGraphData: true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
/** PDF document format version embedded in every generated document. */
const KYUTXO_APP_VERSION = "1.1.28";

// ────────────────────────────────────────────────────────────────────────────
// Persisted declaration preferences (attestation + glossary toggles)
// ────────────────────────────────────────────────────────────────────────────
const DECLARATION_PREFS_KEY = "kyutxo.proofOfFunds.declarationPrefs";

interface DeclarationPrefs {
  includeIntro: boolean;
  includeAttestation: boolean;
  attestationPlaceOfSigning: string;
  attestationWitnessLine: string;
  includeGlossary: boolean;
}

const DEFAULT_DECLARATION_PREFS: DeclarationPrefs = {
  includeIntro: false,
  includeAttestation: false,
  attestationPlaceOfSigning: "",
  attestationWitnessLine: "",
  includeGlossary: false,
};

function loadDeclarationPrefs(): DeclarationPrefs {
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

function saveDeclarationPrefs(prefs: DeclarationPrefs) {
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
const DECLARATION_INTRO_PARAGRAPHS: string[] = [
  "Bitcoin is a digital bearer asset that can be held in self-custody without the involvement of a financial intermediary. The Bitcoin blockchain acts as the pseudonymous ledger for self-custodied Bitcoin. Many objective aspects of Bitcoin can be independently verified through its publicly accessible blockchain ledger, including the existence of specific addresses, transaction history, and current balances. This declaration therefore relies on those publicly verifiable records wherever possible. Ownership and control are established through exclusive possession of the corresponding private cryptographic keys. As a result, the undersigned, as the holder of the private keys controlling the referenced Bitcoin address(es), is the individual best positioned to attest to the ownership and control of these assets.",
  "Where appropriate, supporting evidence may include blockchain explorer records, cryptographic message signing, and other technical means of demonstrating control over the referenced Bitcoin addresses.",
];

export default function ProofOfFundsDeclaration() {
  const { nodeSettings } = useNodeSettings();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { toast } = useToast();
  const { openRecordEdit } = useRecordPreview();

  // Address records, kept live so the provenance summary in Step 7 updates
  // immediately after a record is edited from the "Fill in missing fields"
  // quick-action.
  const addressRecords = useLiveQuery(() => getRecordsByType("address"), []);

  // Address input
  const [addressTab, setAddressTab] = useState<"paste" | "vault">("paste");
  const [pastedText, setPastedText] = useState("");
  const [filterOwner, setFilterOwner] = useState<string>("all");
  const [filterWallet, setFilterWallet] = useState<string>("all");

  // Balance resolution
  const [balanceSource, setBalanceSource] = useState<BalanceSource>("offline");
  const [rows, setRows] = useState<AddressRow[]>([]);
  const [dupes, setDupes] = useState(0);
  const [isChecking, setIsChecking] = useState(false);
  const [summary, setSummary] = useState<BalanceSummary | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // Declarant form
  const [declarantName, setDeclarantName] = useState("");
  const [declarantContact, setDeclarantContact] = useState("");
  const [declarantResidentialAddress, setDeclarantResidentialAddress] = useState("");
  const [declarantDob, setDeclarantDob] = useState("");
  const [declarantTaxId, setDeclarantTaxId] = useState("");
  const [declarantIdNumber, setDeclarantIdNumber] = useState("");
  const [declarantNationality, setDeclarantNationality] = useState("");
  const [declarationDate, setDeclarationDate] = useState(todayString());
  const [purpose, setPurpose] = useState("");
  const [statement, setStatement] = useState("");

  // Declaration nonce — generated once per page session
  const [declarationNonce] = useState<string>(() => generateDeclarationNonce());

  // Proof of control
  // Map of address -> per-address control verification state
  const [controlStates, setControlStates] = useState<Record<string, ControlState>>({});
  // Track which addresses' challenge messages have been copied
  const [copiedAddresses, setCopiedAddresses] = useState<Set<string>>(new Set());

  // Optional add-ons for Step 5 (both off by default)
  const [proofAddonsOpen, setProofAddonsOpen] = useState(false);
  const [verifierReference, setVerifierReference] = useState("");
  const [freshnessAnchorEnabled, setFreshnessAnchorEnabled] = useState(false);
  const [freshnessAnchor, setFreshnessAnchor] = useState<FreshnessAnchor | null>(null);
  const [freshnessAnchorFetching, setFreshnessAnchorFetching] = useState(false);
  const [freshnessAnchorError, setFreshnessAnchorError] = useState<string | null>(null);
  const [freshnessManualHeight, setFreshnessManualHeight] = useState("");
  const [freshnessManualHash, setFreshnessManualHash] = useState("");

  // When declarant identity fields OR proof-of-control add-ons change, any
  // previously-verified signatures are no longer valid (the challenge message
  // they signed has changed).
  const prevDeclarantRef = useRef({
    name: declarantName,
    date: declarationDate,
    purpose,
    verifierReference,
    freshnessAnchor: null as FreshnessAnchor | null,
    freshnessAnchorEnabled,
  });
  useEffect(() => {
    const prev = prevDeclarantRef.current;
    if (
      prev.name !== declarantName ||
      prev.date !== declarationDate ||
      prev.purpose !== purpose ||
      prev.verifierReference !== verifierReference ||
      prev.freshnessAnchor !== freshnessAnchor ||
      prev.freshnessAnchorEnabled !== freshnessAnchorEnabled
    ) {
      prevDeclarantRef.current = { name: declarantName, date: declarationDate, purpose, verifierReference, freshnessAnchor, freshnessAnchorEnabled };
      setControlStates((prev) => {
        const updated: Record<string, ControlState> = {};
        for (const [addr, cs] of Object.entries(prev)) {
          if (cs.status === "verified") {
            updated[addr] = { paste: cs.paste, status: "idle", staleAfterVerify: true };
          } else {
            updated[addr] = cs;
          }
        }
        return updated;
      });
    }
  }, [declarantName, declarationDate, purpose, verifierReference, freshnessAnchor, freshnessAnchorEnabled]);

  // Fiat
  const [fiatCurrency, setFiatCurrency] = useState("USD");
  const [fiatRate, setFiatRate] = useState("");

  // Balance-verification QR codes (optional)
  const [includeQr, setIncludeQr] = useState(false);
  const [qrExplorerId, setQrExplorerId] = useState<ExplorerId>("mempool");
  // address -> generated QR data URL for the on-screen preview
  const [qrPreviews, setQrPreviews] = useState<Record<string, string>>({});

  // Acquisition & Provenance section (optional, off by default)
  const [includeProvenance, setIncludeProvenance] = useState(false);
  const [provenanceFiatCurrency, setProvenanceFiatCurrency] = useState("USD");

  // Attestation block (optional, off by default). Initial values are restored
  // from the persisted declaration preferences (see loadDeclarationPrefs).
  const [includeAttestation, setIncludeAttestation] = useState(
    () => loadDeclarationPrefs().includeAttestation,
  );
  const [attestationPlaceOfSigning, setAttestationPlaceOfSigning] = useState(
    () => loadDeclarationPrefs().attestationPlaceOfSigning,
  );
  const [attestationWitnessLine, setAttestationWitnessLine] = useState(
    () => loadDeclarationPrefs().attestationWitnessLine,
  );

  // Glossary (optional, off by default). Restored from persisted preferences.
  const [includeGlossary, setIncludeGlossary] = useState(
    () => loadDeclarationPrefs().includeGlossary,
  );

  // Introduction / preface (optional, off by default). Restored from persisted
  // preferences. When on, a plain-language preface is added to the top of the PDF.
  const [includeIntro, setIncludeIntro] = useState(
    () => loadDeclarationPrefs().includeIntro,
  );

  // Persist declaration preferences whenever any of them changes so they are
  // restored on the next page load.
  useEffect(() => {
    saveDeclarationPrefs({
      includeIntro,
      includeAttestation,
      attestationPlaceOfSigning,
      attestationWitnessLine,
      includeGlossary,
    });
  }, [
    includeIntro,
    includeAttestation,
    attestationPlaceOfSigning,
    attestationWitnessLine,
    includeGlossary,
  ]);

  // AML / Risk Screening section (optional, off by default)
  const [includeAml, setIncludeAml] = useState(false);
  const [amlPepStatus, setAmlPepStatus] = useState<"not-stated" | "yes" | "no">("not-stated");
  const [amlTaxJurisdiction, setAmlTaxJurisdiction] = useState("");
  const [amlSourceOfWealth, setAmlSourceOfWealth] = useState("");
  const [amlSourceOfFunds, setAmlSourceOfFunds] = useState("");
  const [amlTaxStatement, setAmlTaxStatement] = useState("");
  const [amlScreeningResult, setAmlScreeningResult] = useState<AmlScreeningResult | null>(null);
  const [isComputingAml, setIsComputingAml] = useState(false);

  // PDF generating
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isGeneratingSamplePdf, setIsGeneratingSamplePdf] = useState(false);

  // Supporting Evidence (optional) — session-only; binary is never persisted.
  const [evidenceItems, setEvidenceItems] = useState<EvidenceItem[]>([]);
  const [isAddingEvidence, setIsAddingEvidence] = useState(false);
  const evidenceInputRef = useRef<HTMLInputElement>(null);

  const handleEvidenceFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const incoming = Array.from(files);
      setIsAddingEvidence(true);
      try {
        const room = EVIDENCE_MAX_ITEMS - evidenceItems.length;
        if (room <= 0) {
          toast({
            title: "Evidence limit reached",
            description: `You can attach up to ${EVIDENCE_MAX_ITEMS} files.`,
            variant: "destructive",
          });
          return;
        }
        const toProcess = incoming.slice(0, room);
        const skippedForLimit = incoming.length - toProcess.length;
        const added: EvidenceItem[] = [];
        const errors: string[] = [];
        let runningTotal = evidenceItems.reduce((sum, it) => sum + it.size, 0);
        for (const file of toProcess) {
          const mime = file.type;
          const isImage = EVIDENCE_IMAGE_MIMES.includes(mime);
          const isPdf = mime === "application/pdf";
          if (!isImage && !isPdf) {
            errors.push(`${file.name}: unsupported file type`);
            continue;
          }
          if (file.size > EVIDENCE_MAX_FILE_BYTES) {
            errors.push(
              `${file.name}: larger than ${EVIDENCE_MAX_FILE_BYTES / (1024 * 1024)} MB`,
            );
            continue;
          }
          if (runningTotal + file.size > EVIDENCE_MAX_TOTAL_BYTES) {
            errors.push(
              `${file.name}: skipped — would exceed the ${EVIDENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB combined limit`,
            );
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const sha256 = await hashBytesHex(bytes);
          // Reserve this file's bytes against the combined cap so later files in
          // the same batch see an accurate running total.
          runningTotal += file.size;
          if (isPdf) {
            let pageCount: number;
            try {
              pageCount = await countPdfPages(bytes);
            } catch {
              // Not actually added — release its reserved bytes.
              runningTotal -= file.size;
              errors.push(
                `${file.name}: could not be read as a PDF (it may be corrupted or password-protected)`,
              );
              continue;
            }
            added.push({
              id: nextEvidenceId(),
              name: file.name,
              kind: "pdf",
              mime,
              bytes,
              caption: "",
              sha256,
              size: file.size,
              pageCount,
            });
          } else {
            added.push({
              id: nextEvidenceId(),
              name: file.name,
              kind: "image",
              mime,
              bytes,
              dataUrl: imageBytesToDataUrl(bytes, mime),
              caption: "",
              sha256,
              size: file.size,
            });
          }
        }
        if (added.length) setEvidenceItems((prev) => [...prev, ...added]);
        if (errors.length || skippedForLimit) {
          const parts = [...errors];
          if (skippedForLimit) {
            parts.push(
              `${skippedForLimit} file(s) skipped (limit of ${EVIDENCE_MAX_ITEMS})`,
            );
          }
          toast({
            title: added.length
              ? "Some files were not added"
              : "No files were added",
            description: parts.join("; "),
            variant: "destructive",
          });
        }
      } finally {
        setIsAddingEvidence(false);
        if (evidenceInputRef.current) evidenceInputRef.current.value = "";
      }
    },
    [evidenceItems.length, toast],
  );

  const removeEvidenceItem = useCallback((id: string) => {
    setEvidenceItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const clearEvidence = useCallback(() => setEvidenceItems([]), []);

  const updateEvidenceCaption = useCallback((id: string, caption: string) => {
    setEvidenceItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, caption } : it)),
    );
  }, []);

  const evidenceImageCount = useMemo(
    () => evidenceItems.filter((it) => it.kind === "image").length,
    [evidenceItems],
  );
  const evidencePdfItems = useMemo(
    () => evidenceItems.filter((it) => it.kind === "pdf"),
    [evidenceItems],
  );

  // Expanded invalid section
  const [showInvalid, setShowInvalid] = useState(false);

  const validRows = useMemo(() => rows.filter((r) => !r.isInvalid), [rows]);
  const invalidRows = useMemo(() => rows.filter((r) => r.isInvalid), [rows]);
  const doneRows = useMemo(() => validRows.filter((r) => r.status === "done"), [validRows]);
  const emptyRows = useMemo(() => validRows.filter((r) => r.status === "empty"), [validRows]);
  const errorRows = useMemo(() => validRows.filter((r) => r.status === "error"), [validRows]);
  const hasResults = rows.length > 0;

  const fiatRateNum = parseFloat(fiatRate);
  const fiatValid = fiatRate.trim() !== "" && !isNaN(fiatRateNum) && fiatRateNum > 0;

  const totalSats = useMemo(
    () => doneRows.reduce((sum, r) => sum + (r.balanceSats ?? 0), 0),
    [doneRows]
  );

  const fiatTotal = fiatValid && summary ? (totalSats / 1e8) * fiatRateNum : null;

  // Per-address provenance completeness for the Step 7 summary. Mirrors the
  // fields the Acquisition & Provenance appendix reads from each address
  // record so users can see (and fill in) what's missing before generating.
  const provenanceStatus = useMemo(() => {
    const byAddress = new Map<string, NonNullable<typeof addressRecords>[number]>();
    for (const rec of addressRecords ?? []) {
      byAddress.set(rec.inputString, rec);
    }
    return doneRows.map((row) => {
      const rec = byAddress.get(row.raw);
      const hasRecord = !!rec;
      const hasCounterparty =
        !!(rec?.counterpartyName?.trim() || rec?.walletName?.trim() || rec?.label?.trim() || rec?.counterpartyType);
      const missing: string[] = [];
      if (hasRecord) {
        if (!rec?.date) missing.push("Acquisition date");
        if (!rec?.acquisitionMethod) missing.push("Acquisition method");
        if (!hasCounterparty) missing.push("Counterparty");
        if (!(rec?.costBasisUsd && rec.costBasisUsd > 0)) missing.push("Cost basis");
      }
      return {
        address: row.raw,
        recordId: rec?.id,
        hasRecord,
        missing,
      };
    });
  }, [doneRows, addressRecords]);

  const provenanceIncompleteCount = useMemo(
    () => provenanceStatus.filter((s) => !s.hasRecord || s.missing.length > 0).length,
    [provenanceStatus]
  );

  // Proof-of-control summary counts
  const verifiedCount = useMemo(
    () => doneRows.filter((r) => controlStates[r.raw]?.status === "verified").length,
    [doneRows, controlStates]
  );

  // Live on-screen preview of the declarant details. Mirrors the PDF builder:
  // required fields always appear once filled, and each optional identity field
  // only contributes a row when it is non-blank (no stray labels for empty
  // fields). Keeping this list in lockstep with the PDF prevents the preview
  // from drifting from the exported document.
  const declarantPreviewRows = useMemo(() => {
    const previewRows: { key: string; label: string; value: string; testid: string }[] = [];
    if (declarantName.trim())
      previewRows.push({ key: "name", label: "Full Name:", value: declarantName, testid: "preview-declarant-name" });
    if (declarantContact.trim())
      previewRows.push({ key: "contact", label: "Contact / Address:", value: declarantContact, testid: "preview-declarant-contact" });
    if (declarantResidentialAddress.trim())
      previewRows.push({ key: "residential", label: "Residential / Street Address:", value: declarantResidentialAddress, testid: "preview-declarant-residential-address" });
    if (declarantDob.trim())
      previewRows.push({ key: "dob", label: "Date of Birth:", value: declarantDob, testid: "preview-declarant-dob" });
    if (declarantTaxId.trim())
      previewRows.push({ key: "taxid", label: "Tax ID Number:", value: declarantTaxId, testid: "preview-declarant-tax-id" });
    if (declarantIdNumber.trim())
      previewRows.push({ key: "idnumber", label: "Identification Number:", value: declarantIdNumber, testid: "preview-declarant-id-number" });
    if (declarantNationality.trim())
      previewRows.push({ key: "nationality", label: "Nationality:", value: declarantNationality, testid: "preview-declarant-nationality" });
    if (declarationDate)
      previewRows.push({ key: "date", label: "Declaration Date:", value: declarationDate, testid: "preview-declaration-date" });
    if (purpose.trim())
      previewRows.push({ key: "purpose", label: "Purpose:", value: purpose, testid: "preview-purpose" });
    return previewRows;
  }, [
    declarantName,
    declarantContact,
    declarantResidentialAddress,
    declarantDob,
    declarantTaxId,
    declarantIdNumber,
    declarantNationality,
    declarationDate,
    purpose,
  ]);

  // Live preview of the declarant self-attestation lines, derived purely from
  // the attestation inputs. These mirror — word-for-word — the strings written
  // into the PDF's "DECLARANT SELF-ATTESTATIONS" section, so the user gets
  // immediate visual confirmation of what that section will contain as they
  // type. Purely derived from state; no DB query or sanitization needed (the
  // PDF's sanitizePdfText only strips characters the PDF renderer can't draw).
  const attestationPreviewLines = useMemo(
    () =>
      buildAttestationLines({
        pepStatus: amlPepStatus,
        sourceOfWealth: amlSourceOfWealth,
        sourceOfFunds: amlSourceOfFunds,
        taxJurisdiction: amlTaxJurisdiction,
        taxStatement: amlTaxStatement,
      }),
    [amlPepStatus, amlSourceOfWealth, amlSourceOfFunds, amlTaxJurisdiction, amlTaxStatement],
  );

  // Stable key for the set of addresses we have balances for, so the QR preview
  // effect only regenerates when the actual addresses (not the array ref) change.
  const doneAddressKey = useMemo(() => doneRows.map((r) => r.raw).join("|"), [doneRows]);

  // Generate the on-screen QR previews offline whenever the toggle, explorer, or
  // address set changes. QRCode.toDataURL never touches the network — it draws
  // the code locally and returns a data: URL.
  useEffect(() => {
    if (!includeQr || doneRows.length === 0) {
      setQrPreviews({});
      return;
    }
    let cancelled = false;
    const explorer = getExplorer(qrExplorerId);
    // Drop any previous codes immediately so we never show stale images under a
    // newly selected explorer label while the new codes are being drawn.
    setQrPreviews({});
    (async () => {
      const map: Record<string, string> = {};
      for (const r of doneRows) {
        try {
          map[r.raw] = await QRCode.toDataURL(explorer.addressUrl(r.raw), {
            width: 240,
            margin: 1,
            errorCorrectionLevel: "M",
          });
        } catch {
          // Skip a single failed code rather than failing the whole preview.
        }
      }
      if (!cancelled) setQrPreviews(map);
    })();
    return () => {
      cancelled = true;
    };
    // doneAddressKey captures the address set; doneRows ref is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeQr, qrExplorerId, doneAddressKey]);

  // Recompute AML screening whenever the toggle turns on or the address set changes.
  useEffect(() => {
    if (!includeAml || doneRows.length === 0) {
      setAmlScreeningResult(null);
      return;
    }
    let cancelled = false;
    setIsComputingAml(true);
    runAmlScreening(doneRows.map((r) => r.raw))
      .then((result) => {
        if (!cancelled) {
          setAmlScreeningResult(result);
          setIsComputingAml(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsComputingAml(false);
      });
    return () => {
      cancelled = true;
    };
    // doneAddressKey captures the address set; doneRows ref is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeAml, doneAddressKey]);

  const canGeneratePdf =
    doneRows.length > 0 &&
    declarantName.trim() !== "" &&
    declarationDate !== "" &&
    purpose.trim() !== "" &&
    !isChecking;

  const resolveAddresses = useCallback(async (): Promise<string[]> => {
    if (addressTab === "paste") {
      return pastedText
        .split(/[\n,;]+/)
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
    }
    const allRecords = await getRecordsByType("address");
    let filtered = allRecords;
    if (filterOwner !== "all") filtered = filtered.filter((r) => r.owner === filterOwner);
    if (filterWallet !== "all") filtered = filtered.filter((r) => r.walletName === filterWallet);
    return filtered.map((r) => r.inputString).filter((s) => s.length > 0);
  }, [addressTab, pastedText, filterOwner, filterWallet]);

  const runCheck = useCallback(async () => {
    setProviderError(null);
    setSummary(null);

    const rawAddresses = await resolveAddresses();
    if (rawAddresses.length === 0) {
      toast({ title: "No Addresses", description: "Please enter or select at least one address." });
      return;
    }

    const { rows: parsed, dupes: d } = parseAddressInput(rawAddresses.join("\n"));
    setRows(parsed);
    setDupes(d);
    setIsChecking(true);
    cancelledRef.current = false;

    const validIndices = parsed
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.isInvalid);

    if (balanceSource === "live") {
      let provider: ReturnType<typeof createProviderFromSettings>;
      try {
        provider = createProviderFromSettings(nodeSettings);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to create provider.";
        setProviderError(msg);
        setIsChecking(false);
        return;
      }

      let blockHeight: number | undefined;
      try {
        blockHeight = await provider.getBlockHeight();
      } catch {
        // Non-fatal — still proceed without block height
      }

      const nowTs = Math.floor(Date.now() / 1000);

      const fetchBalanceSats = async (
        address: string,
        signal?: AbortSignal,
      ): Promise<number> => {
        if (provider.getAddressCoreStats) {
          const info = await provider.getAddressCoreStats(address, signal);
          return info.balanceSats ?? 0;
        } else if (provider.getAddressInfo) {
          const info = await provider.getAddressInfo(address);
          return info.balanceSats ?? 0;
        } else {
          const { computeHistoryFromTxs } = await import("@/lib/providers/address-history");
          const txs = await provider.getAddressTransactions(address);
          const history = computeHistoryFromTxs(address, txs);
          return (history.receivedSats ?? 0) - (history.sentSats ?? 0);
        }
      };

      let isFirstAttempt = true;
      let hadSuccess = false;
      let consecutiveNodeFailures = 0;
      for (const { i } of validIndices) {
        if (cancelledRef.current) break;
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "loading" } : r)));
        const address = parsed[i].raw;
        const attemptIsFirst = isFirstAttempt;
        try {
          let balanceSats: number;
          if (attemptIsFirst) {
            // Cap the very first attempt so an unreachable node fails fast instead
            // of hanging for the full per-request timeout on every address. Abort
            // the in-flight request and reject the race once the cap is hit.
            const controller = new AbortController();
            let probeTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              balanceSats = await Promise.race([
                fetchBalanceSats(address, controller.signal),
                new Promise<number>((_, reject) => {
                  probeTimer = setTimeout(() => {
                    controller.abort(
                      new DOMException("Node probe timed out", "TimeoutError"),
                    );
                    reject(
                      new Error(
                        `Node unreachable — no response within ${NODE_PROBE_TIMEOUT_MS / 1000}s.`,
                      ),
                    );
                  }, NODE_PROBE_TIMEOUT_MS);
                }),
              ]);
            } finally {
              if (probeTimer) clearTimeout(probeTimer);
            }
          } else {
            balanceSats = await fetchBalanceSats(address);
          }
          isFirstAttempt = false;
          hadSuccess = true;
          consecutiveNodeFailures = 0;
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? { ...r, status: balanceSats === 0 ? "empty" : "done", balanceSats }
                : r
            )
          );
        } catch (err) {
          if (cancelledRef.current) break;
          const nodeUnreachable = isNodeUnreachableError(err);
          // On the first attempt, a node-level connectivity failure means the
          // node is unreachable: fail the whole check immediately rather than
          // grinding through every address. Transient/per-address errors still
          // surface per-row (here and on later addresses).
          if (attemptIsFirst && nodeUnreachable) {
            setProviderError(
              "Node unreachable — the on-chain balance check could not reach your node.",
            );
            setRows((prev) =>
              prev.map((r) => (r.status === "loading" ? { ...r, status: "pending" } : r))
            );
            setIsChecking(false);
            return;
          }
          isFirstAttempt = false;
          // After a successful start, the node going down partway through shows up
          // as a run of consecutive node-unreachable failures. Short-circuit the
          // whole check rather than grinding through the rest one timeout at a
          // time. A single transient failure (or any non-node error) stays below
          // the threshold and resets the run, so isolated 429/500/404s continue.
          if (nodeUnreachable) {
            consecutiveNodeFailures += 1;
          } else {
            consecutiveNodeFailures = 0;
          }
          if (
            hadSuccess &&
            nodeUnreachable &&
            consecutiveNodeFailures >= NODE_UNREACHABLE_CONSECUTIVE_LIMIT
          ) {
            setProviderError(
              "Node unreachable — the on-chain balance check could not reach your node.",
            );
            setRows((prev) =>
              prev.map((r) =>
                r.status === "loading" ? { ...r, status: "pending" } : r,
              ),
            );
            setIsChecking(false);
            return;
          }
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? { ...r, status: "error", error: err instanceof Error ? err.message : "Lookup failed" }
                : r
            )
          );
        }
      }

      if (!cancelledRef.current) {
        const asOfLabel = blockHeight
          ? `Live on-chain check — block ${blockHeight.toLocaleString()} (${formatUnix(nowTs)})`
          : `Live on-chain check — ${formatUnix(nowTs)}`;
        setSummary({
          totalSats: 0,
          source: "live",
          asOfLabel,
          blockHeight,
          timestamp: nowTs,
        });
      }
    } else {
      const validAddresses = validIndices.map(({ r }) => r.raw);
      setRows((prev) =>
        prev.map((r) => (!r.isInvalid ? { ...r, status: "loading" } : r))
      );

      try {
        const statsMap = await computeStatsForAddresses(validAddresses);

        let lastSyncTime: number | undefined;
        try {
          const allRecords = await getRecordsByType("address");
          const relevantRecords = allRecords.filter((rec) =>
            validAddresses.includes(rec.inputString)
          );
          const syncTimes = relevantRecords
            .map((r) => r.statsComputedAt)
            .filter((t): t is number => t !== undefined && t > 0);
          if (syncTimes.length > 0) {
            lastSyncTime = Math.max(...syncTimes);
          }
        } catch {
          // Non-fatal
        }

        setRows((prev) =>
          prev.map((r) => {
            if (r.isInvalid) return r;
            const stats = statsMap.get(r.raw);
            const balanceSats = stats ? stats.balanceSats : 0;
            return { ...r, status: balanceSats === 0 ? "empty" : "done", balanceSats };
          })
        );

        const asOfLabel = lastSyncTime
          ? `Offline vault data — last synced ${formatUnix(lastSyncTime)}`
          : "Offline vault data (sync time unavailable)";

        setSummary({
          totalSats: 0,
          source: "offline",
          asOfLabel,
          timestamp: lastSyncTime,
        });
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Offline Balance Failed",
          description: err instanceof Error ? err.message : "Failed to compute balances from vault.",
        });
        setRows((prev) =>
          prev.map((r) =>
            !r.isInvalid
              ? { ...r, status: "error", error: "Failed to compute offline balance" }
              : r
          )
        );
      }
    }

    setIsChecking(false);
  }, [resolveAddresses, balanceSource, nodeSettings, toast]);

  const handleCancel = () => {
    cancelledRef.current = true;
    setIsChecking(false);
  };

  const handleReset = () => {
    cancelledRef.current = true;
    setIsChecking(false);
    setRows([]);
    setDupes(0);
    setSummary(null);
    setProviderError(null);
    setPastedText("");
    setControlStates({});
    setCopiedAddresses(new Set());
  };

  // Fetch current block height + hash for the freshness anchor
  const fetchFreshnessAnchor = useCallback(async () => {
    setFreshnessAnchorFetching(true);
    setFreshnessAnchorError(null);
    setFreshnessAnchor(null);
    try {
      const provider = createProviderFromSettings(nodeSettings);
      const height = await provider.getBlockHeight();
      let hash: string;
      if (provider.getTipBlockHash) {
        hash = (await provider.getTipBlockHash()).trim();
      } else {
        throw new Error("Connected provider does not support block-hash lookup. Use the manual entry below.");
      }
      const fetchedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
      setFreshnessAnchor({ height, hash, fetchedAt });
      setFreshnessManualHeight(String(height));
      setFreshnessManualHash(hash);
    } catch (err) {
      setFreshnessAnchorError(err instanceof Error ? err.message : "Failed to fetch block data.");
    } finally {
      setFreshnessAnchorFetching(false);
    }
  }, [nodeSettings]);

  // Validate the manually-entered freshness anchor inputs
  const freshnessManualHeightError = useMemo(() => {
    const raw = freshnessManualHeight.trim();
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return "Height must be a whole number.";
    if (parseInt(raw, 10) <= 0) return "Height must be greater than zero.";
    return null;
  }, [freshnessManualHeight]);

  const freshnessManualHashError = useMemo(() => {
    const raw = freshnessManualHash.trim();
    if (!raw) return null;
    if (!/^[0-9a-f]{64}$/.test(raw)) {
      return "Block hash must be exactly 64 lowercase hex characters.";
    }
    return null;
  }, [freshnessManualHash]);

  const canApplyManualFreshnessAnchor =
    /^\d+$/.test(freshnessManualHeight.trim()) &&
    parseInt(freshnessManualHeight.trim(), 10) > 0 &&
    /^[0-9a-f]{64}$/.test(freshnessManualHash.trim());

  // Apply manually-entered height + hash as the freshness anchor
  const applyManualFreshnessAnchor = useCallback(() => {
    const raw = freshnessManualHeight.trim();
    const hash = freshnessManualHash.trim();
    if (!/^\d+$/.test(raw)) return;
    const h = parseInt(raw, 10);
    if (h <= 0) return;
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    const fetchedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    setFreshnessAnchor({ height: h, hash, fetchedAt });
    setFreshnessAnchorError(null);
  }, [freshnessManualHeight, freshnessManualHash]);

  const handleCopyChallenge = useCallback(
    (address: string) => {
      const msg = buildChallengeMessage({
        address,
        declarantName,
        declarationDate,
        purpose,
        nonce: declarationNonce,
        verifierReference: verifierReference || undefined,
        freshnessAnchor: freshnessAnchor ?? undefined,
      });
      navigator.clipboard.writeText(msg).then(() => {
        setCopiedAddresses((prev) => new Set(prev).add(address));
        setTimeout(() => {
          setCopiedAddresses((prev) => {
            const next = new Set(prev);
            next.delete(address);
            return next;
          });
        }, 2000);
      });
    },
    [declarantName, declarationDate, purpose, declarationNonce, verifierReference, freshnessAnchor]
  );

  // Per-address: update pasted signature text
  const handleSignaturePaste = useCallback((address: string, value: string) => {
    setControlStates((prev) => ({
      ...prev,
      [address]: { ...prev[address], paste: value, status: "idle", error: undefined, verifiedSig: undefined },
    }));
  }, []);

  // Per-address: verify pasted signature
  const handleVerify = useCallback(
    async (address: string) => {
      const cs = controlStates[address];
      const paste = cs?.paste?.trim() ?? "";
      if (!paste) {
        setControlStates((prev) => ({
          ...prev,
          [address]: { ...prev[address], status: "failed", error: "Paste a signature first." },
        }));
        return;
      }

      setControlStates((prev) => ({
        ...prev,
        [address]: { ...prev[address], status: "verifying", error: undefined },
      }));

      const message = buildChallengeMessage({
        address,
        declarantName,
        declarationDate,
        purpose,
        nonce: declarationNonce,
        verifierReference: verifierReference || undefined,
        freshnessAnchor: freshnessAnchor ?? undefined,
      });

      try {
        const result = await verifyBitcoinSignature(address, message, paste);
        if (result.verified) {
          setControlStates((prev) => ({
            ...prev,
            [address]: { paste, status: "verified", verifiedSig: paste, verifiedFormat: result.format },
          }));
        } else {
          setControlStates((prev) => ({
            ...prev,
            [address]: { paste, status: "failed", error: result.error },
          }));
        }
      } catch (err) {
        setControlStates((prev) => ({
          ...prev,
          [address]: {
            paste,
            status: "failed",
            error: err instanceof Error ? err.message : "Verification failed unexpectedly.",
          },
        }));
      }
    },
    [controlStates, declarantName, declarationDate, purpose, declarationNonce, verifierReference, freshnessAnchor]
  );

  // ── Shared PDF builder — called by both generatePdf and generateSamplePdf ──
  // When isSample=true: uses placeholder data, adds a watermark on every page,
  // emits a specimen fingerprint label, and skips real DB / AML lookups — but
  // uses the SAME section ordering, page structure, and conditional gates as the
  // real path so users can approve the exact layout before filling in their data.
  const buildPofPdf = useCallback(async (isSample: boolean) => {
    const jsPDFModule = await import("jspdf");
    const autoTableModule = await import("jspdf-autotable");
    const jsPDF = jsPDFModule.default;
    const autoTable = autoTableModule.default;

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 14;
    const contentW = pageW - margin * 2;
    let y = 20;

    const addLine = (text: string, size = 10, bold = false, color: [number, number, number] = [0, 0, 0]) => {
      doc.setFontSize(size);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(sanitizePdfText(text), contentW) as string[];
      doc.text(lines, margin, y);
      y += lines.length * size * 0.5;
    };

    const addWrapped = (text: string, size = 9, color: [number, number, number] = [0, 0, 0]) => {
      doc.setFontSize(size);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(sanitizePdfText(text), contentW) as string[];
      doc.text(lines, margin, y);
      y += lines.length * size * 0.45 + 2;
    };

    const addSpacer = (h = 4) => { y += h; };

    const checkPageBreak = (needed = 20) => {
      const pageH = doc.internal.pageSize.getHeight();
      if (y + needed > pageH - 15) {
        doc.addPage();
        y = 20;
      }
    };

    // ── Sample placeholder data (used only when isSample=true) ──────────────
    const SAMPLE_NONCE = "SAMPLE0000000000";
    const SAMPLE_DATE_STR = declarationDate || new Date().toISOString().slice(0, 10);
    const SAMPLE_NAME = "Jane Q. Sample";
    const SAMPLE_CONTACT = "jane.sample@example.com";
    const SAMPLE_RESIDENTIAL = "123 Sample Street, Example City, EX1 2AB";
    const SAMPLE_DOB = "1985-01-01";
    const SAMPLE_TAX_ID = "SAMPLE-TAX-123";
    const SAMPLE_ID_NUMBER = "SAMPLE-ID-456789";
    const SAMPLE_NATIONALITY = "Sampleland";
    const SAMPLE_PURPOSE = "Format preview only — not a valid declaration";
    const SAMPLE_STATEMENT_TEXT =
      "This is a specimen statement for layout preview only. " +
      "All information in this document is entirely fictitious and must not be used as evidence of any kind.";

    // Typed row shape that carries verified-state inline (avoids repeated controlStates lookups)
    interface EffRow {
      raw: string;
      balanceSats: number;
      verified: boolean;
      verifiedSig?: string;
      verifiedFormat?: SignatureFormat;
    }

    const SAMPLE_EFF_ROWS: EffRow[] = [
      {
        raw: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        balanceSats: 125_000_000,
        verified: true,
        verifiedSig: "SAMPLE_SIGNATURE_PLACEHOLDER_NOT_VALID_DO_NOT_USE==",
        verifiedFormat: "legacy" as SignatureFormat,
      },
      { raw: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", balanceSats: 75_000_000, verified: false },
    ];

    // ── Effective data (switches between real and sample) ────────────────────
    const effName = isSample ? SAMPLE_NAME : declarantName;
    const effContact = isSample ? SAMPLE_CONTACT : declarantContact;
    const effResidential = isSample ? SAMPLE_RESIDENTIAL : declarantResidentialAddress;
    const effDob = isSample ? SAMPLE_DOB : declarantDob;
    const effTaxId = isSample ? SAMPLE_TAX_ID : declarantTaxId;
    const effIdNumber = isSample ? SAMPLE_ID_NUMBER : declarantIdNumber;
    const effNationality = isSample ? SAMPLE_NATIONALITY : declarantNationality;
    const effDate = isSample ? SAMPLE_DATE_STR : declarationDate;
    const effPurpose = isSample ? SAMPLE_PURPOSE : purpose;
    const effStatement = isSample ? SAMPLE_STATEMENT_TEXT : statement;
    const effNonce = isSample ? SAMPLE_NONCE : declarationNonce;

    const effRows: EffRow[] = isSample
      ? SAMPLE_EFF_ROWS
      : doneRows.map((r) => ({
          raw: r.raw,
          balanceSats: r.balanceSats ?? 0,
          verified: controlStates[r.raw]?.status === "verified",
          verifiedSig: controlStates[r.raw]?.verifiedSig,
          verifiedFormat: controlStates[r.raw]?.verifiedFormat,
        }));

    const effVerifiedRows = effRows.filter((r) => r.verified);
    const hasVerified = effVerifiedRows.length > 0;
    const allVerified = effRows.length > 0 && effVerifiedRows.length === effRows.length;
    const effTotalSats = isSample ? 200_000_000 : totalSats;
    const effFiatValid = isSample ? true : fiatValid;
    const effFiatRate = isSample ? 65_000 : fiatRateNum;
    const effFiatCurrency = isSample ? "USD" : fiatCurrency;
    const effFiatTotal: number | null = isSample
      ? (200_000_000 / 1e8) * 65_000
      : fiatTotal;
    const effSummary = isSample ? null : summary;

    // ── Content fingerprint ───────────────────────────────────────────────────
    const generationTimestamp = new Date();
    const generationIso = generationTimestamp.toISOString();

    let contentFingerprint: string;
    let canonicalPayload = "";

    if (isSample) {
      contentFingerprint = "SPECIMEN — NOT A VALID FINGERPRINT (sample PDF)";
    } else {
      // Gather verified addresses (needed for canonical payload)
      const verifiedRows = doneRows.filter((r) => controlStates[r.raw]?.status === "verified");
      const hasVerified = verifiedRows.length > 0;
      const allVerified = doneRows.length > 0 && verifiedRows.length === doneRows.length;

      // Canonical content covers every field that materially affects what is rendered
      // in the PDF — core declaration fields, all address data, proof-of-control
      // challenge messages and signatures for verified addresses, all optional-section
      // user inputs and toggle states, and the generation UTC ISO timestamp.
      // This exact string (lines joined by "\n", UTF-8 encoded) is the SHA-256 preimage.
      // The preimage is reproduced verbatim inside the Document Integrity section of the
      // PDF so any third party can recompute the fingerprint independently.
      const canonicalLinesList: string[] = [
        "KYUTXO-POF-v1",
        `TOOL: KYUTXO v${KYUTXO_APP_VERSION}`,
        `REF: ${declarationNonce}`,
        `DECLARANT: ${declarantName}`,
        declarantContact.trim() ? `CONTACT: ${declarantContact.trim()}` : "",
        declarantResidentialAddress.trim() ? `RESIDENTIAL: ${declarantResidentialAddress.trim()}` : "",
        declarantDob.trim() ? `DOB: ${declarantDob.trim()}` : "",
        declarantTaxId.trim() ? `TAX_ID: ${declarantTaxId.trim()}` : "",
        declarantIdNumber.trim() ? `ID_NUMBER: ${declarantIdNumber.trim()}` : "",
        declarantNationality.trim() ? `NATIONALITY: ${declarantNationality.trim()}` : "",
        `DATE: ${declarationDate}`,
        `PURPOSE: ${purpose}`,
        statement.trim() ? `STATEMENT: ${statement.trim()}` : "",
        "ADDRESSES:",
        ...doneRows.map((r) => {
          const cs = controlStates[r.raw];
          const ctrl = cs?.status === "verified" ? "VERIFIED" : "UNVERIFIED";
          return `${r.raw}: ${r.balanceSats ?? 0} sat [${ctrl}]`;
        }),
        `TOTAL: ${totalSats} sat`,
        summary ? `SOURCE: ${summary.asOfLabel}` : "",
        summary?.blockHeight ? `BLOCK: ${summary.blockHeight}` : "",
        summary?.timestamp ? `TIMESTAMP: ${summary.timestamp}` : "",
        fiatValid ? `FIAT_RATE: ${fiatRateNum} ${fiatCurrency}` : "",
        // Proof-of-control: include challenge message and submitted signature for each
        // verified address. The challenge message is deterministically derived from the
        // declaration fields, so these lines are fully reproducible from the printed document.
        ...verifiedRows.flatMap((r) => {
          const cs = controlStates[r.raw]!;
          const challengeMsg = buildChallengeMessage({
            address: r.raw,
            declarantName,
            declarationDate,
            purpose,
            nonce: declarationNonce,
          });
          return [
            `CTRL_${r.raw}_CHALLENGE: ${challengeMsg}`,
            `CTRL_${r.raw}_SIG: ${cs.verifiedSig ?? ""}`,
          ];
        }),
        `SECTION_QR: ${includeQr ? `ON:${qrExplorerId}` : "OFF"}`,
        `SECTION_PROVENANCE: ${includeProvenance ? `ON:${provenanceFiatCurrency}` : "OFF"}`,
        includeAml ? `SECTION_AML: ON` : "SECTION_AML: OFF",
        includeAml ? `AML_PEP: ${amlPepStatus}` : "",
        includeAml && amlSourceOfWealth.trim() ? `AML_WEALTH: ${amlSourceOfWealth.trim()}` : "",
        includeAml && amlSourceOfFunds.trim() ? `AML_FUNDS: ${amlSourceOfFunds.trim()}` : "",
        includeAml && amlTaxJurisdiction.trim() ? `AML_TAX_JUR: ${amlTaxJurisdiction.trim()}` : "",
        includeAml && amlTaxStatement.trim() ? `AML_TAX_STMT: ${amlTaxStatement.trim()}` : "",
        `SECTION_ATTESTATION: ${includeAttestation ? "ON" : "OFF"}`,
        includeAttestation && attestationPlaceOfSigning.trim() ? `ATTEST_PLACE: ${attestationPlaceOfSigning.trim()}` : "",
        includeAttestation && attestationWitnessLine.trim() ? `ATTEST_WITNESS: ${attestationWitnessLine.trim()}` : "",
        `SECTION_INTRO: ${includeIntro ? "ON" : "OFF"}`,
        `SECTION_GLOSSARY: ${includeGlossary ? "ON" : "OFF"}`,
        `EVIDENCE_COUNT: ${evidenceItems.length}`,
        ...evidenceItems.map(
          (it, i) =>
            `EVIDENCE_ITEM_${String(i + 1).padStart(3, "0")}: ${it.kind}|${it.name}|${it.sha256}|${it.caption.trim()}`,
        ),
        `GENERATED: ${generationIso}`,
      ].filter(Boolean);
      canonicalPayload = canonicalLinesList.join("\n");
      // Fingerprint failure is treated as a hard error — silently substituting a
      // placeholder would give a false sense of integrity. crypto.subtle is available
      // in all modern browsers so failure here indicates a serious environment problem.
      const enc = new TextEncoder();
      const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(canonicalPayload));
      contentFingerprint = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } // end if (!isSample) fingerprint block

    // ── Sample notice banner (sample mode only) ───────────────────────────────
    if (isSample) {
      doc.setFillColor(255, 210, 210);
      doc.setDrawColor(200, 80, 80);
      doc.rect(margin, y - 4, contentW, 13, "FD");
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(160, 0, 0);
      const noticeLines = doc.splitTextToSize(
        sanitizePdfText(
          "SAMPLE / SPECIMEN — NOT A VALID DECLARATION. This document is a layout preview only. All data is fictitious."
        ),
        contentW - 4
      ) as string[];
      doc.text(noticeLines, margin + 2, y + 2.5);
      y += noticeLines.length * 8.5 * 0.45 + 10;
      doc.setTextColor(0, 0, 0);
    }

      // ── Title ──────────────────────────────────────────────────────────────
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("PROOF OF FUNDS DECLARATION", margin, y);
      y += 10;

      doc.setLineWidth(0.5);
      doc.line(margin, y, margin + contentW, y);
      y += 5;

      // ── Optional Introduction / Preface ─────────────────────────────────────
      // Rendered at the very top, before the declarant details, when enabled.
      if (includeIntro) {
        checkPageBreak(30);
        addLine("INTRODUCTION", 11, true);
        addSpacer(2);
        for (const paragraph of DECLARATION_INTRO_PARAGRAPHS) {
          checkPageBreak(24);
          addWrapped(paragraph);
          addSpacer(2);
        }
        addSpacer(3);
      }

      // ── Declarant Details ──────────────────────────────────────────────────
      addLine("DECLARANT DETAILS", 11, true);
      addSpacer(2);
      addLine(`Full Name: ${effName}`, 10);
      addSpacer(1);
      if (effContact.trim()) {
        addLine(`Contact / Address: ${effContact}`, 10);
        addSpacer(1);
      }
      if (effResidential.trim()) {
        addLine(`Residential / Street Address: ${effResidential}`, 10);
        addSpacer(1);
      }
      if (effDob.trim()) {
        addLine(`Date of Birth: ${effDob}`, 10);
        addSpacer(1);
      }
      if (effTaxId.trim()) {
        addLine(`Tax ID Number: ${effTaxId}`, 10);
        addSpacer(1);
      }
      if (effIdNumber.trim()) {
        addLine(`Identification Number: ${effIdNumber}`, 10);
        addSpacer(1);
      }
      if (effNationality.trim()) {
        addLine(`Nationality: ${effNationality}`, 10);
        addSpacer(1);
      }
      addLine(`Declaration Date: ${effDate}`, 10);
      addSpacer(1);
      addLine(`Purpose: ${effPurpose}`, 10);
      addSpacer(1);
      addLine(`Declaration Reference: ${effNonce}`, 10);
      addSpacer(4);

      // ── Statement ──────────────────────────────────────────────────────────
      if (effStatement.trim()) {
        addLine("DECLARATION STATEMENT", 11, true);
        addSpacer(2);
        addWrapped(effStatement);
        addSpacer(4);
      }

      // ── Data Source Attestation ────────────────────────────────────────────
      addLine("DATA SOURCE ATTESTATION", 11, true);
      addSpacer(2);
      if (effSummary) {
        addWrapped(effSummary.asOfLabel);
      } else if (isSample) {
        addWrapped("Sample data — balance figures are fictitious placeholders, not sourced from the blockchain.");
      }
      addSpacer(4);

      // ── Address Balances Table ─────────────────────────────────────────────
      addLine("BITCOIN ADDRESS BALANCES", 11, true);
      addSpacer(2);

      const tableStartY = y;
      const tableBody = effRows.map((r) => {
        const ctrlLabel = r.verified ? "Control Verified" : "Self-Declared (Unverified)";
        return [
          sanitizePdfText(r.raw),
          `${formatBTC(r.balanceSats)} BTC`,
          sanitizePdfText(ctrlLabel),
        ];
      });

      autoTable(doc, {
        startY: tableStartY,
        head: [["Bitcoin Address", "Balance (BTC)", "Control Status"]],
        body: tableBody,
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.5, font: "helvetica", cellPadding: 2 },
        headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255], fontStyle: "bold" },
        columnStyles: {
          0: { cellWidth: contentW * 0.55, font: "courier" },
          1: { cellWidth: contentW * 0.22, halign: "right" },
          2: { cellWidth: contentW * 0.23 },
        },
        didParseCell: (data: any) => {
          if (data.column.index === 2 && data.section === "body") {
            const row = effRows[data.row.index];
            if (row?.verified) {
              data.cell.styles.textColor = [0, 120, 0];
            }
          }
        },
        didDrawPage: () => { /* allow page breaks */ },
      });

      y = (doc as any).lastAutoTable.finalY + 6;

      // ── Totals ─────────────────────────────────────────────────────────────
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text(`TOTAL: ${formatBTC(effTotalSats)} BTC`, margin, y);
      y += 5;

      if (effFiatValid && effFiatTotal !== null) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(0, 0, 0);
        const fiatLineSuffix = isSample ? " — SAMPLE RATE" : "";
        const fiatLine = `Fiat equivalent: ${effFiatTotal.toLocaleString("en-US", {
          style: "currency",
          currency: effFiatCurrency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} (at ${sanitizePdfText(effFiatCurrency)} ${sanitizePdfText(effFiatRate.toLocaleString("en-US", { maximumFractionDigits: 2 }))} per BTC)${fiatLineSuffix}`;
        const fiatLines = doc.splitTextToSize(sanitizePdfText(fiatLine), contentW) as string[];
        doc.text(fiatLines, margin, y);
        y += fiatLines.length * 4;
        doc.setTextColor(120, 80, 0);
        const disclaimerLines = doc.splitTextToSize(
          sanitizePdfText(
            "DISCLAIMER: Exchange rate supplied by declarant. This is not a market quote or financial advice."
          ),
          contentW
        ) as string[];
        doc.text(disclaimerLines, margin, y);
        doc.setTextColor(0, 0, 0);
        y += disclaimerLines.length * 4 + 1;
      }

      addSpacer(4);

      // ── Balance-Verification QR Codes ──────────────────────────────────────
      if (includeQr && effRows.length > 0) {
        const qrExplorer = getExplorer(qrExplorerId);

        // Pre-generate every QR code offline (data: URLs, no network).
        const qrMap = new Map<string, string>();
        for (const r of effRows) {
          try {
            qrMap.set(
              r.raw,
              await QRCode.toDataURL(qrExplorer.addressUrl(r.raw), {
                width: 400,
                margin: 1,
                errorCorrectionLevel: "M",
              })
            );
          } catch {
            // Skip a single failed code rather than aborting the whole PDF.
          }
        }

        checkPageBreak(30);
        addLine("BALANCE VERIFICATION QR CODES", 11, true);
        addSpacer(2);
        addWrapped(
          `Scan a code below to view that address on ${qrExplorer.host} and confirm its balance. ` +
            "These QR codes link to a public, third-party block explorer; opening them requires internet access " +
            "and shares the address with that explorer. KYUTXO made no network requests to generate this document.",
          8.5
        );
        addSpacer(2);

        const qrSize = 30; // mm
        const qrGap = 6;
        const textX = margin + qrSize + 4;
        const textW = contentW - qrSize - 4;

        for (const r of effRows) {
          const dataUrl = qrMap.get(r.raw);
          checkPageBreak(qrSize + qrGap);
          const blockTop = y;

          if (dataUrl) {
            doc.addImage(dataUrl, "PNG", margin, blockTop, qrSize, qrSize);
          }

          // Address + explorer URL to the right of the code.
          let ty = blockTop + 4;
          doc.setFont("courier", "normal");
          doc.setFontSize(8);
          doc.setTextColor(0, 0, 0);
          const addrLines = doc.splitTextToSize(sanitizePdfText(r.raw), textW) as string[];
          doc.text(addrLines, textX, ty);
          ty += addrLines.length * 8 * 0.45 + 2;

          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(0, 0, 0);
          doc.text(sanitizePdfText(`Balance: ${formatBTC(r.balanceSats)} BTC`), textX, ty);
          ty += 5;

          doc.setFontSize(7.5);
          doc.setTextColor(80, 80, 80);
          const urlLines = doc.splitTextToSize(
            sanitizePdfText(qrExplorer.addressUrl(r.raw)),
            textW
          ) as string[];
          doc.text(urlLines, textX, ty);

          doc.setTextColor(0, 0, 0);
          y = Math.max(blockTop + qrSize, ty + urlLines.length * 7.5 * 0.45) + qrGap;
        }

        addSpacer(2);
      }

      // ── Acquisition & Provenance Section ──────────────────────────────────
      if (includeProvenance && effRows.length > 0) {
        interface ProvenanceEntry {
          address: string;
          label: string;
          acquisitionDate: string;
          acquisitionMethod: string;
          counterpartyName: string;
          btcAmountSats: number;
          costBasisFiat: string;
          priceInfo: string;
          hasRecord: boolean;
          attachmentNames: string[];
        }

        let provenanceEntries: ProvenanceEntry[];
        let allSupportingDocs: string[];
        let totalCostBasis: number;
        let hasCostBasis: boolean;

        if (isSample) {
          // Hardcoded fictitious entries — one per sample address
          provenanceEntries = [
            {
              address: SAMPLE_EFF_ROWS[0].raw,
              label: "Sample Long-Term Hold",
              acquisitionDate: "2021-03-15",
              acquisitionMethod: "Exchange Purchase",
              counterpartyName: "Kraken (sample)",
              btcAmountSats: 125_000_000,
              costBasisFiat: "USD 72,500.00 (user-supplied)",
              priceInfo: "",
              hasRecord: true,
              attachmentNames: ["sample-purchase-receipt.pdf"],
            },
            {
              address: SAMPLE_EFF_ROWS[1].raw,
              label: "Sample Mining Reward",
              acquisitionDate: "2020-05-01",
              acquisitionMethod: "Mining",
              counterpartyName: "Self-Mined (sample)",
              btcAmountSats: 75_000_000,
              costBasisFiat: "USD 37,000.00 (user-supplied)",
              priceInfo: "",
              hasRecord: true,
              attachmentNames: ["sample-mining-record.csv"],
            },
          ];
          allSupportingDocs = ["sample-purchase-receipt.pdf", "sample-mining-record.csv"];
          totalCostBasis = 109_500;
          hasCostBasis = true;
        } else {
          // Real DB lookup path
          provenanceEntries = [];
          allSupportingDocs = [];
          totalCostBasis = 0;
          hasCostBasis = false;

          const allAddrRecords = await getRecordsByType("address");
          const recordByAddress = new Map<string, (typeof allAddrRecords)[0]>();
          for (const rec of allAddrRecords) {
            recordByAddress.set(rec.inputString, rec);
          }

          for (const row of doneRows) {
            const rec = recordByAddress.get(row.raw);
            const balanceSats = row.balanceSats ?? 0;

            if (!rec) {
              provenanceEntries.push({
                address: row.raw,
                label: "",
                acquisitionDate: "No vault record",
                acquisitionMethod: "No vault record",
                counterpartyName: "No vault record",
                btcAmountSats: balanceSats,
                costBasisFiat: "Not recorded",
                priceInfo: "",
                hasRecord: false,
                attachmentNames: [],
              });
              continue;
            }

            // Acquisition date
            const acquisitionDate = rec.date ? rec.date : "Not recorded";

            // Acquisition method label
            const methodOpt = ACQUISITION_METHOD_OPTIONS.find((o) => o.value === rec.acquisitionMethod);
            const acquisitionMethod = methodOpt?.label ?? (rec.acquisitionMethod ? rec.acquisitionMethod : "Not recorded");

            // Counterparty / source name
            const counterpartyTypeOpt = COUNTERPARTY_TYPE_OPTIONS.find((o) => o.value === rec.counterpartyType);
            const counterpartyName =
              (rec.counterpartyName?.trim() || "") !== ""
                ? rec.counterpartyName!.trim()
                : (rec.walletName?.trim() || "") !== ""
                ? rec.walletName!.trim()
                : (rec.label?.trim() || "") !== ""
                ? rec.label.trim()
                : counterpartyTypeOpt
                ? counterpartyTypeOpt.label
                : "Not recorded";

            // Cost basis / fiat value at acquisition
            let costBasisFiat = "Not recorded";
            let priceInfo = "";

            if (rec.costBasisUsd !== undefined && rec.costBasisUsd > 0) {
              const formatted = rec.costBasisUsd.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
              costBasisFiat = `USD ${formatted} (user-supplied)`;
              totalCostBasis += rec.costBasisUsd;
              hasCostBasis = true;
            } else if (rec.date) {
              const priceRow = await getLatestPriceOnOrBefore(rec.date, provenanceFiatCurrency, "BTC");
              if (priceRow) {
                const computedBasis = (balanceSats / 1e8) * priceRow.close;
                const formatted = computedBasis.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                });
                costBasisFiat = `${provenanceFiatCurrency} ${formatted}`;
                const rateSource = priceRow.source ? priceRow.source : "vault price store";
                priceInfo = `Rate: ${provenanceFiatCurrency} ${priceRow.close.toLocaleString()} on ${priceRow.date} (source: ${rateSource})`;
                totalCostBasis += computedBasis;
                hasCostBasis = true;
              } else {
                costBasisFiat = "Not recorded";
                priceInfo = `No ${provenanceFiatCurrency} price data for ${rec.date} (source: vault price store)`;
              }
            }

            // Attachments linked to this record
            const attachments = rec.id !== undefined ? await getAttachmentsByRecordId(rec.id) : [];
            const attachmentNames = attachments.map((a) => a.filename);
            allSupportingDocs.push(...attachmentNames);

            provenanceEntries.push({
              address: row.raw,
              label: rec.label || "",
              acquisitionDate,
              acquisitionMethod,
              counterpartyName,
              btcAmountSats: balanceSats,
              costBasisFiat,
              priceInfo,
              hasRecord: true,
              attachmentNames,
            });
          }
        } // end if (isSample) else

        // Start a new page for the provenance appendix
        doc.addPage();
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: ACQUISITION & PROVENANCE", margin, y);
        y += 8;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        const provenanceIntroLines = doc.splitTextToSize(
          sanitizePdfText(
            "The following table documents the acquisition history for the declared Bitcoin addresses. " +
            "Data is sourced from the declarant's KYUTXO vault records. Addresses without vault records " +
            "or acquisition metadata are shown as \"Not recorded\". Historical fiat values are estimates " +
            "based on stored price data; they may not reflect the actual transaction price."
          ),
          contentW
        ) as string[];
        doc.text(provenanceIntroLines, margin, y);
        y += provenanceIntroLines.length * 8.5 * 0.45 + 5;

        // Per-source table
        const provTableHead = [[
          "Address",
          "Date Acquired",
          "Acquisition Method",
          "Counterparty / Source",
          `BTC Amount`,
          `Cost Basis (${provenanceFiatCurrency})`,
        ]];
        const provTableBody = provenanceEntries.map((e) => [
          sanitizePdfText(truncateAddress(e.address, 8, 8)),
          sanitizePdfText(e.acquisitionDate),
          sanitizePdfText(e.acquisitionMethod),
          sanitizePdfText(e.counterpartyName),
          sanitizePdfText(`${formatBTC(e.btcAmountSats)} BTC`),
          sanitizePdfText(e.costBasisFiat),
        ]);

        autoTable(doc, {
          startY: y,
          head: provTableHead,
          body: provTableBody,
          margin: { left: margin, right: margin },
          styles: { fontSize: 7, font: "helvetica", cellPadding: 2, overflow: "linebreak" },
          headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255], fontStyle: "bold" },
          columnStyles: {
            0: { cellWidth: contentW * 0.19, font: "courier" },
            1: { cellWidth: contentW * 0.13 },
            2: { cellWidth: contentW * 0.17 },
            3: { cellWidth: contentW * 0.19 },
            4: { cellWidth: contentW * 0.14, halign: "right" },
            5: { cellWidth: contentW * 0.18, halign: "right" },
          },
          didDrawPage: () => {},
        });

        y = (doc as any).lastAutoTable.finalY + 5;

        // Price rate notes (one per entry that has a note)
        const priceNotes = provenanceEntries.filter((e) => e.priceInfo);
        if (priceNotes.length > 0) {
          checkPageBreak(10 + priceNotes.length * 5);
          doc.setFontSize(7.5);
          doc.setFont("helvetica", "italic");
          doc.setTextColor(100, 100, 100);
          for (const e of priceNotes) {
            const noteText = `${truncateAddress(e.address, 8, 8)}: ${e.priceInfo}`;
            doc.text(sanitizePdfText(noteText), margin, y);
            y += 4;
          }
          doc.setTextColor(0, 0, 0);
          y += 2;
        }

        // Summary line
        checkPageBreak(35);
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("PROVENANCE SUMMARY", margin, y);
        y += 5;

        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.text(sanitizePdfText(`Total BTC (declared addresses): ${formatBTC(effTotalSats)} BTC`), margin, y);
        y += 4.5;

        if (hasCostBasis) {
          const costStr = totalCostBasis.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          doc.text(sanitizePdfText(`Total Cost Basis: ${provenanceFiatCurrency} ${costStr}`), margin, y);
          y += 4.5;
        }

        if (effFiatValid && effFiatTotal !== null) {
          const currentStr = effFiatTotal.toLocaleString("en-US", {
            style: "currency",
            currency: effFiatCurrency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          doc.text(
            sanitizePdfText(
              `Current Value: ${currentStr} ${effFiatCurrency} (at declarant-supplied rate of ${effFiatRate.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${effFiatCurrency}/BTC)`
            ),
            margin,
            y
          );
          y += 4.5;

          if (hasCostBasis && effFiatCurrency === provenanceFiatCurrency && totalCostBasis > 0) {
            const gainLoss = effFiatTotal - totalCostBasis;
            const pct = ((gainLoss / totalCostBasis) * 100).toFixed(1);
            const gainStr = gainLoss.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            doc.text(
              sanitizePdfText(
                `Unrealized Gain/Loss: ${gainLoss >= 0 ? "+" : ""}${effFiatCurrency} ${gainStr} (${gainLoss >= 0 ? "+" : ""}${pct}%)`
              ),
              margin,
              y
            );
            y += 4.5;
          }
        }

        y += 3;

        // Supporting documents list
        checkPageBreak(20);
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("SUPPORTING DOCUMENTS", margin, y);
        y += 5;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");

        if (allSupportingDocs.length === 0) {
          doc.setTextColor(100, 100, 100);
          doc.text("No file attachments are linked to the declared records in vault.", margin, y);
          doc.setTextColor(0, 0, 0);
          y += 5;
        } else {
          for (const name of allSupportingDocs) {
            checkPageBreak(8);
            doc.text(sanitizePdfText(`\u2022 ${name}`), margin + 3, y);
            y += 4.5;
          }
          y += 2;
        }

        // Disclaimer note
        checkPageBreak(15);
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "italic");
        doc.setTextColor(100, 100, 100);
        const provNoteLines = doc.splitTextToSize(
          sanitizePdfText(
            "Disclaimer: Acquisition data is taken from the declarant's KYUTXO vault records at the time of generation. " +
            "Historical fiat values are estimates from stored price history and may not equal the actual price paid. " +
            "User-supplied cost basis figures are as entered by the declarant. " +
            "This section is informational only and does not constitute financial, tax, or legal advice."
          ),
          contentW
        ) as string[];
        doc.text(provNoteLines, margin, y);
        y += provNoteLines.length * 7.5 * 0.45 + 4;
        doc.setTextColor(0, 0, 0);
      }

      // ── AML / Risk Screening Appendix ─────────────────────────────────────
      if (includeAml && effRows.length > 0) {
        const amlResult = isSample
          ? {
              screeningDate: effDate,
              screenedCount: effRows.length,
              directMatches: [] as Array<{ address: string; entityName: string; categoryLabel: string }>,
              hasGraphData: false,
              nearestHopDistance: null as null | number,
              nearestHopEntityName: null as string | null,
              nearestHopCategoryLabel: null as string | null,
              entityListSource: "bundled" as const,
              entityListCount: 0,
              entityListImportedAt: null as null | number,
              entityListSourceLabel: null as string | null,
            }
          : await runAmlScreening(doneRows.map((r) => r.raw));

        doc.addPage();
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: AML / RISK SCREENING", margin, y);
        y += 8;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

        addLine(AML_APPENDIX_STRINGS.screeningParametersHeading, 10, true);
        addSpacer(2);
        addLine(
          sanitizePdfText(buildScreeningDateLine(amlResult.screeningDate)),
          9
        );
        addSpacer(1);
        addLine(
          buildEntityListDescription(amlResult, sanitizePdfText),
          9
        );
        addSpacer(1);
        addLine(buildAddressesScreenedLine(amlResult.screenedCount), 9);
        addSpacer(5);

        checkPageBreak(30);
        addLine(AML_APPENDIX_STRINGS.directMatchResultsHeading, 10, true);
        addSpacer(2);
        if (amlResult.directMatches.length === 0) {
          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(0, 120, 0);
          doc.text(AML_APPENDIX_STRINGS.noDirectMatchesResult, margin, y);
          doc.setTextColor(0, 0, 0);
          y += 5;
          addWrapped(AML_APPENDIX_STRINGS.noDirectMatchesDetail, 9);
        } else {
          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(160, 0, 0);
          doc.text(
            buildDirectMatchResultLine(amlResult.directMatches.length),
            margin,
            y
          );
          doc.setTextColor(0, 0, 0);
          y += 5;

          autoTable(doc, {
            startY: y,
            head: [["Address", "Entity Name", "Category"]],
            body: amlResult.directMatches.map((m) => [
              sanitizePdfText(truncateAddress(m.address, 8, 8)),
              sanitizePdfText(m.entityName),
              sanitizePdfText(m.categoryLabel),
            ]),
            margin: { left: margin, right: margin },
            styles: { fontSize: 8, font: "helvetica", cellPadding: 2, overflow: "linebreak" },
            headStyles: { fillColor: [120, 0, 0], textColor: [255, 255, 255], fontStyle: "bold" },
            columnStyles: {
              0: { cellWidth: contentW * 0.38, font: "courier" },
              1: { cellWidth: contentW * 0.40 },
              2: { cellWidth: contentW * 0.22 },
            },
            didDrawPage: () => {},
          });
          y = (doc as any).lastAutoTable.finalY + 5;
        }
        addSpacer(5);

        checkPageBreak(25);
        addLine(AML_APPENDIX_STRINGS.indirectProximityAnalysisHeading, 10, true);
        addSpacer(2);
        if (!amlResult.hasGraphData) {
          addWrapped(AML_APPENDIX_STRINGS.noGraphDataDetail, 9, [80, 80, 80]);
        } else if (amlResult.nearestHopDistance === null) {
          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(0, 120, 0);
          doc.text(AML_APPENDIX_STRINGS.noProximityMatchResult, margin, y);
          doc.setTextColor(0, 0, 0);
          y += 5;
          addWrapped(AML_APPENDIX_STRINGS.noProximityMatchDetail, 9);
        } else {
          doc.setFontSize(9);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0, 0, 0);
          const proximityLine = buildNearestEntityLine(
            {
              nearestHopDistance: amlResult.nearestHopDistance,
              nearestHopEntityName: amlResult.nearestHopEntityName,
              nearestHopCategoryLabel: amlResult.nearestHopCategoryLabel,
            },
            sanitizePdfText
          );
          const proxLines = doc.splitTextToSize(sanitizePdfText(proximityLine), contentW) as string[];
          doc.text(proxLines, margin, y);
          y += proxLines.length * 9 * 0.45 + 2;
        }
        addSpacer(5);

        checkPageBreak(60);
        addLine(AML_APPENDIX_STRINGS.declarantSelfAttestationsHeading, 10, true);
        addSpacer(2);

        // Built from the SAME shared builder as the on-screen attestation
        // preview (see `attestationPreviewLines`), differing only by the
        // sanitizePdfText transform applied here to user-supplied values, so the
        // preview can never silently drift from what this section renders.
        const attestationLines = buildAttestationLines(
          {
            pepStatus: isSample ? "no" : amlPepStatus,
            sourceOfWealth: isSample ? "Sample employment income" : amlSourceOfWealth,
            sourceOfFunds: isSample ? "Sample savings" : amlSourceOfFunds,
            taxJurisdiction: isSample ? "Sampleland" : amlTaxJurisdiction,
            taxStatement: isSample ? "" : amlTaxStatement,
          },
          sanitizePdfText,
        );
        for (const line of attestationLines) {
          addWrapped(line, 9);
          addSpacer(2);
        }

        addWrapped(AML_APPENDIX_STRINGS.generalAttestation, 9);
        addSpacer(6);

        checkPageBreak(35);
        addLine(AML_APPENDIX_STRINGS.screeningDisclaimerHeading, 10, true);
        addSpacer(2);
        addWrapped(AML_APPENDIX_STRINGS.screeningDisclaimer, 8, [80, 80, 80]);
      }

      // ── Standard Disclaimers ───────────────────────────────────────────────
      checkPageBreak(50);
      addLine("DISCLAIMERS", 11, true);
      addSpacer(2);

      const verifiedFormats = new Set(
        effVerifiedRows
          .map((r) => r.verifiedFormat)
          .filter((f): f is SignatureFormat => !!f)
      );
      const formatPhrase =
        verifiedFormats.has("legacy") && verifiedFormats.has("bip322")
          ? "Bitcoin Signed Message and BIP-322 signatures"
          : verifiedFormats.has("bip322")
          ? "BIP-322 signatures"
          : "Bitcoin Signed Message signatures";

      const controlDisclaimerLine = allVerified
        ? `2. Cryptographic proof-of-control is included for all addresses via ${formatPhrase}. An appendix contains the challenge messages and signatures for independent re-verification.`
        : hasVerified
        ? `2. Cryptographic proof-of-control is included for ${effVerifiedRows.length} of ${effRows.length} address${effRows.length !== 1 ? "es" : ""} via ${formatPhrase}. The remaining addresses are self-declared. An appendix contains the challenge messages and signatures for verified addresses.`
        : "2. No cryptographic proof-of-control is included. All addresses are self-declared by the declarant.";

      const disclaimers = [
        "1. This is a declaration produced by the declarant personally attesting to ownership of the above Bitcoin addresses.",
        controlDisclaimerLine,
        "3. Balances reflect the data source indicated above and may not represent real-time on-chain state.",
        "4. This document was generated offline using KYUTXO. No data was transmitted to third parties during generation.",
        "5. This document does not constitute financial, legal, or tax advice.",
      ];
      for (const d of disclaimers) {
        addWrapped(d);
        addSpacer(1);
      }

      addSpacer(6);

      // ── Signature Block ────────────────────────────────────────────────────
      checkPageBreak(30);
      addLine("SIGNATURE", 11, true);
      addSpacer(4);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(0, 0, 0);
      doc.text("Declarant signature: ___________________________________", margin, y);
      y += 8;
      doc.text(`Date: ${sanitizePdfText(effDate)}`, margin, y);
      y += 6;
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text(
        sanitizePdfText(
          `Generated by KYUTXO on ${generationTimestamp.toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}`
        ),
        margin,
        y
      );
      doc.setTextColor(0, 0, 0);
      y += 5;

      // ── Document Integrity (always-on) ────────────────────────────────────
      checkPageBreak(55);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("DOCUMENT INTEGRITY", margin, y);
      y += 5;
      doc.setLineWidth(0.3);
      doc.line(margin, y, margin + contentW, y);
      y += 4;

      doc.setFontSize(8.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(0, 0, 0);

      // Generation metadata
      // NOTE: Generated timestamp is displayed as UTC ISO 8601 — this is exactly the
      // value in the canonical payload so the fingerprint is unambiguously reproducible.
      const metaLines: [string, string][] = [
        ["Tool:", `KYUTXO v${KYUTXO_APP_VERSION} (Proof of Funds Declaration)`],
        ["Generated (UTC ISO 8601):", generationIso],
        ["Declaration Reference:", effNonce],
      ];

      // Blockchain time-anchor
      if (effSummary?.blockHeight) {
        const anchorLabel = effSummary.timestamp
          ? `Block ${effSummary.blockHeight.toLocaleString()} — ${formatUnix(effSummary.timestamp)}`
          : `Block ${effSummary.blockHeight.toLocaleString()}`;
        metaLines.push(["On-chain data current as of:", anchorLabel]);
      } else if (effSummary?.timestamp) {
        metaLines.push(["On-chain data as of:", formatUnix(effSummary.timestamp)]);
      }

      // Content fingerprint (red in sample mode to make the specimen label visually obvious)
      if (isSample) {
        metaLines.push(["Content Fingerprint (SHA-256):", ""]);
      } else {
        metaLines.push(["Content Fingerprint (SHA-256):", contentFingerprint]);
      }

      const metaLabelW = 65;
      const metaValueW = contentW - metaLabelW;
      for (const [label, value] of metaLines) {
        checkPageBreak(10);
        doc.setFont("helvetica", "bold");
        doc.text(sanitizePdfText(label), margin, y);
        doc.setFont("helvetica", "normal");
        if (label.startsWith("Content Fingerprint") && isSample) {
          doc.setTextColor(180, 0, 0);
          doc.setFont("helvetica", "bold");
          doc.text(sanitizePdfText(contentFingerprint), margin + metaLabelW, y);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0, 0, 0);
          y += 4.5;
        } else {
          const valLines = doc.splitTextToSize(sanitizePdfText(value), metaValueW) as string[];
          doc.text(valLines, margin + metaLabelW, y);
          y += Math.max(valLines.length * 8.5 * 0.45, 4.5);
        }
      }
      y += 2;

      doc.setFontSize(7.5);
      doc.setFont("helvetica", "italic");
      doc.setTextColor(100, 100, 100);

      if (isSample) {
        // In sample mode, skip the canonical payload box and explain why
        const sampleFpNote =
          "SPECIMEN — No canonical payload is printed for sample PDFs. " +
          "The Content Fingerprint above is a placeholder label, not a valid SHA-256 hash. " +
          "A real declaration includes the verbatim preimage here so any reviewer can independently verify the fingerprint.";
        const sampleFpLines = doc.splitTextToSize(sanitizePdfText(sampleFpNote), contentW) as string[];
        doc.text(sampleFpLines, margin, y);
        doc.setTextColor(0, 0, 0);
        y += sampleFpLines.length * 7.5 * 0.45 + 4;
      } else {
        const fingerprintNote =
          "The Content Fingerprint is SHA-256(UTF-8(canonical payload)), where the canonical payload " +
          "is the verbatim preimage printed below (lines joined by newline \"\\n\"). " +
          "It covers: tool version, reference ID, all declarant fields, date, purpose, statement, " +
          "all declared addresses with balances and control status, proof-of-control challenge messages " +
          "and signatures for verified addresses, blockchain anchor, fiat rate, all section toggle states " +
          "and their user-entered fields, and the UTC ISO 8601 generation timestamp. " +
          "A reviewer can copy the preimage below, UTF-8 encode it, SHA-256 hash it, and verify the hex matches the fingerprint above. " +
          "Page numbering in the footer confirms no pages have been removed.";
        const fpNoteLines = doc.splitTextToSize(sanitizePdfText(fingerprintNote), contentW) as string[];
        doc.text(fpNoteLines, margin, y);
        doc.setTextColor(0, 0, 0);
        y += fpNoteLines.length * 7.5 * 0.45 + 4;

        // ── Canonical payload (verbatim preimage) ───────────────────────────
        // Printed in full so any third party can recompute the fingerprint independently
        // without possessing any information not visible in this document.
        checkPageBreak(20);
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("Fingerprint Preimage (canonical payload, reproduced verbatim):", margin, y);
        y += 4.5;

        // Print payload in Courier at small size, with a light background box
        doc.setFont("courier", "normal");
        doc.setFontSize(6.5);
        doc.setTextColor(30, 30, 30);
        const payloadWrapped = doc.splitTextToSize(
          sanitizePdfText(canonicalPayload),
          contentW - 4
        ) as string[];
        const payloadBoxH = payloadWrapped.length * 6.5 * 0.42 + 4;
        checkPageBreak(payloadBoxH + 4);
        doc.setFillColor(248, 248, 248);
        doc.setDrawColor(200, 200, 200);
        doc.rect(margin, y - 1.5, contentW, payloadBoxH, "FD");
        doc.text(payloadWrapped, margin + 2, y + 1);
        y += payloadBoxH + 4;
        doc.setTextColor(0, 0, 0);
      }

      // ── Optional Attestation Block ─────────────────────────────────────────
      if (includeAttestation) {
        checkPageBreak(70);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("FORMAL ATTESTATION", margin, y);
        y += 5;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0, 0, 0);
        const attestText =
          `I, ${sanitizePdfText(effName)}, hereby solemnly declare and attest that the foregoing ` +
          "information — including all Bitcoin addresses, reported balances, and supporting details — is true, " +
          "accurate, and complete to the best of my knowledge and belief. I am the lawful owner or authorised " +
          "signatory of the declared addresses and the funds associated with them. I understand that knowingly " +
          "making a false declaration may result in civil and/or criminal liability under applicable law.";
        const attestLines = doc.splitTextToSize(sanitizePdfText(attestText), contentW) as string[];
        doc.text(attestLines, margin, y);
        y += attestLines.length * 9 * 0.45 + 8;

        // Signature line
        checkPageBreak(50);
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.text("Declarant signature: _______________________________________________", margin, y);
        y += 8;
        doc.text(`Full name: ${sanitizePdfText(effName)}`, margin, y);
        y += 7;

        const placeSigned = attestationPlaceOfSigning.trim();
        if (placeSigned) {
          doc.text(`Place of signing: ${sanitizePdfText(placeSigned)}`, margin, y);
          y += 7;
        } else {
          doc.text("Place of signing: _______________________________________________", margin, y);
          y += 7;
        }

        doc.text(`Date: ${sanitizePdfText(effDate)}`, margin, y);
        y += 10;

        // Optional witness / notary line
        const witnessLine = attestationWitnessLine.trim();
        if (witnessLine) {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(9);
          const wLines = doc.splitTextToSize(sanitizePdfText(`Witness / Notary: ${witnessLine}`), contentW) as string[];
          doc.text(wLines, margin, y);
          doc.setFont("helvetica", "normal");
          y += wLines.length * 9 * 0.45 + 5;
        } else {
          doc.text("Witness / Notary signature: ____________________________________", margin, y);
          y += 7;
          doc.text("Witness / Notary name and capacity: ____________________________", margin, y);
          y += 7;
          doc.text("Date: _______________", margin, y);
          y += 7;
        }

        doc.setFontSize(7.5);
        doc.setFont("helvetica", "italic");
        doc.setTextColor(100, 100, 100);
        doc.text(
          sanitizePdfText(`Declaration Reference: ${effNonce}`),
          margin, y
        );
        doc.setTextColor(0, 0, 0);
        y += 8;
      }

      // ── Appendix: Proof-of-Control Evidence ───────────────────────────────
      if (hasVerified) {
        doc.addPage();
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: PROOF-OF-CONTROL EVIDENCE", margin, y);
        y += 8;

        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 6;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        const introLines = doc.splitTextToSize(
          sanitizePdfText(
            "The following section contains the challenge message and corresponding wallet signature for each address where cryptographic proof-of-control was provided. " +
            "Legacy addresses use Bitcoin Signed Message signatures; Taproot (bc1p…) addresses use BIP-322 Simple signatures. " +
            "The signature was produced by the declarant using their own wallet or hardware device — no private keys were shared with KYUTXO. " +
            "To independently verify, use a Bitcoin message-verification tool that supports the signature format shown for each address, with the address, message, and signature shown below."
          ),
          contentW
        ) as string[];
        doc.text(introLines, margin, y);
        y += introLines.length * 8.5 * 0.45 + 6;

        // ── How to independently verify ──────────────────────────────────────
        checkPageBreak(70);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("HOW TO INDEPENDENTLY VERIFY", margin, y);
        y += 6;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        const howToIntroLines = doc.splitTextToSize(
          sanitizePdfText(
            "Each address below has a Challenge Message and a Wallet Signature. You can confirm, without KYUTXO and without any network access, that the holder of each address signed that exact message. " +
            "Use any standard Bitcoin signed-message verification tool and supply three inputs: the Address, the Challenge Message (verbatim, including line breaks), and the Wallet Signature (base64)."
          ),
          contentW
        ) as string[];
        doc.text(howToIntroLines, margin, y);
        y += howToIntroLines.length * 8.5 * 0.45 + 4;

        const verifyMethods = [
          "1. bitcoin-cli (Bitcoin Core): run  bitcoin-cli verifymessage \"<address>\" \"<signature>\" \"<challenge message>\"  — it returns true when the signature is valid for that address and message.",
          "2. Electrum: open Tools > Sign/Verify Message, paste the Address, Challenge Message, and Signature, then click Verify.",
          "3. Any other Bitcoin signed-message verifier (e.g. Sparrow's Verify Message tool, or any offline tool that accepts an address, a message, and a signature) will work the same way.",
        ];
        for (const m of verifyMethods) {
          checkPageBreak(16);
          const mLines = doc.splitTextToSize(sanitizePdfText(m), contentW - 3) as string[];
          doc.setFontSize(8.5);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0, 0, 0);
          doc.text(mLines, margin + 3, y);
          y += mLines.length * 8.5 * 0.45 + 2;
        }
        y += 3;

        // ── Challenge message & nonce format explanation ─────────────────────
        checkPageBreak(50);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("CHALLENGE MESSAGE FORMAT", margin, y);
        y += 6;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0, 0, 0);
        const formatDesc = [
          `The Challenge Message is the human-readable text that was signed for each address. It records the declarant, purpose, date, a unique Declaration Reference (nonce: ${effNonce}), and the address itself.`,
          "The Declaration Reference is a random value generated specifically for this declaration; because it is embedded in every signed message, the signatures cannot be silently reused for a different declaration.",
          "When verifying, the message must be supplied exactly as shown — every character and line break is part of what was signed, so changing even one character will cause verification to fail.",
        ];
        if (!isSample && verifierReference.trim()) {
          formatDesc.push(
            `Verifier Reference: "${verifierReference.trim()}" — a free-text identifier provided by the requesting party and embedded in each signed message, binding the signatures to this specific request.`
          );
        }
        if (!isSample && freshnessAnchor) {
          formatDesc.push(
            `Block Anchor: height ${freshnessAnchor.height}, hash ${freshnessAnchor.hash} (fetched ${freshnessAnchor.fetchedAt}). ` +
            `This anchor proves each signature was created at or after block ${freshnessAnchor.height}. ` +
            "It does not prove an exact timestamp — the verifier can confirm the block on any public explorer."
          );
        }
        const formatLines = doc.splitTextToSize(
          sanitizePdfText(formatDesc.join(" ")),
          contentW
        ) as string[];
        doc.text(formatLines, margin, y);
        y += formatLines.length * 8.5 * 0.45 + 6;

        for (const row of effVerifiedRows) {
          checkPageBreak(60);

          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(0, 0, 0);
          const addrHeadingLines = doc.splitTextToSize(
            sanitizePdfText(`Address: ${row.raw}`),
            contentW
          ) as string[];
          doc.text(addrHeadingLines, margin, y);
          y += addrHeadingLines.length * 5;

          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(80, 80, 80);
          const sigFormatLines = doc.splitTextToSize(
            sanitizePdfText(
              `Signature Format: ${signatureFormatLabel(row.verifiedFormat ?? "legacy")}`
            ),
            contentW
          ) as string[];
          doc.text(sigFormatLines, margin, y);
          doc.setTextColor(0, 0, 0);
          y += sigFormatLines.length * 5;

          const challengeMsg = buildChallengeMessage({
            address: row.raw,
            declarantName: effName,
            declarationDate: effDate,
            purpose: effPurpose,
            nonce: effNonce,
            verifierReference: isSample ? undefined : (verifierReference || undefined),
            freshnessAnchor: isSample ? undefined : (freshnessAnchor ?? undefined),
          });

          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.text("Challenge Message:", margin, y);
          y += 4;

          doc.setFont("courier", "normal");
          doc.setFontSize(7.5);
          const msgLines = doc.splitTextToSize(sanitizePdfText(challengeMsg), contentW - 4) as string[];
          doc.setFillColor(245, 245, 245);
          doc.rect(margin, y - 1, contentW, msgLines.length * 7.5 * 0.42 + 4, "F");
          doc.text(msgLines, margin + 2, y + 1.5);
          y += msgLines.length * 7.5 * 0.42 + 6;

          checkPageBreak(20);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8);
          doc.setTextColor(0, 0, 0);
          doc.text(
            row.verifiedFormat === "bip322"
              ? "BIP-322 Witness (base64):"
              : "Wallet Signature (base64):",
            margin,
            y
          );
          y += 4;

          doc.setFont("courier", "normal");
          doc.setFontSize(7.5);
          const sigLines = doc.splitTextToSize(sanitizePdfText(row.verifiedSig ?? ""), contentW - 4) as string[];
          doc.setFillColor(245, 245, 245);
          doc.rect(margin, y - 1, contentW, sigLines.length * 7.5 * 0.42 + 4, "F");
          doc.text(sigLines, margin + 2, y + 1.5);
          y += sigLines.length * 7.5 * 0.42 + 6;

          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(0, 130, 0);
          doc.text(
            sanitizePdfText("Status: Control Verified — signature matches this address."),
            margin,
            y
          );
          doc.setTextColor(0, 0, 0);
          y += 8;
          doc.setLineWidth(0.2);
          doc.setDrawColor(200, 200, 200);
          doc.line(margin, y, margin + contentW, y);
          y += 5;
        }
      }

      // ── Optional Glossary ──────────────────────────────────────────────────
      if (includeGlossary) {
        doc.addPage();
        y = 20;

        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("APPENDIX: GLOSSARY OF TERMS", margin, y);
        y += 8;
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 5;

        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 60, 60);
        const glossaryIntroLines = doc.splitTextToSize(
          sanitizePdfText(
            "This glossary provides plain-language explanations of technical terms used in this declaration, " +
            "for the benefit of non-technical reviewers."
          ),
          contentW
        ) as string[];
        doc.text(glossaryIntroLines, margin, y);
        y += glossaryIntroLines.length * 8.5 * 0.45 + 5;
        doc.setTextColor(0, 0, 0);

        const glossaryTerms: [string, string][] = [
          [
            "Bitcoin",
            "A decentralized digital currency that operates on a peer-to-peer network without a central authority. Transactions are recorded on a public ledger called the blockchain.",
          ],
          [
            "Bitcoin Address",
            "A unique identifier — similar to a bank account number — used to receive Bitcoin. An address is derived from a cryptographic key pair. Common formats begin with '1', '3', or 'bc1'.",
          ],
          [
            "Balance",
            "The total amount of Bitcoin currently held at an address, measured in BTC or satoshis, as reported by the blockchain at the time of declaration.",
          ],
          [
            "BTC",
            "The symbol for Bitcoin. One BTC equals 100,000,000 satoshis (sat). Balances in this document are expressed in BTC unless otherwise noted.",
          ],
          [
            "Satoshi (sat)",
            "The smallest unit of Bitcoin. 1 BTC = 100,000,000 satoshis. Named after Bitcoin's pseudonymous creator, Satoshi Nakamoto.",
          ],
          [
            "Blockchain",
            "A public, append-only ledger that permanently records all Bitcoin transactions. Each block of transactions is cryptographically linked to the previous one, making the history tamper-evident.",
          ],
          [
            "Block",
            "A batch of confirmed Bitcoin transactions added to the blockchain. Each block is identified by its height (position in the chain). Block height is used in this document as a time-anchor for reported balances.",
          ],
          [
            "Confirmation",
            "A transaction is 'confirmed' once it has been included in a block and broadcast across the network. Each subsequent block mined on top adds another confirmation, increasing finality.",
          ],
          [
            "UTXO (Unspent Transaction Output)",
            "The fundamental accounting unit of Bitcoin. Each received Bitcoin amount creates a UTXO; spending Bitcoin consumes one or more UTXOs as inputs and creates new UTXOs as outputs. An address's balance is the sum of its UTXOs.",
          ],
          [
            "xpub (Extended Public Key)",
            "A public key from which an entire sequence of Bitcoin addresses can be derived without exposing private keys. Sharing an xpub allows read-only balance monitoring across all derived addresses.",
          ],
          [
            "Proof of Control",
            "Cryptographic evidence that the declarant holds the private key corresponding to a Bitcoin address, demonstrated by signing a unique challenge message with that key using their wallet.",
          ],
          [
            "Bitcoin Signed Message",
            "A standard format for signing a text message with a Bitcoin private key, producing a base64-encoded signature that can be independently verified against the address. Supported by most Bitcoin wallets.",
          ],
          [
            "BIP-322",
            "Bitcoin Improvement Proposal 322 — a newer signing standard that supports modern address types including Taproot (bc1p…) addresses, using Schnorr signatures.",
          ],
          [
            "Hop",
            "A single transaction step between two Bitcoin addresses in the transaction graph. A '2-hop' connection means there are two intermediate transactions between the declared address and a named counterparty.",
          ],
          [
            "SHA-256",
            "A cryptographic hash function that produces a fixed-length (256-bit / 64-character hex) fingerprint from any input. Even a single character change in the input produces a completely different hash, making it useful for detecting document alterations.",
          ],
          [
            "Declaration Reference (Nonce)",
            "A randomly generated, unique identifier assigned to this declaration at the time of generation. It is embedded in every signed challenge message to prevent signatures from being reused across different declarations.",
          ],
          [
            "PEP (Politically Exposed Person)",
            "An individual who holds or has held a prominent public function (e.g. head of state, senior government official, senior judicial or military official). Financial institutions apply enhanced due diligence to PEPs.",
          ],
          [
            "AML (Anti-Money Laundering)",
            "Laws, regulations, and procedures designed to prevent criminals from disguising illegally obtained funds as legitimate income. AML compliance requires financial institutions to screen customers and their transaction histories.",
          ],
          [
            "KYC (Know Your Customer)",
            "A set of identity verification procedures financial institutions use to confirm the identity of their clients and assess the risk of illegal activity such as money laundering or fraud.",
          ],
        ];

        for (const [term, definition] of glossaryTerms) {
          const defLines = doc.splitTextToSize(sanitizePdfText(definition), contentW - 4) as string[];
          const neededHeight = 5 + defLines.length * 8.5 * 0.45 + 4;
          checkPageBreak(neededHeight + 2);

          doc.setFontSize(8.5);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(0, 0, 0);
          doc.text(sanitizePdfText(term), margin, y);
          y += 4.5;

          doc.setFont("helvetica", "normal");
          doc.setTextColor(50, 50, 50);
          doc.text(defLines, margin + 4, y);
          doc.setTextColor(0, 0, 0);
          y += defLines.length * 8.5 * 0.45 + 3;
        }
      }

      // ── Supporting Evidence appendix (real declarations only) ──────────────
      // Image exhibits are embedded here; PDF exhibits are listed in the index
      // and then merged onto the end of the dossier (after this jsPDF document)
      // in the output step below. Skipped entirely in sample mode so specimen
      // PDFs never carry attachments and stay fully watermarked.
      if (!isSample && evidenceItems.length > 0) {
        doc.addPage();
        y = 20;
        addLine("APPENDIX: SUPPORTING EVIDENCE", 13, true);
        addSpacer(2);
        addWrapped(
          "The declarant attached the following supporting evidence. Image files are embedded in this appendix. " +
            "PDF documents are merged onto the end of this dossier as additional pages, in the order listed below. " +
            "Each item's SHA-256 hash is recorded so a reviewer can independently confirm the attachment has not been altered.",
          9,
          [60, 60, 60],
        );
        addSpacer(3);

        // Exhibit index — every attachment, in upload order.
        addLine("Evidence index", 11, true);
        addSpacer(1);
        let exhibitNo = 0;
        evidenceItems.forEach((it, i) => {
          const isPdf = it.kind === "pdf";
          const exhibitLabel = isPdf ? `Exhibit ${++exhibitNo}` : "Embedded image";
          const meta = isPdf
            ? `PDF, ${formatEvidenceSize(it.size)}, ${it.pageCount ?? "?"} page${it.pageCount === 1 ? "" : "s"}`
            : `Image, ${formatEvidenceSize(it.size)}`;
          checkPageBreak(20);
          addLine(`${i + 1}. ${it.name}  [${exhibitLabel}]`, 9, true);
          addWrapped(meta, 8, [90, 90, 90]);
          if (it.caption.trim()) {
            addWrapped(`Caption: ${it.caption.trim()}`, 8, [60, 60, 60]);
          }
          addWrapped(`SHA-256: ${it.sha256}`, 7, [120, 120, 120]);
          if (isPdf) {
            addWrapped(
              `Merged as ${exhibitLabel} — its ${it.pageCount ?? "?"} page${it.pageCount === 1 ? "" : "s"} follow after this appendix.`,
              8,
              [90, 90, 90],
            );
          }
          addSpacer(2);
        });

        // Embedded images.
        const imageItems = evidenceItems.filter(
          (it) => it.kind === "image" && it.dataUrl,
        );
        if (imageItems.length > 0) {
          addSpacer(2);
          checkPageBreak(16);
          addLine("Embedded images", 11, true);
          addSpacer(2);
          const pageH = doc.internal.pageSize.getHeight();
          for (const it of imageItems) {
            const fmt =
              it.mime === "image/png"
                ? "PNG"
                : it.mime === "image/webp"
                  ? "WEBP"
                  : "JPEG";
            let dispW = contentW;
            let dispH = contentW * 0.75; // fallback ratio if properties unavailable
            try {
              const props = doc.getImageProperties(it.dataUrl!);
              if (props.width > 0 && props.height > 0) {
                dispW = contentW;
                dispH = (props.height / props.width) * dispW;
                const maxH = pageH - 50;
                if (dispH > maxH) {
                  dispH = maxH;
                  dispW = (props.width / props.height) * dispH;
                }
              }
            } catch {
              // Keep the fallback size if jsPDF can't read the image header.
            }
            const captionH = it.caption.trim() ? 8 : 0;
            checkPageBreak(8 + dispH + captionH + 8);
            addLine(it.name, 9, true);
            doc.addImage(it.dataUrl!, fmt, margin, y, dispW, dispH);
            y += dispH + 3;
            if (it.caption.trim()) {
              addWrapped(`Caption: ${it.caption.trim()}`, 8, [60, 60, 60]);
            }
            addWrapped(`SHA-256: ${it.sha256}`, 7, [120, 120, 120]);
            addSpacer(4);
          }
        }
      }

      // ── Page X of Y footers (applied to every page after all content) ──────
      const totalPages = (doc.internal as any).getNumberOfPages();
      const pageHFt = doc.internal.pageSize.getHeight();
      const footerY = pageHFt - 8;
      const shortRef = effNonce.length > 20
        ? `${effNonce.slice(0, 10)}…${effNonce.slice(-8)}`
        : effNonce;
      const hasPdfExhibits =
        !isSample && evidenceItems.some((it) => it.kind === "pdf");

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        doc.setPage(pageNum);
        doc.setFontSize(7);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(120, 120, 120);
        doc.text(
          sanitizePdfText(
            `Page ${pageNum} of ${totalPages}${hasPdfExhibits ? " + exhibits" : ""}`,
          ),
          margin,
          footerY
        );
        doc.text(
          sanitizePdfText(`Ref: ${shortRef}`),
          pageW / 2,
          footerY,
          { align: "center" }
        );
        doc.text(
          sanitizePdfText(isSample ? "PROOF OF FUNDS DECLARATION — SPECIMEN" : "PROOF OF FUNDS DECLARATION"),
          pageW - margin,
          footerY,
          { align: "right" }
        );
        doc.setTextColor(0, 0, 0);
      }

      // ── Diagonal watermark on every page (sample mode only) ───────────────
      if (isSample) {
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
          doc.setPage(pageNum);
          doc.setFontSize(52);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(220, 0, 0);
          doc.setGState(new (doc as any).GState({ opacity: 0.08 }));
          const cx = pageW / 2;
          const cy = pageHFt / 2;
          doc.text("SPECIMEN", cx, cy, { align: "center", angle: 45 });
          doc.setGState(new (doc as any).GState({ opacity: 1 }));
          doc.setTextColor(0, 0, 0);
        }
      }

      const safeName = sanitizePdfText(effName.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, ""));
      const baseFileName = isSample
        ? `proof-of-funds-SAMPLE-${safeName || "specimen"}-${effDate}.pdf`
        : `proof-of-funds-${safeName || "declaration"}-${effDate}.pdf`;

      // PDF exhibits can only be appended after the jsPDF document is complete:
      // jsPDF cannot import external PDF pages, so we hand the finished dossier
      // bytes plus each uploaded PDF to pdf-lib and download the combined file.
      // Image exhibits are already embedded above, so they need no merge. Sample
      // mode never attaches exhibits, so it always takes the plain save path.
      const pdfExhibits: PdfExhibit[] = isSample
        ? []
        : evidenceItems
            .filter((it) => it.kind === "pdf")
            .map((it) => ({ name: it.name, bytes: it.bytes }));

      if (pdfExhibits.length > 0) {
        const baseBytes = new Uint8Array(
          doc.output("arraybuffer") as ArrayBuffer,
        );
        const mergedBytes = await mergeEvidencePdfs(baseBytes, pdfExhibits);
        const blob = new Blob([mergedBytes as BlobPart], {
          type: "application/pdf",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = baseFileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
      } else {
        doc.save(baseFileName);
      }
  }, [
    declarantName,
    evidenceItems,
    declarantContact,
    declarantResidentialAddress,
    declarantDob,
    declarantTaxId,
    declarantIdNumber,
    declarantNationality,
    declarationDate,
    declarationNonce,
    purpose,
    statement,
    summary,
    doneRows,
    totalSats,
    fiatValid,
    fiatTotal,
    fiatCurrency,
    fiatRateNum,
    controlStates,
    toast,
    includeProvenance,
    provenanceFiatCurrency,
    includeQr,
    qrExplorerId,
    includeAml,
    amlPepStatus,
    amlTaxJurisdiction,
    amlSourceOfWealth,
    amlSourceOfFunds,
    amlTaxStatement,
    includeIntro,
    includeAttestation,
    attestationPlaceOfSigning,
    attestationWitnessLine,
    includeGlossary,
  ]);

  const generatePdf = useCallback(async () => {
    setIsGeneratingPdf(true);
    try {
      await buildPofPdf(false);
      toast({ title: "PDF Downloaded", description: "Your Proof of Funds Declaration has been saved." });
    } catch (err) {
      console.error("[ProofOfFunds] PDF generation failed:", err);
      toast({
        variant: "destructive",
        title: "PDF Export Failed",
        description: err instanceof Error ? err.message : "An unexpected error occurred during PDF generation.",
      });
    } finally {
      setIsGeneratingPdf(false);
    }
  }, [buildPofPdf, canGeneratePdf, toast]);

  const generateSamplePdf = useCallback(async () => {
    setIsGeneratingSamplePdf(true);
    try {
      await buildPofPdf(true);
      toast({ title: "Sample PDF Downloaded", description: "The specimen format preview has been saved. It is not a valid declaration." });
    } catch (err) {
      console.error("[ProofOfFunds] Sample PDF generation failed:", err);
      toast({
        variant: "destructive",
        title: "Sample PDF Export Failed",
        description: err instanceof Error ? err.message : "An unexpected error occurred during sample PDF generation.",
      });
    } finally {
      setIsGeneratingSamplePdf(false);
    }
  }, [buildPofPdf, toast]);

  const validCount = validRows.length;
  const doneCount = doneRows.length + emptyRows.length + errorRows.length;

  const declarantInfoComplete =
    declarantName.trim() !== "" &&
    declarationDate !== "" &&
    purpose.trim() !== "";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <FileText className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Proof of Funds Declaration</h1>
            <p className="text-muted-foreground">
              Generate a formal declaration attesting to Bitcoin address ownership and balances
            </p>
          </div>
        </div>

        {/* Step 1: Address Input */}
        <Card>
          <CardHeader>
            <CardTitle>Step 1 — Bitcoin Addresses</CardTitle>
            <CardDescription>
              Enter addresses by pasting a list, or select from your vault by owner or wallet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={addressTab} onValueChange={(v) => setAddressTab(v as "paste" | "vault")}>
              <TabsList>
                <TabsTrigger value="paste" data-testid="tab-paste-addresses">Paste List</TabsTrigger>
                <TabsTrigger value="vault" data-testid="tab-vault-addresses">From Vault</TabsTrigger>
              </TabsList>

              <TabsContent value="paste" className="space-y-2 mt-3">
                <Textarea
                  placeholder={`bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh\nbc1q...\n1A1zP1...`}
                  className="min-h-[120px] font-mono text-sm"
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  disabled={isChecking}
                  data-testid="textarea-address-input"
                />
                <p className="text-xs text-muted-foreground">
                  Separate addresses with newlines, commas, or semicolons. Duplicates are removed automatically.
                </p>
              </TabsContent>

              <TabsContent value="vault" className="space-y-3 mt-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label>Filter by Owner</Label>
                    <Select value={filterOwner} onValueChange={setFilterOwner} disabled={isChecking}>
                      <SelectTrigger data-testid="select-filter-owner">
                        <SelectValue placeholder="All owners" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All owners</SelectItem>
                        {owners.map((o) => (
                          <SelectItem key={o.name} value={o.name}>{o.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Filter by Wallet</Label>
                    <Select value={filterWallet} onValueChange={setFilterWallet} disabled={isChecking}>
                      <SelectTrigger data-testid="select-filter-wallet">
                        <SelectValue placeholder="All wallets" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All wallets</SelectItem>
                        {walletNames.map((w) => (
                          <SelectItem key={w.name} value={w.name}>{w.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  All address records matching the selected filters will be included.
                </p>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Step 2: Balance Source */}
        <Card>
          <CardHeader>
            <CardTitle>Step 2 — Balance Source</CardTitle>
            <CardDescription>
              Choose how balances are resolved for each address.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setBalanceSource("offline")}
                disabled={isChecking}
                data-testid="button-source-offline"
                className={`flex items-start gap-3 rounded-md border p-4 text-left transition-colors ${
                  balanceSource === "offline"
                    ? "border-primary bg-primary/5"
                    : "border-border hover-elevate"
                }`}
              >
                <Database className={`h-5 w-5 mt-0.5 shrink-0 ${balanceSource === "offline" ? "text-primary" : "text-muted-foreground"}`} />
                <div>
                  <div className="font-medium text-sm">Offline Vault Data</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Use already-synced data from your vault. No network required. Shows last-sync timestamp.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setBalanceSource("live")}
                disabled={isChecking}
                data-testid="button-source-live"
                className={`flex items-start gap-3 rounded-md border p-4 text-left transition-colors ${
                  balanceSource === "live"
                    ? "border-primary bg-primary/5"
                    : "border-border hover-elevate"
                }`}
              >
                <Wifi className={`h-5 w-5 mt-0.5 shrink-0 ${balanceSource === "live" ? "text-primary" : "text-muted-foreground"}`} />
                <div>
                  <div className="font-medium text-sm">Live On-Chain Check</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Query your configured node for real-time balances. Shows block height and timestamp.
                  </div>
                </div>
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={runCheck}
                disabled={isChecking || (addressTab === "paste" && !pastedText.trim())}
                data-testid="button-check-balances"
              >
                {isChecking ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Checking…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Check Balances
                  </>
                )}
              </Button>

              {isChecking && (
                <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-check">
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              )}

              {hasResults && !isChecking && (
                <Button variant="outline" onClick={handleReset} data-testid="button-reset">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Reset
                </Button>
              )}

              {isChecking && validCount > 0 && balanceSource === "live" && (
                <span className="text-sm text-muted-foreground" data-testid="text-check-progress">
                  {doneCount} / {validCount} done
                </span>
              )}
            </div>

            {providerError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {providerError}{" "}
                  <Link
                    href="/node-settings"
                    className="font-medium underline underline-offset-2"
                    data-testid="link-node-settings"
                  >
                    Check Node Connection settings
                  </Link>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        {hasResults && (
          <Card>
            <CardHeader>
              <CardTitle>Balance Results</CardTitle>
              {summary && (
                <CardDescription data-testid="text-data-source-note">
                  {summary.asOfLabel}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {dupes > 0 && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {dupes} duplicate address{dupes !== 1 ? "es were" : " was"} removed.
                  </AlertDescription>
                </Alert>
              )}

              {validRows.filter((r) => r.status !== "empty").length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Address</TableHead>
                      <TableHead className="text-right">Balance (BTC)</TableHead>
                      <TableHead className="w-28">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validRows.filter((r) => r.status !== "empty").map((row, idx) => (
                      <TableRow key={idx} data-testid={`row-address-${idx}`}>
                        <TableCell className="font-mono text-xs break-all">
                          {row.raw}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {row.status === "done"
                            ? formatBTC(row.balanceSats ?? 0)
                            : <span className="text-muted-foreground">—</span>
                          }
                        </TableCell>
                        <TableCell>
                          {row.status === "pending" && (
                            <Badge variant="secondary" className="gap-1">
                              <Clock className="h-3 w-3" />
                              Pending
                            </Badge>
                          )}
                          {row.status === "loading" && (
                            <Badge variant="secondary" className="gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Checking
                            </Badge>
                          )}
                          {row.status === "done" && (
                            <Badge variant="secondary" className="gap-1 text-green-600 dark:text-green-400">
                              <CheckCircle className="h-3 w-3" />
                              Done
                            </Badge>
                          )}
                          {row.status === "error" && (
                            <Badge variant="destructive" className="gap-1" title={row.error}>
                              <AlertCircle className="h-3 w-3" />
                              Error
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {doneRows.length === 0 && emptyRows.length > 0 && !isChecking && (
                <Alert data-testid="alert-all-empty">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    All {emptyRows.length} address{emptyRows.length !== 1 ? "es" : ""} resolved to a zero balance and were excluded. There is nothing to declare.
                  </AlertDescription>
                </Alert>
              )}

              {doneRows.length > 0 && (
                <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
                  <span className="font-semibold text-sm">Total Balance</span>
                  <div className="text-right">
                    <div className="font-bold font-mono tabular-nums" data-testid="text-total-balance">
                      {formatBTC(totalSats)} BTC
                    </div>
                    {fiatValid && fiatTotal !== null && (
                      <div className="text-sm text-muted-foreground font-mono tabular-nums" data-testid="text-fiat-total">
                        ≈ {fiatTotal.toLocaleString("en-US", {
                          style: "currency",
                          currency: fiatCurrency,
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })} {fiatCurrency}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {emptyRows.length > 0 && doneRows.length > 0 && (
                <Alert data-testid="alert-empty-excluded">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {emptyRows.length} empty address{emptyRows.length !== 1 ? "es" : ""} excluded — {emptyRows.length !== 1 ? "these addresses have" : "this address has"} a zero balance and will not appear in the declaration.
                  </AlertDescription>
                </Alert>
              )}

              {invalidRows.length > 0 && (
                <div className="rounded-md border border-destructive/30">
                  <button
                    type="button"
                    onClick={() => setShowInvalid((v) => !v)}
                    className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium text-destructive hover-elevate rounded-md"
                    data-testid="button-toggle-invalid"
                  >
                    <span className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      {invalidRows.length} invalid address{invalidRows.length !== 1 ? "es" : ""} (excluded from declaration)
                    </span>
                    {showInvalid ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showInvalid && (
                    <div className="border-t px-4 pb-3 pt-2 space-y-1">
                      {invalidRows.map((r, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs">
                          <AlertCircle className="h-3 w-3 text-destructive mt-0.5 shrink-0" />
                          <span className="font-mono text-destructive break-all">{r.raw}</span>
                          <span className="text-muted-foreground shrink-0">— {r.invalidReason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {errorRows.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {errorRows.length} address{errorRows.length !== 1 ? "es" : ""} failed to load
                    {balanceSource === "live" ? " — check your Node Connection settings." : "."}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 3: Declarant Details */}
        <Card>
          <CardHeader>
            <CardTitle>Step 3 — Declarant Details</CardTitle>
            <CardDescription>
              These details appear in the declaration header and signature block.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="declarant-name">Full Name <span className="text-destructive">*</span></Label>
                <Input
                  id="declarant-name"
                  placeholder="Your full legal name"
                  value={declarantName}
                  onChange={(e) => setDeclarantName(e.target.value)}
                  data-testid="input-declarant-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="declaration-date">Declaration Date <span className="text-destructive">*</span></Label>
                <Input
                  id="declaration-date"
                  type="date"
                  value={declarationDate}
                  onChange={(e) => setDeclarationDate(e.target.value)}
                  data-testid="input-declaration-date"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="declarant-contact">Contact / Address <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                id="declarant-contact"
                placeholder="Email, postal address, or other contact information"
                value={declarantContact}
                onChange={(e) => setDeclarantContact(e.target.value)}
                data-testid="input-declarant-contact"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="declarant-residential-address">Residential / Street Address <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                id="declarant-residential-address"
                placeholder="Street address, city, state / country"
                value={declarantResidentialAddress}
                onChange={(e) => setDeclarantResidentialAddress(e.target.value)}
                data-testid="input-declarant-residential-address"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="declarant-dob">Date of Birth <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  id="declarant-dob"
                  type="date"
                  value={declarantDob}
                  onChange={(e) => setDeclarantDob(e.target.value)}
                  data-testid="input-declarant-dob"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="declarant-nationality">Nationality <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  id="declarant-nationality"
                  placeholder="e.g. United States"
                  value={declarantNationality}
                  onChange={(e) => setDeclarantNationality(e.target.value)}
                  data-testid="input-declarant-nationality"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="declarant-tax-id">Tax ID Number <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  id="declarant-tax-id"
                  placeholder="e.g. SSN, EIN, TIN"
                  value={declarantTaxId}
                  onChange={(e) => setDeclarantTaxId(e.target.value)}
                  data-testid="input-declarant-tax-id"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="declarant-id-number">Identification Number <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  id="declarant-id-number"
                  placeholder="e.g. Passport or national ID number"
                  value={declarantIdNumber}
                  onChange={(e) => setDeclarantIdNumber(e.target.value)}
                  data-testid="input-declarant-id-number"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="purpose">Purpose <span className="text-destructive">*</span></Label>
              <Input
                id="purpose"
                placeholder="e.g. Proof of funds for a residential property purchase"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                data-testid="input-purpose"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="statement">Declaration Statement <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea
                id="statement"
                placeholder="I, the undersigned, hereby declare that I am the sole owner of the Bitcoin addresses listed in this document and that the balances shown represent funds under my direct control..."
                className="min-h-[100px]"
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                data-testid="textarea-statement"
              />
            </div>

            {/* Live preview of the declarant details that will appear in the PDF.
                Optional identity fields only show when filled (mirrors the PDF). */}
            {declarantPreviewRows.length > 0 && (
              <div
                className="rounded-md border bg-muted/30 p-4 space-y-2"
                data-testid="declarant-preview"
              >
                <h4 className="text-sm font-semibold">Declaration Preview</h4>
                <p className="text-xs text-muted-foreground">
                  This is how the declarant details will appear in the PDF. Blank optional fields are omitted.
                </p>
                <dl className="space-y-1 text-sm">
                  {declarantPreviewRows.map((row) => (
                    <div
                      key={row.key}
                      className="flex flex-wrap gap-x-2"
                      data-testid={`preview-row-${row.key}`}
                    >
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="font-medium break-all" data-testid={row.testid}>
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 4: Optional Fiat */}
        <Card>
          <CardHeader>
            <CardTitle>Step 4 — Fiat Equivalent <span className="text-muted-foreground font-normal text-base">(Optional)</span></CardTitle>
            <CardDescription>
              Enter an exchange rate and currency to include a fiat equivalent in the PDF.
              The rate is supplied by you — it is not fetched from any market feed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="fiat-currency">Currency</Label>
                <Select value={fiatCurrency} onValueChange={setFiatCurrency}>
                  <SelectTrigger id="fiat-currency" data-testid="select-fiat-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD — US Dollar</SelectItem>
                    <SelectItem value="EUR">EUR — Euro</SelectItem>
                    <SelectItem value="GBP">GBP — British Pound</SelectItem>
                    <SelectItem value="CAD">CAD — Canadian Dollar</SelectItem>
                    <SelectItem value="AUD">AUD — Australian Dollar</SelectItem>
                    <SelectItem value="CHF">CHF — Swiss Franc</SelectItem>
                    <SelectItem value="JPY">JPY — Japanese Yen</SelectItem>
                    <SelectItem value="SGD">SGD — Singapore Dollar</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="fiat-rate">Exchange Rate (BTC per 1 {fiatCurrency})</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground whitespace-nowrap">1 BTC =</span>
                  <Input
                    id="fiat-rate"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="e.g. 65000"
                    value={fiatRate}
                    onChange={(e) => setFiatRate(e.target.value)}
                    data-testid="input-fiat-rate"
                  />
                  <span className="text-sm text-muted-foreground">{fiatCurrency}</span>
                </div>
              </div>
            </div>

            {fiatValid && summary && doneRows.length > 0 && fiatTotal !== null && (
              <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm space-y-1">
                <div className="font-medium">
                  Fiat Equivalent: {fiatTotal.toLocaleString("en-US", {
                    style: "currency",
                    currency: fiatCurrency,
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} {fiatCurrency}
                </div>
                <div className="text-xs text-muted-foreground">
                  Rate supplied by declarant — not a market quote or financial advice.
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 5: Proof of Control */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Step 5 — Proof of Control
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Strengthen the declaration by proving cryptographic control of each address.
              Sign the challenge message below in your own wallet, then paste the resulting
              signature here. No private keys are shared with KYUTXO — only the address,
              message, and signature are used for verification.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!declarantInfoComplete && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Complete Step 3 (declarant name, date, and purpose) first so the challenge message
                  can be generated. Any signatures you collect must match that exact message.
                </AlertDescription>
              </Alert>
            )}

            {doneRows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Check balances for at least one valid address (Step 2) to unlock this step.
              </p>
            )}

            {doneRows.length > 0 && declarantInfoComplete && (
              <>
                <Alert>
                  <Shield className="h-4 w-4" />
                  <AlertDescription className="space-y-1">
                    <p className="font-medium">Supported formats</p>
                    <p className="text-xs">
                      Bitcoin Signed Message (legacy format) — supported by Bitcoin Core, Electrum,
                      BlueWallet, Sparrow, Trezor, Ledger, and most hardware/software wallets.
                      Works for P2PKH (1…), P2SH-P2WPKH (3…), and native SegWit P2WPKH (bc1q…) addresses.
                    </p>
                    <p className="text-xs">
                      BIP-322 — for native SegWit (bc1q…), Taproot (bc1p…), and P2SH-wrapped
                      (3…) addresses, including multisig vaults (P2WSH, P2SH-P2WSH, and Taproot
                      script-path). Paste the base64 signature produced by a BIP-322 capable
                      wallet such as Bitcoin Core 24+ or Sparrow.
                    </p>
                  </AlertDescription>
                </Alert>

                {verifiedCount > 0 && (
                  <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                    <ShieldCheck className="h-4 w-4" />
                    {verifiedCount} of {doneRows.length} address{doneRows.length !== 1 ? "es" : ""} control-verified
                  </div>
                )}

                {/* Optional add-ons: verifier reference + block-hash freshness anchor */}
                <div className="rounded-md border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover-elevate rounded-md"
                    onClick={() => setProofAddonsOpen((v) => !v)}
                    data-testid="button-proof-addons-toggle"
                  >
                    <span className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-muted-foreground" />
                      Optional add-ons
                      <Badge variant="secondary" className="text-xs font-normal">both off by default</Badge>
                    </span>
                    {proofAddonsOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </button>

                  {proofAddonsOpen && (
                    <div className="border-t px-4 py-4 space-y-5">
                      {/* Verifier reference */}
                      <div className="space-y-2">
                        <Label htmlFor="verifier-reference" className="text-sm font-medium">
                          Verifier reference{" "}
                          <span className="text-muted-foreground font-normal">(optional)</span>
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Free text the requesting party (e.g. a bank) wants embedded in the signed
                          message — such as a case number or request ID. Leave blank to omit.
                        </p>
                        <Input
                          id="verifier-reference"
                          placeholder="e.g. ACME Bank request #2026-001"
                          value={verifierReference}
                          onChange={(e) => setVerifierReference(e.target.value)}
                          data-testid="input-verifier-reference"
                          maxLength={200}
                        />
                        {verifierReference.trim() && (
                          <p className="text-xs text-muted-foreground font-mono">
                            Will appear in message as: <span className="text-foreground">Verifier ref: {verifierReference.trim()}</span>
                          </p>
                        )}
                      </div>

                      <Separator />

                      {/* Block-hash freshness anchor */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                          <div className="space-y-0.5">
                            <Label htmlFor="freshness-anchor-toggle" className="text-sm font-medium">
                              Add freshness anchor (block hash){" "}
                              <span className="text-muted-foreground font-normal">(optional)</span>
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              Embeds the current block height + hash in the signed message, proving the
                              signature was made at or after that block. No third party involved.
                            </p>
                          </div>
                          <Switch
                            id="freshness-anchor-toggle"
                            checked={freshnessAnchorEnabled}
                            onCheckedChange={(v) => {
                              setFreshnessAnchorEnabled(v);
                              if (v) {
                                fetchFreshnessAnchor();
                              } else {
                                setFreshnessAnchor(null);
                                setFreshnessAnchorError(null);
                              }
                            }}
                            data-testid="switch-freshness-anchor"
                          />
                        </div>

                        {freshnessAnchorEnabled && (
                          <div className="space-y-3 pl-1">
                            {freshnessAnchor ? (
                              <Alert className="py-2 border-green-500/50 [&>svg]:text-green-600 dark:[&>svg]:text-green-400">
                                <ShieldCheck className="h-3.5 w-3.5" />
                                <AlertDescription className="text-xs space-y-1">
                                  <p className="font-medium text-green-700 dark:text-green-300">Block anchor set</p>
                                  <p className="font-mono break-all">Height: {freshnessAnchor.height}</p>
                                  <p className="font-mono break-all">Hash: {freshnessAnchor.hash}</p>
                                  <p className="text-muted-foreground">Fetched: {freshnessAnchor.fetchedAt}</p>
                                  <p className="text-muted-foreground">
                                    This proves signatures were created at or after block {freshnessAnchor.height}.
                                  </p>
                                </AlertDescription>
                              </Alert>
                            ) : null}

                            <div className="flex gap-2 flex-wrap">
                              <Button
                                size="sm"
                                variant={freshnessAnchor ? "outline" : "default"}
                                onClick={fetchFreshnessAnchor}
                                disabled={freshnessAnchorFetching}
                                data-testid="button-fetch-freshness-anchor"
                              >
                                {freshnessAnchorFetching ? (
                                  <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Fetching…</>
                                ) : freshnessAnchor ? (
                                  <><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh anchor</>
                                ) : (
                                  <><Download className="h-3.5 w-3.5 mr-1.5" />Fetch current block</>
                                )}
                              </Button>
                              {freshnessAnchor && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => { setFreshnessAnchor(null); setFreshnessAnchorError(null); }}
                                  data-testid="button-clear-freshness-anchor"
                                >
                                  <X className="h-3.5 w-3.5 mr-1.5" />Clear
                                </Button>
                              )}
                            </div>

                            {freshnessAnchorError && (
                              <div className="space-y-2">
                                <Alert variant="destructive" className="py-2">
                                  <AlertCircle className="h-3.5 w-3.5" />
                                  <AlertDescription className="text-xs">
                                    {freshnessAnchorError}
                                  </AlertDescription>
                                </Alert>
                                <p className="text-xs text-muted-foreground">
                                  Paste the block height and hash manually — you can look them up on any
                                  Bitcoin block explorer.
                                </p>
                                <div className="flex gap-2 flex-wrap items-start">
                                  <div className="space-y-1">
                                    <Label className="text-xs">Block height</Label>
                                    <Input
                                      placeholder="e.g. 900000"
                                      value={freshnessManualHeight}
                                      onChange={(e) => setFreshnessManualHeight(e.target.value)}
                                      className="w-32 text-xs font-mono"
                                      aria-invalid={!!freshnessManualHeightError}
                                      data-testid="input-freshness-manual-height"
                                    />
                                    {freshnessManualHeightError && (
                                      <p
                                        className="text-xs text-destructive"
                                        data-testid="error-freshness-manual-height"
                                      >
                                        {freshnessManualHeightError}
                                      </p>
                                    )}
                                  </div>
                                  <div className="space-y-1 flex-1">
                                    <Label className="text-xs">Block hash</Label>
                                    <Input
                                      placeholder="64-character hex hash"
                                      value={freshnessManualHash}
                                      onChange={(e) => setFreshnessManualHash(e.target.value)}
                                      className="text-xs font-mono"
                                      aria-invalid={!!freshnessManualHashError}
                                      data-testid="input-freshness-manual-hash"
                                    />
                                    {freshnessManualHashError && (
                                      <p
                                        className="text-xs text-destructive"
                                        data-testid="error-freshness-manual-hash"
                                      >
                                        {freshnessManualHashError}
                                      </p>
                                    )}
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs invisible">Apply</Label>
                                    <Button
                                      size="sm"
                                      onClick={applyManualFreshnessAnchor}
                                      disabled={!canApplyManualFreshnessAnchor}
                                      data-testid="button-apply-manual-freshness"
                                    >
                                      Apply
                                    </Button>
                                  </div>
                                </div>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-xs"
                                  onClick={() => { setFreshnessAnchorEnabled(false); setFreshnessAnchor(null); setFreshnessAnchorError(null); }}
                                  data-testid="button-proceed-without-anchor"
                                >
                                  Proceed without freshness anchor
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-6">
                  {doneRows.map((row, idx) => {
                    const cs = controlStates[row.raw] ?? { paste: "", status: "idle" as ControlStatus };
                    const isTaproot = row.raw.startsWith("bc1p") || row.raw.startsWith("tb1p");
                    const challengeMsg = buildChallengeMessage({
                      address: row.raw,
                      declarantName,
                      declarationDate,
                      purpose,
                      nonce: declarationNonce,
                      verifierReference: verifierReference || undefined,
                      freshnessAnchor: freshnessAnchor ?? undefined,
                    });
                    const copied = copiedAddresses.has(row.raw);

                    return (
                      <div key={idx} className="space-y-3 rounded-md border p-4">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="font-mono text-xs break-all text-muted-foreground">
                            {row.raw}
                          </div>
                          {cs.status === "verified" && (
                            <Badge className="gap-1 bg-green-600 dark:bg-green-700 text-white shrink-0">
                              <ShieldCheck className="h-3 w-3" />
                              Control Verified
                            </Badge>
                          )}
                          {cs.status === "failed" && (
                            <Badge variant="destructive" className="gap-1 shrink-0">
                              <AlertCircle className="h-3 w-3" />
                              Verification Failed
                            </Badge>
                          )}
                          {cs.status === "idle" && cs.staleAfterVerify && (
                            <Badge
                              variant="outline"
                              className="gap-1 shrink-0 border-amber-500 text-amber-600 dark:text-amber-400"
                              data-testid={`badge-stale-${idx}`}
                            >
                              <AlertCircle className="h-3 w-3" />
                              Re-verification Needed
                            </Badge>
                          )}
                          {cs.status === "idle" && !cs.staleAfterVerify && (
                            <Badge variant="secondary" className="gap-1 shrink-0">
                              <Shield className="h-3 w-3" />
                              Self-Declared (Unverified)
                            </Badge>
                          )}
                        </div>

                        {cs.status === "idle" && cs.staleAfterVerify && (
                          <Alert
                            className="py-2 border-amber-500/60 text-amber-700 dark:text-amber-300 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400"
                            data-testid={`alert-stale-${idx}`}
                          >
                            <AlertCircle className="h-3.5 w-3.5" />
                            <AlertDescription className="text-xs">
                              Challenge message changed — re-verify your signature. The declarant
                              details, verifier reference, or block anchor were updated, so the
                              previous signature no longer matches.
                            </AlertDescription>
                          </Alert>
                        )}

                        {(
                          <>
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <Label className="text-xs font-medium">Challenge Message</Label>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleCopyChallenge(row.raw)}
                                      data-testid={`button-copy-challenge-${idx}`}
                                      className="h-7 text-xs gap-1.5"
                                    >
                                      {copied ? (
                                        <>
                                          <ClipboardCheck className="h-3.5 w-3.5 text-green-600" />
                                          Copied
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="h-3.5 w-3.5" />
                                          Copy
                                        </>
                                      )}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Copy message to clipboard</TooltipContent>
                                </Tooltip>
                              </div>
                              <pre
                                className="rounded-md bg-muted/60 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed"
                                data-testid={`text-challenge-${idx}`}
                              >
                                {challengeMsg}
                              </pre>
                              <p className="text-xs text-muted-foreground">
                                {isTaproot
                                  ? 'In a BIP-322 capable wallet (Bitcoin Core 24+, Sparrow), use "Sign Message" and paste the text above exactly as shown.'
                                  : 'In your wallet, use "Sign Message" (or equivalent) and paste the text above exactly as shown.'}
                              </p>
                            </div>

                            <div className="space-y-2">
                              <Label className="text-xs font-medium" htmlFor={`sig-input-${idx}`}>
                                {isTaproot
                                  ? "Paste BIP-322 Signature (base64)"
                                  : "Paste Wallet Signature (base64)"}
                              </Label>
                              <Textarea
                                id={`sig-input-${idx}`}
                                placeholder="Paste the base64 signature from your wallet here…"
                                className="min-h-[80px] font-mono text-xs resize-none"
                                value={cs.paste}
                                onChange={(e) => handleSignaturePaste(row.raw, e.target.value)}
                                data-testid={`textarea-signature-${idx}`}
                                disabled={cs.status === "verifying"}
                              />

                              {cs.status === "failed" && cs.error && (
                                <Alert variant="destructive" className="py-2">
                                  <AlertCircle className="h-3.5 w-3.5" />
                                  <AlertDescription className="text-xs">
                                    {cs.error}
                                  </AlertDescription>
                                </Alert>
                              )}

                              {cs.status === "verified" && (
                                <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 font-medium">
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  Signature verified
                                  {cs.verifiedFormat
                                    ? ` (${signatureFormatLabel(cs.verifiedFormat)})`
                                    : ""}
                                  {" "}— control of this address is cryptographically proven.
                                </div>
                              )}

                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant={cs.status === "verified" ? "outline" : "default"}
                                  onClick={() => handleVerify(row.raw)}
                                  disabled={cs.status === "verifying" || !cs.paste.trim()}
                                  data-testid={`button-verify-${idx}`}
                                >
                                  {cs.status === "verifying" ? (
                                    <>
                                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                      Verifying…
                                    </>
                                  ) : cs.status === "verified" ? (
                                    <>
                                      <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                                      Re-verify
                                    </>
                                  ) : (
                                    <>
                                      <Shield className="h-3.5 w-3.5 mr-1.5" />
                                      Verify Signature
                                    </>
                                  )}
                                </Button>

                                {(cs.paste || cs.status !== "idle") && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      setControlStates((prev) => ({
                                        ...prev,
                                        [row.raw]: { paste: "", status: "idle" },
                                      }))
                                    }
                                    data-testid={`button-clear-sig-${idx}`}
                                  >
                                    <X className="h-3.5 w-3.5 mr-1.5" />
                                    Clear
                                  </Button>
                                )}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Step 6: Balance-Verification QR Codes */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCodeIcon className="h-5 w-5" />
              Step 6 — Verification QR Codes
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add a QR code for each address so the recipient can scan it and look up the
              balance on a public block explorer. The codes are drawn entirely offline —
              KYUTXO never contacts the explorer. They simply encode a link the recipient
              can choose to open (which requires their own internet connection).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-qr" className="text-sm font-medium">
                  Include verification QR codes in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Adds one QR code per address with a checked balance.
                </p>
              </div>
              <Switch
                id="include-qr"
                checked={includeQr}
                onCheckedChange={setIncludeQr}
                data-testid="switch-include-qr"
              />
            </div>

            {includeQr && (
              <>
                <Separator />

                {doneRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one valid address (Step 2) to generate codes.
                  </p>
                ) : (
                  <>
                    <div className="space-y-2 max-w-xs">
                      <Label htmlFor="qr-explorer" className="text-sm">Block explorer</Label>
                      <Select
                        value={qrExplorerId}
                        onValueChange={(v) => setQrExplorerId(v as ExplorerId)}
                      >
                        <SelectTrigger id="qr-explorer" data-testid="select-qr-explorer">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {QR_EXPLORERS.map((e) => (
                            <SelectItem key={e.id} value={e.id} data-testid={`option-explorer-${e.id}`}>
                              {e.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Each code links to{" "}
                        <span className="font-mono">{getExplorer(qrExplorerId).host}</span>.
                      </p>
                    </div>

                    <Alert>
                      <Globe className="h-4 w-4" />
                      <AlertDescription>
                        Scanning a code opens a third-party block explorer and shares the
                        address with it. The recipient needs their own internet connection;
                        KYUTXO stays fully offline.
                      </AlertDescription>
                    </Alert>

                    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                      {doneRows.map((r) => (
                        <div
                          key={r.raw}
                          className="flex flex-col items-center gap-2 rounded-md border p-3 text-center"
                          data-testid={`qr-preview-${r.raw}`}
                        >
                          {qrPreviews[r.raw] ? (
                            <img
                              src={qrPreviews[r.raw]}
                              alt={`QR code linking to ${r.raw}`}
                              className="h-32 w-32"
                              data-testid={`qr-image-${r.raw}`}
                            />
                          ) : (
                            <div className="h-32 w-32 flex items-center justify-center text-muted-foreground">
                              <Loader2 className="h-5 w-5 animate-spin" />
                            </div>
                          )}
                          <span className="font-mono text-xs break-all" title={r.raw}>
                            {r.raw.length > 20 ? `${r.raw.slice(0, 10)}…${r.raw.slice(-8)}` : r.raw}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatBTC(r.balanceSats ?? 0)} BTC
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Step 7: AML / Risk Screening */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" />
              Step 7 — AML / Risk Screening
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add an AML / Risk Screening appendix that screens the declared addresses against
              KYUTXO's bundled offline entity list and surfaces self-attestation lines for PEP status,
              source of wealth/funds, and tax residency. Off by default — when off, the PDF is unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-aml" className="text-sm font-medium">
                  Include AML / Risk Screening appendix in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off by default. When on, adds a screening summary, attestation lines, and an
                  honesty disclaimer to the declaration.
                </p>
              </div>
              <Switch
                id="include-aml"
                checked={includeAml}
                onCheckedChange={setIncludeAml}
                data-testid="switch-include-aml"
              />
            </div>

            {includeAml && (
              <>
                <Separator />

                {doneRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one valid address (Step 2) to run screening.
                  </p>
                ) : (
                  <>
                    {/* Screening preview */}
                    <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {isComputingAml ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Running screening…
                          </>
                        ) : amlScreeningResult ? (
                          <>
                            <ShieldAlert className="h-4 w-4" />
                            Screening complete — {amlScreeningResult.screenedCount} address{amlScreeningResult.screenedCount !== 1 ? "es" : ""} checked
                          </>
                        ) : (
                          <>
                            <Shield className="h-4 w-4" />
                            Screening will run when you generate the PDF
                          </>
                        )}
                      </div>

                      {amlScreeningResult && (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <div>{buildEntityListDescription(amlScreeningResult)}</div>
                          {amlScreeningResult.directMatches.length === 0 ? (
                            <div className="text-green-600 dark:text-green-400 font-medium">
                              {AML_PREVIEW_STRINGS.noDirectMatches}
                            </div>
                          ) : (
                            <div className="text-destructive font-medium">
                              {buildPreviewDirectMatchLine(
                                amlScreeningResult.directMatches.length,
                                amlScreeningResult.directMatches.map(m => m.entityName),
                              )}
                            </div>
                          )}
                          {amlScreeningResult.hasGraphData ? (
                            amlScreeningResult.nearestHopDistance === null ? (
                              <div className="text-green-600 dark:text-green-400">
                                {AML_PREVIEW_STRINGS.noProximityMatch}
                              </div>
                            ) : (
                              <div>
                                {buildNearestEntityLine({
                                  nearestHopDistance: amlScreeningResult.nearestHopDistance,
                                  nearestHopEntityName: amlScreeningResult.nearestHopEntityName,
                                  nearestHopCategoryLabel: amlScreeningResult.nearestHopCategoryLabel,
                                })}
                              </div>
                            )
                          ) : (
                            <div className="text-muted-foreground">
                              {AML_PREVIEW_STRINGS.noGraphData}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Attestation inputs */}
                    <div className="space-y-4">
                      <h4 className="text-sm font-semibold">Declarant Self-Attestations</h4>
                      <p className="text-xs text-muted-foreground">
                        These fields are optional but recommended. They appear verbatim in the PDF attestation section.
                        Blank fields are noted as "not provided" in the PDF.
                      </p>

                      <div className="space-y-1">
                        <Label htmlFor="aml-pep-status" className="text-sm">
                          Politically Exposed Person (PEP) status
                        </Label>
                        <Select value={amlPepStatus} onValueChange={(v) => setAmlPepStatus(v as "not-stated" | "yes" | "no")}>
                          <SelectTrigger id="aml-pep-status" data-testid="select-aml-pep-status">
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="not-stated">Not stated</SelectItem>
                            <SelectItem value="no">No — I am not a PEP</SelectItem>
                            <SelectItem value="yes">Yes — I am a PEP</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="aml-source-of-wealth" className="text-sm">
                          Source of Wealth <span className="text-muted-foreground text-xs">(how the declarant accumulated their overall wealth)</span>
                        </Label>
                        <Textarea
                          id="aml-source-of-wealth"
                          placeholder="e.g. Employment income, business ownership, property sale proceeds, inheritance…"
                          className="min-h-[72px] text-sm resize-none"
                          value={amlSourceOfWealth}
                          onChange={(e) => setAmlSourceOfWealth(e.target.value)}
                          data-testid="textarea-aml-source-of-wealth"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="aml-source-of-funds" className="text-sm">
                          Source of Funds <span className="text-muted-foreground text-xs">(where these specific Bitcoin funds came from)</span>
                        </Label>
                        <Textarea
                          id="aml-source-of-funds"
                          placeholder="e.g. Purchased via regulated exchange using salary income, mined since 2015, received as payment for consulting services…"
                          className="min-h-[72px] text-sm resize-none"
                          value={amlSourceOfFunds}
                          onChange={(e) => setAmlSourceOfFunds(e.target.value)}
                          data-testid="textarea-aml-source-of-funds"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <Label htmlFor="aml-tax-jurisdiction" className="text-sm">
                            Tax residency jurisdiction
                          </Label>
                          <Input
                            id="aml-tax-jurisdiction"
                            placeholder="e.g. United Kingdom, Germany, United States"
                            value={amlTaxJurisdiction}
                            onChange={(e) => setAmlTaxJurisdiction(e.target.value)}
                            data-testid="input-aml-tax-jurisdiction"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="aml-tax-statement" className="text-sm">
                            Tax compliance statement <span className="text-muted-foreground text-xs">(optional)</span>
                          </Label>
                          <Input
                            id="aml-tax-statement"
                            placeholder="e.g. All taxes have been duly filed and paid."
                            value={amlTaxStatement}
                            onChange={(e) => setAmlTaxStatement(e.target.value)}
                            data-testid="input-aml-tax-statement"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Live attestation preview — mirrors the PDF section word-for-word */}
                    <div className="space-y-2 rounded-md border bg-muted/40 p-4" data-testid="preview-aml-attestation">
                      <h4 className="text-sm font-semibold">Attestation preview</h4>
                      <p className="text-xs text-muted-foreground">
                        These lines appear verbatim in the PDF's "Declarant Self-Attestations" section and
                        update as you type above.
                      </p>
                      <div className="space-y-1.5 text-xs">
                        {attestationPreviewLines.map((line, i) => (
                          <p key={i} className="leading-relaxed" data-testid={`text-aml-attestation-line-${i}`}>
                            {line}
                          </p>
                        ))}
                      </div>
                    </div>

                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-xs space-y-1">
                        <p className="font-medium">Screening limitations</p>
                        <p>
                          This is a best-effort offline check against a bundled dataset of publicly documented
                          addresses. It is not a substitute for your institution's own KYC/AML procedures or
                          licensed chain-analysis tooling. A "no match" result does not guarantee the funds
                          are risk-free. The PDF clearly states these limitations.
                        </p>
                      </AlertDescription>
                    </Alert>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Step 8: Acquisition & Provenance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Step 8 — Acquisition &amp; Provenance
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add an appendix documenting how the declared addresses acquired their Bitcoin:
              acquisition dates, methods, cost basis, and fiat values at time of acquisition.
              A list of linked supporting documents is included so a reviewer can cross-reference exhibits.
              Data is read from your vault records — nothing is changed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-provenance" className="text-sm font-medium">
                  Include Acquisition &amp; Provenance appendix in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off by default. When on, a per-address provenance table and supporting-documents
                  list are appended as a separate section.
                </p>
              </div>
              <Switch
                id="include-provenance"
                checked={includeProvenance}
                onCheckedChange={setIncludeProvenance}
                data-testid="switch-include-provenance"
              />
            </div>

            {includeProvenance && (
              <>
                <Separator />

                <div className="space-y-2 max-w-xs">
                  <Label htmlFor="provenance-currency" className="text-sm">
                    Fiat currency for cost basis and historical pricing
                  </Label>
                  <Select
                    value={provenanceFiatCurrency}
                    onValueChange={setProvenanceFiatCurrency}
                  >
                    <SelectTrigger id="provenance-currency" data-testid="select-provenance-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD — US Dollar</SelectItem>
                      <SelectItem value="EUR">EUR — Euro</SelectItem>
                      <SelectItem value="GBP">GBP — British Pound</SelectItem>
                      <SelectItem value="CAD">CAD — Canadian Dollar</SelectItem>
                      <SelectItem value="AUD">AUD — Australian Dollar</SelectItem>
                      <SelectItem value="CHF">CHF — Swiss Franc</SelectItem>
                      <SelectItem value="JPY">JPY — Japanese Yen</SelectItem>
                      <SelectItem value="SGD">SGD — Singapore Dollar</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Used for historical price lookups from your vault's stored price data.
                    Addresses with a manually recorded cost basis will show that value in USD
                    regardless of this setting.
                  </p>
                </div>

                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-sm space-y-1">
                    <p>
                      Acquisition data is read from your vault records. Addresses with no vault
                      record, or records with no acquisition metadata, are shown as "Not recorded."
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Historical fiat values are estimates from your vault's stored price data.
                      If no price data exists for an acquisition date, the cost basis will be
                      shown as "Not recorded." Figures are informational only.
                    </p>
                  </AlertDescription>
                </Alert>

                {doneRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one address (Step 2) to include this section.
                  </p>
                ) : (
                  <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm space-y-1">
                    <div className="font-medium">What will be included</div>
                    <ul className="text-muted-foreground space-y-0.5 list-disc list-inside text-xs">
                      <li>
                        Per-address table: date acquired, acquisition method, BTC amount, and cost
                        basis in {provenanceFiatCurrency} (from price history or user-supplied basis)
                      </li>
                      <li>
                        Provenance summary: total BTC, total cost basis
                        {fiatValid && fiatTotal !== null ? ", current value, and unrealized gain/loss" : ""}
                      </li>
                      <li>Supporting documents: file attachments linked to the declared records</li>
                    </ul>
                  </div>
                )}

                {doneRows.length > 0 && (
                  <div className="space-y-2" data-testid="provenance-summary">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <Label className="text-sm font-medium">Provenance details per address</Label>
                      {provenanceIncompleteCount === 0 ? (
                        <Badge variant="secondary" className="text-xs font-normal" data-testid="badge-provenance-complete">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          All recorded
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs font-normal" data-testid="badge-provenance-incomplete">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          {provenanceIncompleteCount} need{provenanceIncompleteCount === 1 ? "s" : ""} attention
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Fields below are read into the appendix. Record them on each address to make
                      the appendix more complete.
                    </p>
                    <div className="rounded-md border divide-y">
                      {provenanceStatus.map((s) => (
                        <div
                          key={s.address}
                          className="flex items-center justify-between gap-3 px-3 py-2 flex-wrap"
                          data-testid={`provenance-row-${s.address}`}
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="font-mono text-xs truncate" title={s.address}>
                              {truncateAddress(s.address)}
                            </div>
                            {!s.hasRecord ? (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <AlertCircle className="h-3 w-3 shrink-0" />
                                No vault record — provenance can't be recorded
                              </div>
                            ) : s.missing.length === 0 ? (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <CheckCircle className="h-3 w-3 shrink-0" />
                                All provenance fields recorded
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="text-xs text-muted-foreground">Missing:</span>
                                {s.missing.map((m) => (
                                  <Badge
                                    key={m}
                                    variant="outline"
                                    className="text-xs font-normal"
                                  >
                                    {m}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                          {s.hasRecord && s.missing.length > 0 && s.recordId !== undefined && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openRecordEdit(s.recordId!, "acquisition")}
                              data-testid={`button-fill-provenance-${s.address}`}
                            >
                              Fill in missing fields
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Step 9: Formal Attestation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5" />
              Step 9 — Formal Attestation
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add a formal attestation block with a solemn declaration statement, a signature line,
              place of signing, and an optional witness or notary line. Off by default — the always-on
              document integrity section (reference ID, content fingerprint, page numbers, blockchain
              time-anchor) is included in every PDF regardless of this toggle.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-attestation" className="text-sm font-medium">
                  Include formal attestation block in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off by default. When on, adds a solemn declaration statement with a signature line,
                  date, place of signing, and an optional witness/notary block.
                </p>
              </div>
              <Switch
                id="include-attestation"
                checked={includeAttestation}
                onCheckedChange={setIncludeAttestation}
                data-testid="switch-include-attestation"
              />
            </div>

            {includeAttestation && (
              <>
                <Separator />
                <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1 text-sm">
                  <div className="font-medium text-sm">Attestation statement (printed verbatim)</div>
                  <p className="text-xs text-muted-foreground italic">
                    "I, [your name], hereby solemnly declare and attest that the foregoing information —
                    including all Bitcoin addresses, reported balances, and supporting details — is true,
                    accurate, and complete to the best of my knowledge and belief. I am the lawful owner
                    or authorised signatory of the declared addresses and the funds associated with them.
                    I understand that knowingly making a false declaration may result in civil and/or
                    criminal liability under applicable law."
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="attestation-place" className="text-sm">
                      Place of signing <span className="text-muted-foreground text-xs">(optional)</span>
                    </Label>
                    <Input
                      id="attestation-place"
                      placeholder="e.g. London, United Kingdom"
                      value={attestationPlaceOfSigning}
                      onChange={(e) => setAttestationPlaceOfSigning(e.target.value)}
                      data-testid="input-attestation-place"
                    />
                    <p className="text-xs text-muted-foreground">
                      If blank, a blank signature line is printed instead.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="attestation-witness" className="text-sm">
                      Witness / Notary line <span className="text-muted-foreground text-xs">(optional)</span>
                    </Label>
                    <Input
                      id="attestation-witness"
                      placeholder="e.g. John Smith, Solicitor, Law Society No. 12345"
                      value={attestationWitnessLine}
                      onChange={(e) => setAttestationWitnessLine(e.target.value)}
                      data-testid="input-attestation-witness"
                    />
                    <p className="text-xs text-muted-foreground">
                      If blank, blank witness/notary signature lines are printed.
                    </p>
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground text-sm">Always included in every PDF (no toggle needed)</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    <li>Page X of Y footer with declaration reference ID on every page</li>
                    <li>Generation metadata: tool name, generation date/time</li>
                    <li>Content fingerprint: SHA-256 of key declaration fields</li>
                    <li>Blockchain time-anchor: block height and timestamp from your balance data</li>
                  </ul>
                </div>
              </>
            )}

            {!includeAttestation && (
              <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1 text-xs text-muted-foreground">
                <p className="font-medium text-foreground text-sm">Always included in every PDF</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Page X of Y footer with declaration reference ID on every page</li>
                  <li>Generation metadata: tool name, generation date/time</li>
                  <li>Content fingerprint: SHA-256 of key declaration fields</li>
                  <li>Blockchain time-anchor: block height and timestamp from your balance data</li>
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 10: Glossary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Step 10 — Glossary
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Append a plain-language glossary of Bitcoin and compliance terms for non-technical reviewers.
              Covers Bitcoin addresses, UTXO, xpub, confirmations, hops, SHA-256, PEP, AML, and more.
              Off by default — when off, the PDF is unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-glossary" className="text-sm font-medium">
                  Include glossary appendix in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off by default. When on, adds a final appendix defining Bitcoin, Address, UTXO, xpub,
                  Confirmation, Hop, SHA-256, PEP, AML, KYC, and other terms used in this document.
                </p>
              </div>
              <Switch
                id="include-glossary"
                checked={includeGlossary}
                onCheckedChange={setIncludeGlossary}
                data-testid="switch-include-glossary"
              />
            </div>

            {includeGlossary && (
              <>
                <Separator />
                <div className="rounded-md border bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground text-sm">Terms covered</p>
                  <p>Bitcoin, Bitcoin Address, Balance, BTC, Satoshi, Blockchain, Block, Confirmation,
                  UTXO, xpub, Proof of Control, Bitcoin Signed Message, BIP-322, Hop, SHA-256,
                  Declaration Reference (Nonce), PEP, AML, KYC</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Step 11: Introduction / Preface */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Step 11 — Introduction / Preface
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add a short plain-language preface to the very top of the PDF: that Bitcoin is a digital
              bearer asset, that the blockchain is a publicly verifiable ledger, and that ownership is
              established through control of the private keys.
              Off by default — when off, the PDF is unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-intro" className="text-sm font-medium">
                  Include introduction / preface in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off by default. When on, adds an Introduction section at the top of the declaration,
                  before the declarant details.
                </p>
              </div>
              <Switch
                id="include-intro"
                checked={includeIntro}
                onCheckedChange={setIncludeIntro}
                data-testid="switch-include-intro"
              />
            </div>

            {includeIntro && (
              <>
                <Separator />
                <div
                  className="rounded-md border bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-2"
                  data-testid="text-intro-preview"
                >
                  <p className="font-medium text-foreground text-sm">Preview</p>
                  {DECLARATION_INTRO_PARAGRAPHS.map((paragraph, i) => (
                    <p key={i}>{paragraph}</p>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Step 12: Supporting Evidence (optional) */}
        <Card>
          <CardHeader>
            <CardTitle>Step 12 — Supporting Evidence (optional)</CardTitle>
            <CardDescription>
              Attach images (screenshots or photos) and PDF documents to support your
              declaration. Images are embedded into the dossier, and PDFs are merged on
              as extra pages at the end. Files stay on your device and are only kept for
              this session — they are never uploaded or saved.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={evidenceInputRef}
              type="file"
              accept={EVIDENCE_ACCEPT}
              multiple
              className="hidden"
              data-testid="input-evidence-file"
              onChange={(e) => handleEvidenceFiles(e.target.files)}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => evidenceInputRef.current?.click()}
                disabled={
                  isAddingEvidence || evidenceItems.length >= EVIDENCE_MAX_ITEMS
                }
                data-testid="button-add-evidence"
              >
                {isAddingEvidence ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding…
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    Add files
                  </>
                )}
              </Button>
              {evidenceItems.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  onClick={clearEvidence}
                  data-testid="button-clear-evidence"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear all
                </Button>
              )}
              <span
                className="text-xs text-muted-foreground"
                data-testid="text-evidence-count"
              >
                {evidenceItems.length === 0
                  ? "No files attached"
                  : `${evidenceItems.length} of ${EVIDENCE_MAX_ITEMS} file${
                      evidenceItems.length !== 1 ? "s" : ""
                    } — ${evidenceImageCount} image${
                      evidenceImageCount !== 1 ? "s" : ""
                    }, ${evidencePdfItems.length} PDF${
                      evidencePdfItems.length !== 1 ? "s" : ""
                    }`}
              </span>
            </div>

            <p className="text-xs text-muted-foreground">
              Accepted: PNG, JPEG, WebP images and PDF documents. Up to{" "}
              {EVIDENCE_MAX_ITEMS} files, {EVIDENCE_MAX_FILE_BYTES / (1024 * 1024)} MB
              each, {EVIDENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB combined.
            </p>

            {evidenceItems.length > 0 && (
              <div className="space-y-2">
                {evidenceItems.map((it) => (
                  <div
                    key={it.id}
                    data-testid={`row-evidence-${it.id}`}
                    className="flex items-start gap-3 rounded-md border p-3"
                  >
                    <div className="shrink-0">
                      {it.kind === "image" && it.dataUrl ? (
                        <img
                          src={it.dataUrl}
                          alt={it.name}
                          className="h-16 w-16 rounded-md object-cover border"
                          data-testid={`img-evidence-${it.id}`}
                        />
                      ) : (
                        <div className="h-16 w-16 rounded-md border flex items-center justify-center bg-muted/40">
                          <FileText className="h-7 w-7 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {it.kind === "image" ? (
                          <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                        <span
                          className="text-sm font-medium truncate"
                          data-testid={`text-evidence-name-${it.id}`}
                        >
                          {it.name}
                        </span>
                        <Badge variant="secondary">
                          {it.kind === "pdf"
                            ? `PDF · ${it.pageCount ?? "?"} page${
                                it.pageCount === 1 ? "" : "s"
                              }`
                            : "Image"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatEvidenceSize(it.size)}
                        </span>
                      </div>
                      <Input
                        value={it.caption}
                        onChange={(e) =>
                          updateEvidenceCaption(it.id, e.target.value)
                        }
                        placeholder="Add a caption (optional)"
                        data-testid={`input-evidence-caption-${it.id}`}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeEvidenceItem(it.id)}
                      aria-label={`Remove ${it.name}`}
                      data-testid={`button-remove-evidence-${it.id}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 13: Generate PDF */}
        <Card>
          <CardHeader>
            <CardTitle>Step 13 — Generate PDF</CardTitle>
            <CardDescription>
              All required steps above must be complete before a PDF can be generated.
              The PDF is created entirely in your browser — no data leaves your device.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Sample PDF section */}
            <div className="rounded-md border border-dashed border-muted-foreground/40 p-4 space-y-2 bg-muted/30">
              <p className="text-sm font-medium">Preview the layout first</p>
              <p className="text-xs text-muted-foreground">
                Generate a specimen PDF filled with obviously-fake placeholder data to approve the layout
                before entering your real identity details. The sample is stamped{" "}
                <span className="font-medium">SAMPLE / NOT A VALID DECLARATION</span> on every page and
                contains no real fingerprint or verifiable signatures.
              </p>
              <Button
                onClick={generateSamplePdf}
                disabled={isGeneratingSamplePdf || isGeneratingPdf}
                data-testid="button-generate-sample-pdf"
                variant="outline"
                size="default"
              >
                {isGeneratingSamplePdf ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating Sample…
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4 mr-2" />
                    Generate Sample PDF
                  </>
                )}
              </Button>
            </div>

            <Separator />

            {!canGeneratePdf && (
              <div className="space-y-1">
                {doneRows.length === 0 && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one valid address (Step 2)
                  </p>
                )}
                {declarantName.trim() === "" && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Enter your full name (Step 3)
                  </p>
                )}
                {declarationDate === "" && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Set the declaration date (Step 3)
                  </p>
                )}
                {purpose.trim() === "" && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Enter the purpose of the declaration (Step 3)
                  </p>
                )}
              </div>
            )}

            <Button
              onClick={generatePdf}
              disabled={!canGeneratePdf || isGeneratingPdf}
              data-testid="button-generate-pdf"
              size="default"
            >
              {isGeneratingPdf ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Generate &amp; Download PDF
                </>
              )}
            </Button>

            {canGeneratePdf && (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>
                  The PDF will include: declarant details, statement, {doneRows.length} address{doneRows.length !== 1 ? "es" : ""} with
                  balances and control status, total ({formatBTC(totalSats)} BTC){fiatValid && fiatTotal !== null ? ", fiat equivalent," : ","} data
                  source attestation, disclaimers, a signature block, and a document integrity section
                  (page numbers, reference ID, content fingerprint, and blockchain time-anchor).
                  {includeIntro && " A plain-language introduction will appear at the very top, before the declarant details."}
                  {includeAttestation && " A formal attestation block will be included."}
                  {includeQr && ` Verification QR codes linking each address to ${getExplorer(qrExplorerId).host} will be included.`}
                  {verifiedCount > 0 && ` An appendix will contain the challenge messages and signatures for ${verifiedCount} verified address${verifiedCount !== 1 ? "es" : ""}.`}
                  {includeProvenance && ` An Acquisition & Provenance appendix will document acquisition dates, methods, and cost basis (in ${provenanceFiatCurrency}) for the declared addresses, plus a list of linked supporting documents.`}
                  {includeAml && " An AML / Risk Screening appendix will include offline entity-list results, indirect proximity analysis, declarant self-attestations, and a screening disclaimer."}
                  {includeGlossary && " A glossary appendix will define key terms for non-technical reviewers."}
                  {evidenceItems.length > 0 && ` ${evidenceItems.length} supporting evidence file${evidenceItems.length !== 1 ? "s" : ""} will be attached: ${evidenceImageCount} image${evidenceImageCount !== 1 ? "s" : ""} embedded in an appendix${evidencePdfItems.length > 0 ? ` and ${evidencePdfItems.length} PDF${evidencePdfItems.length !== 1 ? "s" : ""} merged as extra pages` : ""}.`}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
