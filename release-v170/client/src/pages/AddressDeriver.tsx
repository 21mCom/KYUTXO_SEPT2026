import { useState } from "react";
import { KeyRound, Loader2, AlertCircle, Copy, Check, Download, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { downloadBlob } from "@/lib/backup/sink";
import {
  analyzeDeriverInput,
  deriveDeriverAddresses,
  deriverRowsToCsv,
  addressDeriverCsvFilename,
  ADDRESS_DERIVER_MAX_COUNT,
  type DeriverInputAnalysis,
  type DerivedAddressRow,
} from "@/lib/address-deriver";

const KIND_LABELS: Record<string, string> = {
  "extended-key": "Extended public key",
  "single-sig-descriptor": "Single-sig descriptor",
  "taproot-descriptor": "Taproot descriptor",
  "multisig-descriptor": "Multisig descriptor",
};

const CHAIN_LABELS: Record<string, string> = {
  "dual-chain": "Receive + change chains",
  "receive-only": "Receive chain only",
  "change-only": "Change chain only",
};

function DetectedInputSummary({ analysis }: { analysis: DeriverInputAnalysis }) {
  return (
    <div
      className="flex items-center gap-2 flex-wrap text-sm"
      data-testid="detected-input-summary"
    >
      <span className="text-muted-foreground">Detected:</span>
      <Badge variant="secondary">{KIND_LABELS[analysis.kind || ""] || analysis.kind}</Badge>
      {analysis.source && (
        <Badge variant="outline" data-testid="badge-source">
          {analysis.source === "bsms" ? "From BSMS file" : "From Sparrow export"}
        </Badge>
      )}
      {analysis.walletLabel && (
        <span className="text-xs text-muted-foreground" data-testid="text-wallet-label">
          {analysis.walletLabel}
        </span>
      )}
      <Badge variant="outline" data-testid="badge-network">
        {analysis.network === "testnet" ? "Testnet" : "Mainnet"}
      </Badge>
      {analysis.scriptTypeLabel && (
        <Badge variant="outline" data-testid="badge-script-type">
          {analysis.scriptTypeLabel}
        </Badge>
      )}
      {analysis.chainType && (
        <Badge variant="outline">{CHAIN_LABELS[analysis.chainType] || analysis.chainType}</Badge>
      )}
      {analysis.note && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Info className="h-3 w-3" />
          {analysis.note}
        </span>
      )}
    </div>
  );
}

export default function AddressDeriver() {
  const { toast } = useToast();
  const { copy, isCopied } = useCopyToClipboard();
  const [pastedText, setPastedText] = useState("");
  const [countText, setCountText] = useState("20");
  const [includeChange, setIncludeChange] = useState(false);
  const [analysis, setAnalysis] = useState<DeriverInputAnalysis | null>(null);
  const [rows, setRows] = useState<DerivedAddressRow[]>([]);
  const [isDeriving, setIsDeriving] = useState(false);
  const [deriveError, setDeriveError] = useState<string | null>(null);

  const handleDerive = async () => {
    const result = analyzeDeriverInput(pastedText);
    setAnalysis(result);
    setDeriveError(null);
    setRows([]);

    if (!result.ok) {
      setDeriveError(result.error || "Could not recognize this input.");
      return;
    }

    const count = parseInt(countText, 10);
    setIsDeriving(true);
    try {
      const derived = await deriveDeriverAddresses(result, count, includeChange);
      setRows(derived);
      if (derived.length === 0) {
        setDeriveError("No addresses were derived for the selected chains.");
      }
    } catch (error) {
      setDeriveError(error instanceof Error ? error.message : "Address derivation failed.");
    } finally {
      setIsDeriving(false);
    }
  };

  const handleCopyAll = () => {
    copy(rows.map(r => r.address).join("\n"), {
      label: `${rows.length} address${rows.length === 1 ? "" : "es"}`,
      key: "copy-all",
    });
  };

  const handleDownloadCsv = () => {
    try {
      const csv = deriverRowsToCsv(rows);
      const blob = new Blob([csv], { type: "text/csv" });
      downloadBlob(blob, addressDeriverCsvFilename(analysis!, rows.length));
      toast({ description: `CSV with ${rows.length} addresses downloaded` });
    } catch (error) {
      toast({
        title: "CSV export failed",
        description: error instanceof Error ? error.message : "Could not build the CSV file.",
        variant: "destructive",
      });
    }
  };

  const hasResults = rows.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <KeyRound className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Address Deriver</h1>
            <p className="text-muted-foreground">
              Derive addresses from an extended public key or descriptor — nothing is saved to your vault
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Key or Descriptor</CardTitle>
            <CardDescription>
              Paste an xpub/ypub/zpub/tpub/upub/vpub, a wallet descriptor (wpkh, pkh, sh(wpkh), tr,
              wsh/sh(wsh) multisig), the contents of a BSMS file, or a Sparrow JSON export.
              Derivation happens entirely on this device.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              placeholder={"zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs\nwpkh([73c5da0a/84'/0'/0']zpub.../<0;1>/*)\nwsh(sortedmulti(2,[fp/48'/0'/0'/2']xpub.../0/*,...))"}
              className="min-h-[120px] font-mono text-sm"
              value={pastedText}
              onChange={e => setPastedText(e.target.value)}
              disabled={isDeriving}
              data-testid="textarea-key-input"
            />

            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <Label htmlFor="address-count">Addresses per chain</Label>
                <Input
                  id="address-count"
                  type="number"
                  min={1}
                  max={ADDRESS_DERIVER_MAX_COUNT}
                  className="w-24"
                  value={countText}
                  onChange={e => setCountText(e.target.value)}
                  disabled={isDeriving}
                  data-testid="input-address-count"
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="include-change"
                  checked={includeChange}
                  onCheckedChange={checked => setIncludeChange(checked === true)}
                  disabled={isDeriving}
                  data-testid="checkbox-include-change"
                />
                <Label htmlFor="include-change">Also derive change addresses</Label>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={handleDerive}
                disabled={!pastedText.trim() || isDeriving}
                data-testid="button-derive"
              >
                {isDeriving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Deriving…
                  </>
                ) : (
                  <>
                    <KeyRound className="h-4 w-4 mr-2" />
                    Derive Addresses
                  </>
                )}
              </Button>
            </div>

            {analysis?.ok && <DetectedInputSummary analysis={analysis} />}

            {deriveError && (
              <Alert variant="destructive" data-testid="alert-derive-error">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{deriveError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {hasResults && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle>Derived Addresses</CardTitle>
                  <CardDescription data-testid="text-result-count">
                    {rows.length} address{rows.length === 1 ? "" : "es"} derived — leaving or
                    reloading this page discards them.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleCopyAll} data-testid="button-copy-all">
                    {isCopied("copy-all") ? (
                      <Check className="h-4 w-4 mr-2 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 mr-2" />
                    )}
                    Copy all
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleDownloadCsv} data-testid="button-download-csv">
                    <Download className="h-4 w-4 mr-2" />
                    Download CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div
                className="max-h-[480px] overflow-y-auto rounded-md border divide-y"
                data-testid="list-derived-addresses"
              >
                {rows.map((row, i) => (
                  <div
                    key={`${row.chain}-${row.index}-${row.address}`}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                    data-testid={`row-derived-${i}`}
                  >
                    <span className="w-8 text-right text-muted-foreground tabular-nums">
                      {row.index}
                    </span>
                    <span className="font-mono text-xs flex-1 break-all" title={row.address}>
                      {row.address}
                    </span>
                    <Badge variant={row.chain === "receive" ? "secondary" : "outline"}>
                      {row.chain}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground hidden md:inline">
                      {row.path}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
