import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { AlertCircle, Check, Copy, Download, Loader2, Save } from "lucide-react";
import {
  buildUnsignedPsbt,
  estimateTxVbytes,
  DUST_LIMIT_SATS,
  MIN_FEE_RATE_SATS_PER_VB,
  type PsbtBuildResult,
  type PsbtInputSpec,
} from "@/lib/psbt";
import {
  detectInputScriptType,
  resolveInputDerivation,
  suggestFreshChangeAddress,
  listChangeWalletOptions,
  type ChangeWalletOption,
} from "@/lib/psbt-metadata";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAllDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { savePsbt } from "@/lib/data/saved-psbts-crud";
import { downloadBlob } from "@/lib/backup/sink";
import { validateAddress } from "@/lib/bitcoin";
import type { UTXO } from "@/pages/UTXOs";
import type { Record as DbRecord } from "@/lib/database";

const DEFAULT_FEE_RATE = "5";

function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function filenameSafe(name: string): string {
  const cleaned = name.trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return cleaned || "unsigned-psbt";
}

export interface BuildPsbtDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Snapshot of the UTXOs selected on the UTXOs page. */
  utxos: UTXO[];
  /** Look up the address record for a UTXO's address (drives script-type and derivation metadata). */
  recordForAddress: (address: string) => DbRecord | undefined;
  onSaved?: () => void;
}

export function BuildPsbtDialog({ open, onOpenChange, utxos, recordForAddress, onSaved }: BuildPsbtDialogProps) {
  const { toast } = useToast();
  const { copy, isCopied } = useCopyToClipboard();

  const [preparing, setPreparing] = useState(false);
  const [inputSpecs, setInputSpecs] = useState<PsbtInputSpec[]>([]);
  const [destination, setDestination] = useState("");
  const [feeRate, setFeeRate] = useState(DEFAULT_FEE_RATE);
  const [sendMax, setSendMax] = useState(true);
  const [amountSats, setAmountSats] = useState("");
  const [changeAddress, setChangeAddress] = useState("");
  const [suggestedChange, setSuggestedChange] = useState<string | undefined>(undefined);
  const [selectedRecords, setSelectedRecords] = useState<Array<DbRecord | undefined>>([]);
  const [changeWalletOptions, setChangeWalletOptions] = useState<ChangeWalletOption[]>([]);
  const [changeWalletXpub, setChangeWalletXpub] = useState<string>("");
  const [suggestingChange, setSuggestingChange] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const totalSats = useMemo(() => utxos.reduce((sum, u) => sum + u.amountSats, 0), [utxos]);

  // Resolve input metadata (script types, BIP-32 derivation) and a suggested
  // fresh change address each time the dialog opens with a new selection.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setDestination("");
    setFeeRate(DEFAULT_FEE_RATE);
    setSendMax(true);
    setAmountSats("");
    setChangeAddress("");
    setSuggestedChange(undefined);
    setSelectedRecords([]);
    setChangeWalletOptions([]);
    setChangeWalletXpub("");
    setName(`PSBT ${format(new Date(), "yyyy-MM-dd HH:mm")}`);
    setInputSpecs([]);
    setPreparing(true);

    (async () => {
      try {
        const templates = await getAllDerivationTemplates();
        const records = utxos.map((u) => recordForAddress(u.address));
        const specs: PsbtInputSpec[] = utxos.map((u, i) => {
          const record = records[i];
          const scriptType = detectInputScriptType(u.address, record);
          const derivation = record
            ? resolveInputDerivation(record, scriptType, templates)
            : undefined;
          return {
            txid: u.txid,
            vout: u.vout,
            address: u.address,
            amountSats: u.amountSats,
            scriptType,
            derivation,
          };
        });
        const suggestion = await suggestFreshChangeAddress(records);
        if (cancelled) return;
        setInputSpecs(specs);
        setSelectedRecords(records);
        setChangeWalletOptions(suggestion ? [] : listChangeWalletOptions(records));
        setSuggestedChange(suggestion);
        if (suggestion) setChangeAddress(suggestion);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to prepare PSBT inputs:", error);
          setInputSpecs(
            utxos.map((u) => ({
              txid: u.txid,
              vout: u.vout,
              address: u.address,
              amountSats: u.amountSats,
              scriptType: detectInputScriptType(u.address, recordForAddress(u.address)),
            })),
          );
        }
      } finally {
        if (!cancelled) setPreparing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, utxos]);

  // Live build preview: fee, change, warnings — or the first validation error.
  const preview = useMemo((): { result?: PsbtBuildResult; error?: string } | null => {
    if (!open || preparing || inputSpecs.length === 0) return null;
    if (!destination.trim()) return null;

    const rate = parseFloat(feeRate);
    const destNetwork = validateAddress(destination.trim()).network ?? "mainnet";

    try {
      let send: number;
      let change: string | undefined;
      if (sendMax) {
        change = undefined;
        // Send-max: no change output, so estimate with destination only and
        // sweep everything else.
        const vbytes = estimateTxVbytes(inputSpecs, [validateAddress(destination.trim()).addressType ?? "Unknown"]);
        if (!Number.isFinite(rate) || rate < MIN_FEE_RATE_SATS_PER_VB) {
          throw new Error(`Fee rate must be at least ${MIN_FEE_RATE_SATS_PER_VB} sat/vB.`);
        }
        send = totalSats - Math.ceil(rate * vbytes);
      } else {
        send = parseInt(amountSats, 10);
        if (!Number.isFinite(send)) {
          throw new Error("Enter the amount to send in satoshis.");
        }
        change = changeAddress.trim() || undefined;
      }
      const result = buildUnsignedPsbt({
        inputs: inputSpecs,
        destinationAddress: destination,
        sendAmountSats: send,
        feeRateSatsPerVb: rate,
        changeAddress: change,
        network: destNetwork,
      });
      return { result };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [open, preparing, inputSpecs, destination, feeRate, sendMax, amountSats, changeAddress, totalSats]);

  const result = preview?.result;
  const displayWarnings = useMemo(() => {
    const warnings = [...(result?.warnings ?? [])];
    if (result && result.feeSats > result.sendAmountSats * 0.2) {
      warnings.push(
        `The fee (${result.feeSats.toLocaleString()} sats) is more than 20% of the amount being sent — double-check the fee rate.`,
      );
    }
    return warnings;
  }, [result]);

  // Multi-wallet selection: the user picked which wallet should receive
  // change — suggest a fresh change address from that wallet's change chain.
  const handleChangeWalletSelect = async (xpub: string) => {
    setChangeWalletXpub(xpub);
    setSuggestingChange(true);
    try {
      const suggestion = await suggestFreshChangeAddress(selectedRecords, xpub);
      setSuggestedChange(suggestion);
      if (suggestion) {
        setChangeAddress(suggestion);
      } else {
        toast({
          title: "No fresh change address found",
          description:
            "Couldn't derive an unused change address for that wallet — enter one manually.",
          variant: "destructive",
        });
      }
    } finally {
      setSuggestingChange(false);
    }
  };

  const handleCopy = () => {
    if (!result) return;
    copy(result.psbtBase64, { label: "PSBT (base64)" });
  };

  const handleDownload = () => {
    if (!result) return;
    try {
      const blob = new Blob([result.psbtBytes.slice()], { type: "application/octet-stream" });
      downloadBlob(blob, `${filenameSafe(name)}.psbt`);
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  const handleSave = async () => {
    if (!result) return;
    setSaving(true);
    try {
      await savePsbt({
        name,
        psbtBase64: result.psbtBase64,
        destinationAddress: result.destinationAddress,
        changeAddress: result.changeAddress,
        feeRateSatsPerVb: parseFloat(feeRate),
        feeSats: result.feeSats,
        estimatedVbytes: result.estimatedVbytes,
        totalInputSats: result.totalInputSats,
        sendAmountSats: result.sendAmountSats,
        changeSats: result.changeSats,
        inputs: inputSpecs.map((i) => ({
          txid: i.txid,
          vout: i.vout,
          address: i.address,
          amountSats: i.amountSats,
          scriptType: i.scriptType,
          derivationPath: i.derivation?.path,
          hasDerivationInfo: !!i.derivation,
          hasScript: !!(i.witnessScriptHex || i.redeemScriptHex),
        })),
        outputs: result.outputs,
      });
      toast({
        title: "PSBT saved",
        description: "Reopen it any time from Saved PSBTs to inspect, copy, or download it.",
      });
      onSaved?.();
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Could not save the PSBT",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-build-psbt">
        <DialogHeader>
          <DialogTitle>Build unsigned PSBT</DialogTitle>
          <DialogDescription>
            Combine the selected UTXOs into an unsigned transaction you can take to your signer
            (Coldcard, Sparrow, hardware wallet). This app never signs or broadcasts.
          </DialogDescription>
        </DialogHeader>

        {preparing ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" data-testid="status-preparing">
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing input metadata…
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="text-selected-total">
              <span className="font-medium">{utxos.length} UTXO{utxos.length !== 1 ? "s" : ""} selected</span>
              <span className="ml-2 text-muted-foreground">
                {totalSats.toLocaleString()} sats ({satsToBtc(totalSats)} BTC) total
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="psbt-destination">Destination address</Label>
              <Input
                id="psbt-destination"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="bc1q…"
                className="font-mono text-sm"
                data-testid="input-destination"
              />
            </div>

            <div className="flex items-end gap-4 flex-wrap">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="psbt-fee-rate">Fee rate (sats/vB)</Label>
                <Input
                  id="psbt-fee-rate"
                  type="number"
                  min={MIN_FEE_RATE_SATS_PER_VB}
                  step="0.1"
                  value={feeRate}
                  onChange={(e) => setFeeRate(e.target.value)}
                  className="w-28"
                  data-testid="input-fee-rate"
                />
              </div>
              <div className="flex items-center gap-2 pb-1.5">
                <Switch
                  id="psbt-send-max"
                  checked={sendMax}
                  onCheckedChange={setSendMax}
                  data-testid="switch-send-max"
                />
                <Label htmlFor="psbt-send-max">Send max (everything minus the fee)</Label>
              </div>
            </div>

            {!sendMax && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="psbt-amount">Amount to send (sats)</Label>
                <Input
                  id="psbt-amount"
                  type="number"
                  min={DUST_LIMIT_SATS}
                  value={amountSats}
                  onChange={(e) => setAmountSats(e.target.value)}
                  placeholder={`${DUST_LIMIT_SATS} – ${totalSats}`}
                  className="w-48"
                  data-testid="input-amount"
                />
              </div>
            )}

            {changeWalletOptions.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="psbt-change-wallet">
                  Change wallet <span className="text-muted-foreground">(selection spans multiple wallets)</span>
                </Label>
                <Select
                  value={changeWalletXpub}
                  onValueChange={handleChangeWalletSelect}
                  disabled={suggestingChange}
                >
                  <SelectTrigger id="psbt-change-wallet" data-testid="select-change-wallet">
                    <SelectValue placeholder="Pick which wallet should receive change" />
                  </SelectTrigger>
                  <SelectContent>
                    {changeWalletOptions.map((opt) => (
                      <SelectItem
                        key={opt.xpub}
                        value={opt.xpub}
                        data-testid={`option-change-wallet-${opt.xpub.slice(0, 8)}`}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="psbt-change">
                Change address {sendMax && <span className="text-muted-foreground">(not used when sending max)</span>}
              </Label>
              <Input
                id="psbt-change"
                value={changeAddress}
                onChange={(e) => setChangeAddress(e.target.value)}
                placeholder={suggestedChange ? suggestedChange : "Optional — where the leftover goes"}
                disabled={sendMax}
                className="font-mono text-sm"
                data-testid="input-change-address"
              />
              {suggestedChange && changeAddress === suggestedChange && !sendMax && (
                <p className="text-xs text-muted-foreground" data-testid="text-change-suggestion">
                  {changeWalletXpub
                    ? "Fresh unused change address from the chosen wallet."
                    : "Fresh unused change address from the same wallet."}
                </p>
              )}
            </div>

            {preview?.error && (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="text-build-error"
              >
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{preview.error}</span>
              </div>
            )}

            {result && (
              <div className="rounded-md border px-3 py-2 text-sm flex flex-col gap-1" data-testid="panel-build-summary">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Send amount</span>
                  <span className="font-mono" data-testid="text-send-amount">
                    {result.sendAmountSats.toLocaleString()} sats
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Fee ({parseFloat(feeRate) || 0} sats/vB × ~{result.estimatedVbytes} vB)
                  </span>
                  <span className="font-mono" data-testid="text-fee">
                    {result.feeSats.toLocaleString()} sats
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Change</span>
                  <span className="font-mono" data-testid="text-change">
                    {result.changeSats > 0 ? `${result.changeSats.toLocaleString()} sats` : "—"}
                  </span>
                </div>
                {displayWarnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-amber-600 dark:text-amber-400 mt-1"
                    data-testid={`text-build-warning-${i}`}
                  >
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="psbt-name">Name</Label>
              <Input
                id="psbt-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="input-psbt-name"
              />
            </div>
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <p className="text-xs text-muted-foreground sm:max-w-[45%]">
            Saved PSBTs are stored in your vault and ride the normal backup/restore.
          </p>
          <div className="flex gap-2 justify-end flex-wrap">
            <Button
              variant="outline"
              onClick={handleCopy}
              disabled={!result}
              data-testid="button-copy-psbt"
            >
              {isCopied(result?.psbtBase64 ?? "") ? (
                <Check className="h-4 w-4 mr-1 text-green-500" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              Copy base64
            </Button>
            <Button
              variant="outline"
              onClick={handleDownload}
              disabled={!result}
              data-testid="button-download-psbt"
            >
              <Download className="h-4 w-4 mr-1" />
              Download .psbt
            </Button>
            <Button onClick={handleSave} disabled={!result || saving} data-testid="button-save-psbt">
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
