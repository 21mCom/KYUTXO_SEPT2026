import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileSignature,
  Loader2,
  Pencil,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  getAllSavedPsbts,
  renameSavedPsbt,
  deleteSavedPsbt,
} from "@/lib/data/saved-psbts-crud";
import { downloadBlob } from "@/lib/backup/sink";
import { truncateAddress } from "@/lib/bitcoin";
import type { SavedPsbt } from "@/lib/database";

function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function filenameSafe(name: string): string {
  const cleaned = name.trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return cleaned || "unsigned-psbt";
}

/** Decode base64 to bytes without the Node Buffer global (browser-safe). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface SavedPsbtsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SavedPsbtsDialog({ open, onOpenChange }: SavedPsbtsDialogProps) {
  const { toast } = useToast();
  const { copy, isCopied } = useCopyToClipboard();
  const saved: SavedPsbt[] | undefined = useLiveQuery(() => getAllSavedPsbts(), []);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const handleCopy = (psbt: SavedPsbt) => {
    copy(psbt.psbtBase64, { label: "PSBT (base64)", key: `psbt-${psbt.id}` });
  };

  const handleDownload = (psbt: SavedPsbt) => {
    try {
      const blob = new Blob([base64ToBytes(psbt.psbtBase64).slice()], {
        type: "application/octet-stream",
      });
      downloadBlob(blob, `${filenameSafe(psbt.name)}.psbt`);
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  const handleRename = async (psbt: SavedPsbt) => {
    if (psbt.id === undefined) return;
    setBusyId(psbt.id);
    try {
      await renameSavedPsbt(psbt.id, renameValue);
      setRenamingId(null);
      toast({ title: "PSBT renamed" });
    } catch (error) {
      toast({
        title: "Could not rename the PSBT",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (psbt: SavedPsbt) => {
    if (psbt.id === undefined) return;
    setBusyId(psbt.id);
    try {
      await deleteSavedPsbt(psbt.id);
      setConfirmingDeleteId(null);
      if (expandedId === psbt.id) setExpandedId(null);
      toast({ title: "PSBT deleted" });
    } catch (error) {
      toast({
        title: "Could not delete the PSBT",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-saved-psbts">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSignature className="h-5 w-5" />
            Saved PSBTs
          </DialogTitle>
          <DialogDescription>
            Unsigned transactions built from your UTXOs. Open one to inspect its inputs and outputs,
            copy the base64, or download the .psbt file for your signer. Saved PSBTs are stored in
            your vault and included in backups and restores.
          </DialogDescription>
        </DialogHeader>

        {saved === undefined ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" data-testid="status-saved-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading saved PSBTs…
          </div>
        ) : saved.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground" data-testid="text-no-saved-psbts">
            <FileSignature className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm">No saved PSBTs yet.</p>
            <p className="text-xs mt-1">Select UTXOs on the UTXOs page and choose “Build PSBT”.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {saved.map((psbt) => {
              const expanded = expandedId === psbt.id;
              const renaming = renamingId === psbt.id;
              const confirmingDelete = confirmingDeleteId === psbt.id;
              const busy = busyId === psbt.id;
              return (
                <div key={psbt.id} className="rounded-md border" data-testid={`row-saved-psbt-${psbt.id}`}>
                  <div
                    className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover-elevate"
                    onClick={() => setExpandedId(expanded ? null : psbt.id!)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {expanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      {renaming ? (
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            className="h-7 w-56"
                            data-testid={`input-rename-psbt-${psbt.id}`}
                          />
                          <Button
                            size="sm"
                            className="h-7"
                            disabled={busy}
                            onClick={() => handleRename(psbt)}
                            data-testid={`button-save-rename-${psbt.id}`}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7"
                            onClick={() => setRenamingId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <span className="font-medium truncate" data-testid={`text-psbt-name-${psbt.id}`}>
                          {psbt.name}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                      {psbt.outputs.some((o) => o.dataOutput?.isNotarization) && (
                        <Badge variant="outline" className="text-xs" data-testid={`badge-notarization-${psbt.id}`}>
                          <ShieldCheck className="h-3 w-3 mr-1" />
                          Notarization
                        </Badge>
                      )}
                      <Badge variant="secondary">{psbt.inputs.length} input{psbt.inputs.length !== 1 ? "s" : ""}</Badge>
                      <span className="font-mono">{psbt.sendAmountSats.toLocaleString()} sats</span>
                      <span className="font-mono">fee {psbt.feeSats.toLocaleString()}</span>
                      <span>{format(new Date(psbt.createdAt), "MMM d, yyyy")}</span>
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t px-3 py-3 flex flex-col gap-3 text-sm" data-testid={`panel-psbt-detail-${psbt.id}`}>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Destination</span>
                          <span className="font-mono" title={psbt.destinationAddress}>
                            {truncateAddress(psbt.destinationAddress, 12, 8)}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Send amount</span>
                          <span className="font-mono">
                            {psbt.sendAmountSats.toLocaleString()} sats ({satsToBtc(psbt.sendAmountSats)} BTC)
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Fee</span>
                          <span className="font-mono">
                            {psbt.feeSats.toLocaleString()} sats ({psbt.feeRateSatsPerVb} sats/vB × ~{psbt.estimatedVbytes} vB)
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Change</span>
                          <span className="font-mono" title={psbt.changeAddress}>
                            {psbt.changeSats > 0 && psbt.changeAddress
                              ? `${psbt.changeSats.toLocaleString()} sats → ${truncateAddress(psbt.changeAddress, 8, 6)}`
                              : "—"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Total inputs</span>
                          <span className="font-mono">{psbt.totalInputSats.toLocaleString()} sats</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Created</span>
                          <span>{format(new Date(psbt.createdAt), "MMM d, yyyy 'at' h:mm a")}</span>
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Inputs</p>
                        <div className="flex flex-col gap-1">
                          {psbt.inputs.map((input, i) => (
                            <div
                              key={`${input.txid}:${input.vout}`}
                              className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1"
                              data-testid={`row-psbt-input-${psbt.id}-${i}`}
                            >
                              <span className="font-mono text-xs truncate">
                                {input.txid.slice(0, 12)}…:{input.vout}
                                <span className="text-muted-foreground ml-2" title={input.address}>
                                  {truncateAddress(input.address, 8, 6)}
                                </span>
                              </span>
                              <span className="flex items-center gap-1 shrink-0">
                                <Badge variant="outline" className="text-xs">{input.scriptType}</Badge>
                                {input.hasDerivationInfo && (
                                  <Badge variant="outline" className="text-xs" title={input.derivationPath}>
                                    BIP-32
                                  </Badge>
                                )}
                                <span className="font-mono text-xs">{input.amountSats.toLocaleString()}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Outputs</p>
                        <div className="flex flex-col gap-1">
                          {psbt.outputs.map((output, i) => (
                            <div
                              key={`${output.address}-${i}`}
                              className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1"
                              data-testid={`row-psbt-output-${psbt.id}-${i}`}
                            >
                              {output.dataOutput ? (
                                <span className="flex items-center gap-2 min-w-0 font-mono text-xs">
                                  <Badge variant="secondary" className="text-xs shrink-0">OP_RETURN</Badge>
                                  <span className="truncate" title={output.dataOutput.payloadHex} data-testid={`text-data-payload-${psbt.id}-${i}`}>
                                    {output.dataOutput.payloadHex}
                                  </span>
                                  {output.dataOutput.isNotarization && (
                                    <Badge variant="outline" className="text-xs shrink-0">
                                      <ShieldCheck className="h-3 w-3 mr-1" />
                                      {output.dataOutput.evidenceFilename
                                        ? `Notarizes ${output.dataOutput.evidenceFilename}`
                                        : "Notarization"}
                                    </Badge>
                                  )}
                                </span>
                              ) : (
                                <span className="font-mono text-xs truncate" title={output.address}>
                                  {truncateAddress(output.address, 16, 10)}
                                  {output.isChange && (
                                    <Badge variant="secondary" className="ml-2 text-xs">change</Badge>
                                  )}
                                </span>
                              )}
                              <span className="flex items-center gap-1 shrink-0">
                                <span className="font-mono text-xs">{output.amountSats.toLocaleString()} sats</span>
                                {output.dataOutput && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6"
                                    onClick={() =>
                                      copy(output.dataOutput!.payloadHex, {
                                        label: "OP_RETURN payload (hex)",
                                        key: `hash-${psbt.id}-${i}`,
                                      })
                                    }
                                    title="Copy payload hash"
                                    data-testid={`button-copy-hash-${psbt.id}-${i}`}
                                  >
                                    {isCopied(`hash-${psbt.id}-${i}`) ? (
                                      <Check className="h-3.5 w-3.5 text-green-500" />
                                    ) : (
                                      <Copy className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="flex gap-2 flex-wrap justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCopy(psbt)}
                          data-testid={`button-copy-psbt-${psbt.id}`}
                        >
                          {isCopied(`psbt-${psbt.id}`) ? (
                            <Check className="h-3.5 w-3.5 mr-1 text-green-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 mr-1" />
                          )}
                          Copy base64
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownload(psbt)}
                          data-testid={`button-download-psbt-${psbt.id}`}
                        >
                          <Download className="h-3.5 w-3.5 mr-1" />
                          Download .psbt
                        </Button>
                        {!renaming && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setRenamingId(psbt.id!);
                              setRenameValue(psbt.name);
                            }}
                            data-testid={`button-rename-psbt-${psbt.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5 mr-1" />
                            Rename
                          </Button>
                        )}
                        {confirmingDelete ? (
                          <>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => handleDelete(psbt)}
                              data-testid={`button-confirm-delete-psbt-${psbt.id}`}
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
                              Confirm delete
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmingDeleteId(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setConfirmingDeleteId(psbt.id!)}
                            data-testid={`button-delete-psbt-${psbt.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                            Delete
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
