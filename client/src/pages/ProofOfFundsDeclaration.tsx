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
  Copy,
  ClipboardCheck,
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { validateAddress, formatBTC } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { computeStatsForAddresses } from "@/lib/data/address-stats";
import { getRecordsByType } from "@/lib/data/record-crud";
import { useToast } from "@/hooks/use-toast";
import {
  buildChallengeMessage,
  verifyBitcoinSignature,
  generateDeclarationNonce,
  signatureFormatLabel,
  type SignatureFormat,
} from "@/lib/signatureVerify";

type BalanceSource = "live" | "offline";
type RowStatus = "pending" | "loading" | "done" | "error";
type ControlStatus = "idle" | "verifying" | "verified" | "failed";

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

export default function ProofOfFundsDeclaration() {
  const { nodeSettings } = useNodeSettings();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { toast } = useToast();

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

  // When declarant identity fields change, any previously-verified signatures
  // are no longer valid (the challenge message they signed has changed).
  const prevDeclarantRef = useRef({ name: declarantName, date: declarationDate, purpose });
  useEffect(() => {
    const prev = prevDeclarantRef.current;
    if (
      prev.name !== declarantName ||
      prev.date !== declarationDate ||
      prev.purpose !== purpose
    ) {
      prevDeclarantRef.current = { name: declarantName, date: declarationDate, purpose };
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
  }, [declarantName, declarationDate, purpose]);

  // Fiat
  const [fiatCurrency, setFiatCurrency] = useState("USD");
  const [fiatRate, setFiatRate] = useState("");

  // Balance-verification QR codes (optional)
  const [includeQr, setIncludeQr] = useState(false);
  const [qrExplorerId, setQrExplorerId] = useState<ExplorerId>("mempool");
  // address -> generated QR data URL for the on-screen preview
  const [qrPreviews, setQrPreviews] = useState<Record<string, string>>({});

  // PDF generating
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  // Expanded invalid section
  const [showInvalid, setShowInvalid] = useState(false);

  const validRows = useMemo(() => rows.filter((r) => !r.isInvalid), [rows]);
  const invalidRows = useMemo(() => rows.filter((r) => r.isInvalid), [rows]);
  const doneRows = useMemo(() => validRows.filter((r) => r.status === "done"), [validRows]);
  const errorRows = useMemo(() => validRows.filter((r) => r.status === "error"), [validRows]);
  const hasResults = rows.length > 0;

  const fiatRateNum = parseFloat(fiatRate);
  const fiatValid = fiatRate.trim() !== "" && !isNaN(fiatRateNum) && fiatRateNum > 0;

  const totalSats = useMemo(
    () => doneRows.reduce((sum, r) => sum + (r.balanceSats ?? 0), 0),
    [doneRows]
  );

  const fiatTotal = fiatValid && summary ? (totalSats / 1e8) * fiatRateNum : null;

  // Proof-of-control summary counts
  const verifiedCount = useMemo(
    () => doneRows.filter((r) => controlStates[r.raw]?.status === "verified").length,
    [doneRows, controlStates]
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
          err instanceof Error ? err.message : "Failed to create provider. Check Node Connection settings.";
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

      for (const { i } of validIndices) {
        if (cancelledRef.current) break;
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "loading" } : r)));
        const address = parsed[i].raw;
        try {
          let balanceSats: number;
          if (provider.getAddressCoreStats) {
            const info = await provider.getAddressCoreStats(address);
            balanceSats = info.balanceSats ?? 0;
          } else if (provider.getAddressInfo) {
            const info = await provider.getAddressInfo(address);
            balanceSats = info.balanceSats ?? 0;
          } else {
            const { computeHistoryFromTxs } = await import("@/lib/providers/address-history");
            const txs = await provider.getAddressTransactions(address);
            const history = computeHistoryFromTxs(address, txs);
            balanceSats = (history.receivedSats ?? 0) - (history.sentSats ?? 0);
          }
          setRows((prev) =>
            prev.map((r, idx) => (idx === i ? { ...r, status: "done", balanceSats } : r))
          );
        } catch (err) {
          if (cancelledRef.current) break;
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
            if (stats) {
              return { ...r, status: "done", balanceSats: stats.balanceSats };
            } else {
              return { ...r, status: "done", balanceSats: 0 };
            }
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

  // Per-address: copy the challenge message to clipboard
  const handleCopyChallenge = useCallback(
    (address: string) => {
      const msg = buildChallengeMessage({
        address,
        declarantName,
        declarationDate,
        purpose,
        nonce: declarationNonce,
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
    [declarantName, declarationDate, purpose, declarationNonce]
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
    [controlStates, declarantName, declarationDate, purpose, declarationNonce]
  );

  // PDF generation
  const generatePdf = useCallback(async () => {
    if (!canGeneratePdf) return;
    setIsGeneratingPdf(true);
    try {
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
        doc.text(sanitizePdfText(text), margin, y);
        y += size * 0.5;
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

      // Gather verified addresses for later appendix
      const verifiedRows = doneRows.filter((r) => controlStates[r.raw]?.status === "verified");
      const hasVerified = verifiedRows.length > 0;
      const allVerified = doneRows.length > 0 && verifiedRows.length === doneRows.length;

      // ── Title ──────────────────────────────────────────────────────────────
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("PROOF OF FUNDS DECLARATION", margin, y);
      y += 10;

      doc.setLineWidth(0.5);
      doc.line(margin, y, margin + contentW, y);
      y += 5;

      // ── Declarant Details ──────────────────────────────────────────────────
      addLine("DECLARANT DETAILS", 11, true);
      addSpacer(2);
      addLine(`Full Name: ${declarantName}`, 10);
      addSpacer(1);
      if (declarantContact.trim()) {
        addLine(`Contact / Address: ${declarantContact}`, 10);
        addSpacer(1);
      }
      addLine(`Declaration Date: ${declarationDate}`, 10);
      addSpacer(1);
      addLine(`Purpose: ${purpose}`, 10);
      addSpacer(1);
      addLine(`Declaration Reference: ${declarationNonce}`, 10);
      addSpacer(4);

      // ── Statement ──────────────────────────────────────────────────────────
      if (statement.trim()) {
        addLine("DECLARATION STATEMENT", 11, true);
        addSpacer(2);
        addWrapped(statement);
        addSpacer(4);
      }

      // ── Data Source Attestation ────────────────────────────────────────────
      addLine("DATA SOURCE ATTESTATION", 11, true);
      addSpacer(2);
      if (summary) {
        addWrapped(summary.asOfLabel);
      }
      addSpacer(4);

      // ── Address Balances Table ─────────────────────────────────────────────
      addLine("BITCOIN ADDRESS BALANCES", 11, true);
      addSpacer(2);

      const tableStartY = y;
      const tableBody = doneRows.map((r) => {
        const cs = controlStates[r.raw];
        const ctrlLabel = cs?.status === "verified" ? "Control Verified" : "Self-Declared (Unverified)";
        return [
          sanitizePdfText(r.raw),
          `${formatBTC(r.balanceSats ?? 0)} BTC`,
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
            const row = doneRows[data.row.index];
            if (row && controlStates[row.raw]?.status === "verified") {
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
      doc.text(`TOTAL: ${formatBTC(totalSats)} BTC`, margin, y);
      y += 5;

      if (fiatValid && fiatTotal !== null) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(0, 0, 0);
        const fiatLine = `Fiat equivalent: ${fiatTotal.toLocaleString("en-US", {
          style: "currency",
          currency: fiatCurrency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} (at ${sanitizePdfText(fiatCurrency)} ${sanitizePdfText(fiatRateNum.toLocaleString("en-US", { maximumFractionDigits: 2 }))} per BTC)`;
        doc.text(sanitizePdfText(fiatLine), margin, y);
        y += 4;
        doc.setTextColor(120, 80, 0);
        doc.text(
          sanitizePdfText(
            "DISCLAIMER: Exchange rate supplied by declarant. This is not a market quote or financial advice."
          ),
          margin,
          y
        );
        doc.setTextColor(0, 0, 0);
        y += 5;
      }

      addSpacer(4);

      // ── Balance-Verification QR Codes ──────────────────────────────────────
      if (includeQr && doneRows.length > 0) {
        const qrExplorer = getExplorer(qrExplorerId);

        // Pre-generate every QR code offline (data: URLs, no network).
        const qrMap = new Map<string, string>();
        for (const r of doneRows) {
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

        for (const r of doneRows) {
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
          doc.text(sanitizePdfText(`Balance: ${formatBTC(r.balanceSats ?? 0)} BTC`), textX, ty);
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

      // ── Standard Disclaimers ───────────────────────────────────────────────
      checkPageBreak(50);
      addLine("DISCLAIMERS", 11, true);
      addSpacer(2);

      const verifiedFormats = new Set(
        verifiedRows
          .map((r) => controlStates[r.raw]?.verifiedFormat)
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
        ? `2. Cryptographic proof-of-control is included for ${verifiedRows.length} of ${doneRows.length} address${doneRows.length !== 1 ? "es" : ""} via ${formatPhrase}. The remaining addresses are self-declared. An appendix contains the challenge messages and signatures for verified addresses.`
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
      doc.text(`Date: ${sanitizePdfText(declarationDate)}`, margin, y);
      y += 6;
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text(
        sanitizePdfText(
          `Generated by KYUTXO on ${new Date().toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}`
        ),
        margin,
        y
      );

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
        const formatLines = doc.splitTextToSize(
          sanitizePdfText(
            `The Challenge Message is the human-readable text that was signed for each address. It records the declarant, purpose, date, a unique Declaration Reference (nonce: ${declarationNonce}), and the address itself. ` +
            "The Declaration Reference is a random value generated specifically for this declaration; because it is embedded in every signed message, the signatures cannot be silently reused for a different declaration. " +
            "When verifying, the message must be supplied exactly as shown — every character and line break is part of what was signed, so changing even one character will cause verification to fail."
          ),
          contentW
        ) as string[];
        doc.text(formatLines, margin, y);
        y += formatLines.length * 8.5 * 0.45 + 6;

        for (const row of verifiedRows) {
          checkPageBreak(60);
          const cs = controlStates[row.raw]!;

          doc.setFontSize(9);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(0, 0, 0);
          doc.text(sanitizePdfText(`Address: ${row.raw}`), margin, y);
          y += 5;

          doc.setFontSize(8);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(80, 80, 80);
          doc.text(
            sanitizePdfText(
              `Signature Format: ${signatureFormatLabel(cs.verifiedFormat ?? "legacy")}`
            ),
            margin,
            y
          );
          doc.setTextColor(0, 0, 0);
          y += 5;

          const challengeMsg = buildChallengeMessage({
            address: row.raw,
            declarantName,
            declarationDate,
            purpose,
            nonce: declarationNonce,
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
            cs.verifiedFormat === "bip322"
              ? "BIP-322 Witness (base64):"
              : "Wallet Signature (base64):",
            margin,
            y
          );
          y += 4;

          doc.setFont("courier", "normal");
          doc.setFontSize(7.5);
          const sigLines = doc.splitTextToSize(sanitizePdfText(cs.verifiedSig ?? ""), contentW - 4) as string[];
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

      const safeName = sanitizePdfText(declarantName.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, ""));
      doc.save(`proof-of-funds-${safeName || "declaration"}-${declarationDate}.pdf`);

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
  }, [
    canGeneratePdf,
    declarantName,
    declarantContact,
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
  ]);

  const validCount = validRows.length;
  const doneCount = doneRows.length + errorRows.length;

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
                <AlertDescription>{providerError}</AlertDescription>
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

              {validRows.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Address</TableHead>
                      <TableHead className="text-right">Balance (BTC)</TableHead>
                      <TableHead className="w-28">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validRows.map((row, idx) => (
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
                      BIP-322 (Simple) — for Taproot (bc1p…) addresses. Paste the base64
                      signature produced by a BIP-322 capable wallet such as Bitcoin Core 24+
                      or Sparrow.
                    </p>
                  </AlertDescription>
                </Alert>

                {verifiedCount > 0 && (
                  <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                    <ShieldCheck className="h-4 w-4" />
                    {verifiedCount} of {doneRows.length} address{doneRows.length !== 1 ? "es" : ""} control-verified
                  </div>
                )}

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
                              Declarant details changed — re-verify your signature. The challenge
                              message now embeds the updated name, date, or purpose, so the previous
                              signature no longer matches.
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

        {/* Step 7: Generate PDF */}
        <Card>
          <CardHeader>
            <CardTitle>Step 7 — Generate PDF</CardTitle>
            <CardDescription>
              All required steps above must be complete before a PDF can be generated.
              The PDF is created entirely in your browser — no data leaves your device.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                  source attestation, disclaimers, and a signature block.
                  {includeQr && ` It will also include verification QR codes linking each address to ${getExplorer(qrExplorerId).host}.`}
                  {verifiedCount > 0 && ` An appendix will contain the challenge messages and signatures for ${verifiedCount} verified address${verifiedCount !== 1 ? "es" : ""}.`}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
