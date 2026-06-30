import { useState, useRef, useCallback, useMemo } from "react";
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
} from "lucide-react";
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
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { validateAddress, formatBTC } from "@/lib/bitcoin";
import { sanitizePdfText } from "@/lib/pdfText";
import { computeStatsForAddresses } from "@/lib/data/address-stats";
import { getRecordsByType } from "@/lib/data/record-crud";
import { useToast } from "@/hooks/use-toast";

type BalanceSource = "live" | "offline";
type RowStatus = "pending" | "loading" | "done" | "error";

interface AddressRow {
  raw: string;
  isInvalid: boolean;
  invalidReason?: string;
  status: RowStatus;
  balanceSats?: number;
  error?: string;
  lastSyncTime?: number;
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

  // Fiat
  const [fiatCurrency, setFiatCurrency] = useState("USD");
  const [fiatRate, setFiatRate] = useState("");

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
            // Fallback: get all txs and derive balance
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
          totalSats: 0, // recalculated from rows
          source: "live",
          asOfLabel,
          blockHeight,
          timestamp: nowTs,
        });
      }
    } else {
      // Offline mode: compute from vault data
      const validAddresses = validIndices.map(({ r }) => r.raw);
      // Mark all as loading
      setRows((prev) =>
        prev.map((r) => (!r.isInvalid ? { ...r, status: "loading" } : r))
      );

      try {
        const statsMap = await computeStatsForAddresses(validAddresses);

        // Get last sync time from records
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
  };

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

      const addWrapped = (text: string, size = 9) => {
        doc.setFontSize(size);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0, 0, 0);
        const lines = doc.splitTextToSize(sanitizePdfText(text), contentW) as string[];
        doc.text(lines, margin, y);
        y += lines.length * size * 0.45 + 2;
      };

      const addSpacer = (h = 4) => { y += h; };

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
      const tableBody = doneRows.map((r) => [
        sanitizePdfText(r.raw),
        `${formatBTC(r.balanceSats ?? 0)} BTC`,
      ]);

      autoTable(doc, {
        startY: tableStartY,
        head: [["Bitcoin Address", "Balance (BTC)"]],
        body: tableBody,
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, font: "helvetica", cellPadding: 2 },
        headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255], fontStyle: "bold" },
        columnStyles: {
          0: { cellWidth: contentW * 0.68, font: "courier" },
          1: { cellWidth: contentW * 0.32, halign: "right" },
        },
        didDrawPage: () => { /* allow page breaks */ },
      });

      y = (doc as any).lastAutoTable.finalY + 6;

      // ── Totals ─────────────────────────────────────────────────────────────
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text(`TOTAL: ${formatBTC(totalSats)} BTC`, margin, y);
      y += 5;

      if (fiatValid && fiatTotal !== null) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
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

      // ── Standard Disclaimers ───────────────────────────────────────────────
      addLine("DISCLAIMERS", 11, true);
      addSpacer(2);
      const disclaimers = [
        "1. This is a self-declaration. The declarant personally attests to ownership of the above Bitcoin addresses.",
        "2. No cryptographic proof-of-control (signed message / BIP-322) is included in this version of the declaration.",
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
      addLine("SIGNATURE", 11, true);
      addSpacer(4);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
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
    purpose,
    statement,
    summary,
    doneRows,
    totalSats,
    fiatValid,
    fiatTotal,
    fiatCurrency,
    fiatRateNum,
    toast,
  ]);

  const validCount = validRows.length;
  const doneCount = doneRows.length + errorRows.length;

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

              {/* Valid address table */}
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
                            : row.status === "error"
                            ? <span className="text-muted-foreground">—</span>
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

              {/* Total */}
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

              {/* Invalid addresses */}
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

        {/* Step 5: Generate PDF */}
        <Card>
          <CardHeader>
            <CardTitle>Step 5 — Generate PDF</CardTitle>
            <CardDescription>
              All steps above must be complete before a PDF can be generated.
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
                <p>The PDF will include: declarant details, statement, {doneRows.length} address{doneRows.length !== 1 ? "es" : ""} with balances, total ({formatBTC(totalSats)} BTC){fiatValid && fiatTotal !== null ? `, fiat equivalent, ` : ", "}data source attestation, disclaimers, and a signature block.</p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
