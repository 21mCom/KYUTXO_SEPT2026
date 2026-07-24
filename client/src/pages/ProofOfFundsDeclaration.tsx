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
  QrCode as QrCodeIcon,
  Globe,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { mergeEvidencePdfs, type PdfExhibit } from "@/lib/pdfMerge";
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
  generateDeclarationNonce,
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
import { type EvidenceItem } from "./proof-of-funds/evidence-helpers";
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
} from "./proof-of-funds/declaration-prefs";
import { usePofPdfBuilder } from "./proof-of-funds/use-pof-pdf-builder";
import { QrCodesCard } from "./proof-of-funds/qr-codes-card";
import { AmlRiskCard } from "./proof-of-funds/aml-risk-card";
import { ProvenanceCard } from "./proof-of-funds/provenance-card";
import { ProofOfControlCard } from "./proof-of-funds/proof-of-control-card";
import { EvidenceCard } from "./proof-of-funds/evidence-card";
import { AttestationCard, GlossaryCard, IntroCard } from "./proof-of-funds/declaration-toggle-cards";

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

  // Optional add-ons for Step 5 (both off by default) — UI lives in ProofOfControlCard,
  // but the values live here because the PDF builder and the signature-invalidation
  // effect below depend on them.
  const [verifierReference, setVerifierReference] = useState("");
  const [freshnessAnchorEnabled, setFreshnessAnchorEnabled] = useState(false);
  const [freshnessAnchor, setFreshnessAnchor] = useState<FreshnessAnchor | null>(null);

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
  };


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
        <ProofOfControlCard
          doneRows={doneRows}
          declarantInfoComplete={declarantInfoComplete}
          declarantName={declarantName}
          declarationDate={declarationDate}
          purpose={purpose}
          declarationNonce={declarationNonce}
          verifiedCount={verifiedCount}
          controlStates={controlStates}
          setControlStates={setControlStates}
          verifierReference={verifierReference}
          setVerifierReference={setVerifierReference}
          freshnessAnchorEnabled={freshnessAnchorEnabled}
          setFreshnessAnchorEnabled={setFreshnessAnchorEnabled}
          freshnessAnchor={freshnessAnchor}
          setFreshnessAnchor={setFreshnessAnchor}
        />


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
        <AttestationCard
          includeAttestation={includeAttestation}
          setIncludeAttestation={setIncludeAttestation}
          attestationPlaceOfSigning={attestationPlaceOfSigning}
          setAttestationPlaceOfSigning={setAttestationPlaceOfSigning}
          attestationWitnessLine={attestationWitnessLine}
          setAttestationWitnessLine={setAttestationWitnessLine}
        />

        {/* Step 10: Glossary */}
        <GlossaryCard includeGlossary={includeGlossary} setIncludeGlossary={setIncludeGlossary} />

        {/* Step 11: Introduction / Preface */}
        <IntroCard includeIntro={includeIntro} setIncludeIntro={setIncludeIntro} />

        {/* Step 12: Supporting Evidence (optional) */}
        <EvidenceCard
          evidenceItems={evidenceItems}
          setEvidenceItems={setEvidenceItems}
          evidenceImageCount={evidenceImageCount}
          evidencePdfCount={evidencePdfItems.length}
        />

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
