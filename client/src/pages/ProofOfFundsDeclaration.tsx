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
import { runAmlScreening, type AmlDirectMatch, type AmlScreeningResult } from "./proof-of-funds/aml-screening";
export { runAmlScreening } from "./proof-of-funds/aml-screening";
import {
  type BalanceSource,
  type RowStatus,
  type ControlStatus,
  type AddressRow,
  type ControlState,
  type BalanceSummary,
  parseAddressInput,
  formatUnix,
  todayString,
} from "./proof-of-funds/address-helpers";
import {
  type EvidenceKind,
  type EvidenceItem,
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_FILE_BYTES,
  EVIDENCE_MAX_TOTAL_BYTES,
  EVIDENCE_ACCEPT,
  EVIDENCE_IMAGE_MIMES,
  nextEvidenceId,
  hashBytesHex,
  imageBytesToDataUrl,
  formatEvidenceSize,
} from "./proof-of-funds/evidence-helpers";
import {
  type ExplorerId,
  type ExplorerDef,
  QR_EXPLORERS,
  getExplorer,
} from "./proof-of-funds/explorer-helpers";
import {
  KYUTXO_APP_VERSION,
  type DeclarationPrefs,
  DEFAULT_DECLARATION_PREFS,
  loadDeclarationPrefs,
  saveDeclarationPrefs,
  DECLARATION_INTRO_PARAGRAPHS,
} from "./proof-of-funds/declaration-prefs";
import { usePofPdfBuilder } from "./proof-of-funds/use-pof-pdf-builder";
import { QrCodesCard } from "./proof-of-funds/qr-codes-card";
import { AmlRiskCard } from "./proof-of-funds/aml-risk-card";
import { ProvenanceCard } from "./proof-of-funds/provenance-card";

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

  // ── PDF generation ──────────────────────────────────────────────────────────
  // Extracted to a dedicated hook; all PDF state lives there.
  const { generatePdf, generateSamplePdf, isGeneratingPdf, isGeneratingSamplePdf } = usePofPdfBuilder({
    declarantName,
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
    evidenceItems,
    includeProvenance,
    provenanceFiatCurrency,
    includeQr,
    qrExplorerId,
    qrPreviews,
    includeAml,
    amlPepStatus,
    amlTaxJurisdiction,
    amlSourceOfWealth,
    amlSourceOfFunds,
    amlTaxStatement,
    amlScreeningResult,
    includeIntro,
    includeAttestation,
    attestationPlaceOfSigning,
    attestationWitnessLine,
    includeGlossary,
    verifierReference,
    freshnessAnchorEnabled,
    freshnessAnchor,
  });
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
        <QrCodesCard
          includeQr={includeQr}
          setIncludeQr={setIncludeQr}
          doneRows={doneRows}
          qrExplorerId={qrExplorerId}
          setQrExplorerId={setQrExplorerId}
          qrPreviews={qrPreviews}
        />

        {/* Step 7: AML / Risk Screening */}
        <AmlRiskCard
          includeAml={includeAml}
          setIncludeAml={setIncludeAml}
          doneRows={doneRows}
          isComputingAml={isComputingAml}
          amlScreeningResult={amlScreeningResult}
          amlPepStatus={amlPepStatus}
          setAmlPepStatus={setAmlPepStatus}
          amlSourceOfWealth={amlSourceOfWealth}
          setAmlSourceOfWealth={setAmlSourceOfWealth}
          amlSourceOfFunds={amlSourceOfFunds}
          setAmlSourceOfFunds={setAmlSourceOfFunds}
          amlTaxJurisdiction={amlTaxJurisdiction}
          setAmlTaxJurisdiction={setAmlTaxJurisdiction}
          amlTaxStatement={amlTaxStatement}
          setAmlTaxStatement={setAmlTaxStatement}
          attestationPreviewLines={attestationPreviewLines}
        />

        {/* Step 8: Acquisition & Provenance */}
        <ProvenanceCard
          includeProvenance={includeProvenance}
          setIncludeProvenance={setIncludeProvenance}
          provenanceFiatCurrency={provenanceFiatCurrency}
          setProvenanceFiatCurrency={setProvenanceFiatCurrency}
          provenanceStatus={provenanceStatus}
          provenanceIncompleteCount={provenanceIncompleteCount}
          doneRows={doneRows}
          fiatValid={fiatValid}
          fiatTotal={fiatTotal}
          openRecordEdit={openRecordEdit}
        />

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
