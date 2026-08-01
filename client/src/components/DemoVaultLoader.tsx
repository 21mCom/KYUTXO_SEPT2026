import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { PlayCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { countRecords } from "@/lib/data/record-crud";
import {
  peekManifest,
  restoreV3Backup,
  RestoreInterruptedError,
} from "@/lib/backup/restore";
import { createRestoreAttachmentWriter } from "@/lib/backup/restore-attachment-writer";
import { blobChunks } from "@/lib/backup/zip-stream";
import { isV3Manifest } from "@/lib/backup/format";
import { runPostRestoreTxidBackfill } from "@/lib/backup/post-restore-backfill";
import { resetOrphanCheckGate } from "@/lib/orphan-check-session";
import { getElectronAPISafe } from "@/lib/electron";

// Stream the on-disk demo vault zip out of the Electron main process in
// sequential fixed-size chunks. Called twice per load (manifest peek, then the
// real restore), so it must be a fresh iterable each time — hence a generator.
async function* electronDemoVaultChunks(): AsyncIterable<Uint8Array> {
  const api = getElectronAPISafe();
  if (!api?.readDemoVault) throw new Error("Demo vault reading is not available in this build.");
  let offset = 0;
  for (;;) {
    const res = await api.readDemoVault(offset);
    if (!res.success || !res.data) {
      throw new Error(res.error || "Could not read the demo vault file from disk.");
    }
    if (res.data.byteLength > 0) yield new Uint8Array(res.data);
    offset += res.data.byteLength;
    if (res.eof) return;
  }
}

// One-click demo-vault loading for presenters. Shown ONLY on a truly fresh
// vault (zero records in the database — not merely a filtered-empty view), so
// it can never destructively replace real data. Picking the demo zip
// (demo/kyutxo-demo-vault.zip — intentionally NOT bundled with the app) runs
// the existing v3 streaming restore path unchanged and reloads when done.
export function DemoVaultLoader() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  // Absolute path of an on-disk demo vault detected via Electron IPC, or null
  // when absent / on web builds (→ keep the file-picker behaviour).
  const [electronDemoAvailable, setElectronDemoAvailable] = useState(false);

  // Electron-only: probe for kyutxo-demo-vault.zip next to the executable or
  // in the data directory. When found, the button loads it with one click.
  useEffect(() => {
    const api = getElectronAPISafe();
    if (!api?.checkDemoVault) return;
    let cancelled = false;
    api
      .checkDemoVault()
      .then((res) => {
        if (!cancelled && res.present) setElectronDemoAvailable(true);
      })
      .catch(() => {
        // Probe failure just means we fall back to the picker.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Gate on the real record count, not the page's filtered list: the demo
  // restore uses replace semantics, so it must be impossible to trigger on a
  // vault that has any data. `undefined` while the query is loading → hidden.
  const recordCount = useLiveQuery(() => countRecords());
  if (recordCount === undefined || recordCount > 0) return null;

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after a failure.
    event.target.value = "";
    if (!file) return;
    await runDemoRestore(() => blobChunks(file));
  };

  // Shared restore pipeline. `makeChunks` must return a FRESH byte stream each
  // call — it is consumed twice (manifest peek, then the actual restore).
  const runDemoRestore = async (makeChunks: () => AsyncIterable<Uint8Array>) => {
    setIsLoading(true);
    setProgress(0);
    setMessage("Reading demo vault...");

    // Set on paths that schedule a reload — the finally block leaves the
    // button disabled in that case so it can't be clicked again pre-reload.
    let reloading = false;
    try {
      // The demo vault is a standard plaintext v3 backup. Anything else
      // (legacy/encrypted/random zip) should go through the full Settings
      // restore flow, which handles passwords and legacy formats.
      const manifestPeek = await peekManifest(makeChunks());
      if (!isV3Manifest(manifestPeek)) {
        toast({
          variant: "destructive",
          title: "Not a demo vault",
          description:
            "That file isn't a KYUTXO v3 backup. Pick demo/kyutxo-demo-vault.zip, or use Settings → Backup & Restore for older backups.",
        });
        return;
      }
      if (manifestPeek.encrypted) {
        toast({
          variant: "destructive",
          title: "Encrypted backup",
          description:
            "The demo vault is a plaintext backup. For encrypted backups, use Settings → Backup & Restore so you can enter the password.",
        });
        return;
      }

      const result = await restoreV3Backup({
        source: makeChunks(),
        attachmentWriter: createRestoreAttachmentWriter(),
        onProgress: (p) => {
          setProgress(p.percent);
          setMessage(p.phase);
        },
      });

      setProgress(100);
      setMessage("Demo vault loaded! Finishing up...");

      // Same post-restore steps as the Settings flow: backfill any orphaned
      // transaction records (helper never throws) and re-arm the once-per-
      // session orphan check so it re-evaluates after the reload.
      await runPostRestoreTxidBackfill({
        onMessage: setMessage,
        onPercent: setProgress,
      });
      resetOrphanCheckGate();

      toast({
        title: "Demo Vault Loaded",
        description: `Restored ${result.counts.records} records and ${result.counts.blockchainTransactions} transactions. Reloading...`,
      });
      setTimeout(() => {
        window.location.reload();
      }, 1200);
      // Keep the button disabled until the reload happens.
      reloading = true;
    } catch (error) {
      console.error("Demo vault load failed:", error);
      // The vault was empty going in, but an interrupted restore can leave it
      // partially populated — reload so the UI reflects the real state.
      const interrupted = error instanceof RestoreInterruptedError;
      toast({
        variant: "destructive",
        title: "Demo Load Failed",
        description:
          (error instanceof Error ? error.message : "Could not load the demo vault.") +
          (interrupted ? " The vault may be partially loaded — reloading." : ""),
      });
      if (interrupted) {
        resetOrphanCheckGate();
        setTimeout(() => window.location.reload(), 2000);
        reloading = true;
      }
    } finally {
      if (!reloading) {
        setIsLoading(false);
        setProgress(0);
        setMessage("");
      }
    }
  };

  return (
    <div className="flex flex-col items-center space-y-2" data-testid="demo-vault-loader">
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleFileSelected}
        className="hidden"
        data-testid="input-demo-vault-file"
      />
      <Button
        variant="outline"
        onClick={() =>
          electronDemoAvailable
            ? runDemoRestore(electronDemoVaultChunks)
            : fileInputRef.current?.click()
        }
        disabled={isLoading}
        data-testid="button-load-demo-vault"
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <PlayCircle className="h-4 w-4 mr-2" />
        )}
        {isLoading ? "Loading demo vault..." : "Load demo vault"}
      </Button>
      {isLoading ? (
        <div className="w-64 space-y-1" data-testid="demo-vault-progress">
          <Progress value={progress} />
          <p className="text-xs text-muted-foreground text-center">{message} {progress}%</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center max-w-xs">
          {electronDemoAvailable ? (
            <span data-testid="text-demo-vault-detected">
              Demo vault found alongside the app. One click fills this fresh vault with the demo
              dataset.
            </span>
          ) : (
            <>
              Presenting? Pick <span className="font-mono">demo/kyutxo-demo-vault.zip</span> to
              fill this fresh vault with the demo dataset in one step.
            </>
          )}
        </p>
      )}
    </div>
  );
}
