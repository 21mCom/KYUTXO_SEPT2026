import { useState, useEffect, useRef } from "react";
import { getActivityBus } from "@/lib/activity-bus";
import { Download, Lock, FileJson, AlertCircle, AlertTriangle, CheckCircle2, FolderOpen, FileSpreadsheet, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { db } from "@/lib/database";
import { countAttachments } from "@/lib/data/attachments-crud";
import { countDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { countRecords } from "@/lib/data/record-crud";
import { countTransactions, countTransactionParticipants } from "@/lib/data/transaction-crud";
import { countAddressSyncState } from "@/lib/data/address-sync-crud";
import { countUtxoLineage, countCustodySegments } from "@/lib/data/lineage-crud";
import { isElectron, getElectronAPI } from "@/lib/electron";
import { exportBackup, estimateExportBytes } from "@/lib/backup/export";
import { evaluateDiskSpace } from "@/lib/backup/restore";
import {
  MemorySink,
  BackupCancelledError,
  openFileSystemSink,
  openElectronFileSink,
  supportsFileSystemAccess,
  supportsElectronBackup,
  decideExportSinkKind,
  isMemoryFallbackSafe,
  downloadBlob,
  type BackupSink,
} from "@/lib/backup/sink";

// Above these counts a pure in-memory (download) export is refused to avoid an
// out-of-memory crash. The streaming-to-disk paths (desktop, File System Access
// API) have no such limit. MEMORY_EXPORT_ROW_LIMIT applies to the AGGREGATE of
// all streamed large tables (records + transactions + participants +
// addressSyncState + utxoLineage + custodySegments), since the in-memory archive
// holds them all at once.
const MEMORY_EXPORT_ROW_LIMIT = 50000;
const MEMORY_EXPORT_ATTACHMENT_LIMIT = 5000;

// Helper to list all attachment files
async function listAllAttachmentFiles(): Promise<string[]> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.listAllAttachments();
    return result.success ? (result.files || []) : [];
  } else {
    const response = await fetch('/api/attachments/list-all');
    if (response.ok) {
      const data = await response.json();
      return data.success ? (data.files || []) : [];
    }
    return [];
  }
}

// Exact total bytes of every attachment file on disk (stored uncompressed in the
// ZIP). Recorded in the backup manifest so the restore pre-flight can size disk
// space precisely. Returns null when the figure is unavailable, so the export
// falls back to summing the attachment metadata `size`.
async function totalAttachmentFileBytes(): Promise<number | null> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.listAllAttachments();
    return result.success && typeof result.totalBytes === "number" ? result.totalBytes : null;
  } else {
    const response = await fetch('/api/attachments/list-all');
    if (response.ok) {
      const data = await response.json();
      return data.success && typeof data.totalBytes === "number" ? data.totalBytes : null;
    }
    return null;
  }
}

// Helper to read an attachment file
async function readAttachmentFile(relativePath: string): Promise<ArrayBuffer | null> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.readAttachment(relativePath);
    return result.success ? (result.data || null) : null;
  } else {
    const response = await fetch(`/api/attachments/download/attachments/${relativePath}`);
    if (response.ok) {
      return await response.arrayBuffer();
    }
    return null;
  }
}

export default function ExportPage() {
  const [encrypted, setEncrypted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [exportComplete, setExportComplete] = useState(false);

  const [recordCount, setRecordCount] = useState(0);
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [tagCount, setTagCount] = useState(0);
  const [categoryCount, setCategoryCount] = useState(0);
  const [vocabularyCount, setVocabularyCount] = useState(0);
  const [derivationTemplateCount, setDerivationTemplateCount] = useState(0);

  // Pre-flight low-disk-space warning (Electron streaming export). When set, the
  // export is paused and the user is asked to free space or continue anyway.
  const [diskWarning, setDiskWarning] = useState<{ requiredBytes: number; freeBytes: number } | null>(null);
  // When the user chooses "Export Anyway", this ref skips the disk check on the
  // re-triggered export so we don't loop back into the same warning.
  const bypassDiskCheckRef = useRef(false);

  const { toast } = useToast();

  const attachmentsFolderPath = isElectron() 
    ? "User Data Folder → data/attachments/" 
    : "data/attachments/";

  useEffect(() => {
    const loadCounts = async () => {
      try {
        const records = await countRecords();
        const attachments = await countAttachments();
        const tags = await db.tags.count();
        const categories = await db.categories.count();
        const owners = await db.owners.count();
        const walletNames = await db.walletNames.count();
        const seedNames = await db.seedNames.count();
        const walletSoftware = await db.walletSoftware.count();
        const derivationTemplates = await countDerivationTemplates();
        setRecordCount(records);
        setAttachmentCount(attachments);
        setTagCount(tags);
        setCategoryCount(categories);
        setVocabularyCount(owners + walletNames + seedNames + walletSoftware);
        setDerivationTemplateCount(derivationTemplates);
      } catch (error) {
        console.error("Failed to load counts:", error);
      }
    };
    loadCounts();
  }, []);

  const handleExport = async () => {
    if (encrypted && password !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Passwords Don't Match",
        description: "Please make sure both passwords match.",
      });
      return;
    }

    if (encrypted && password.length < 8) {
      toast({
        variant: "destructive",
        title: "Password Too Short",
        description: "Export password must be at least 8 characters.",
      });
      return;
    }

    setExporting(true);
    setProgress(0);
    setExportComplete(false);

    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = encrypted
      ? `kyutxo-backup-encrypted-${dateStr}.zip`
      : `kyutxo-backup-${dateStr}.zip`;

    // Fetch FRESH counts right before choosing a sink, rather than relying on
    // the display state loaded in useEffect (which may be stale, still zero, or
    // have failed to load). The in-memory fallback buffers the whole archive, so
    // the safety decision must reflect the true size at export time. If the
    // counts cannot be loaded we treat the dataset as unsafe-by-default.
    let totalRowCount = 0;
    let exportAttachmentCount = 0;
    let countsKnown = false;
    try {
      const [
        records,
        transactions,
        participants,
        syncState,
        utxoLineage,
        custodySegments,
        attachments,
      ] = await Promise.all([
        countRecords(),
        countTransactions(),
        countTransactionParticipants(),
        countAddressSyncState(),
        countUtxoLineage(),
        countCustodySegments(),
        countAttachments(),
      ]);
      totalRowCount =
        records +
        transactions +
        participants +
        syncState +
        utxoLineage +
        custodySegments;
      exportAttachmentCount = attachments;
      countsKnown = true;
    } catch (error) {
      console.error("Failed to load counts before export:", error);
      countsKnown = false;
    }

    const memorySafetyInput = {
      totalRowCount,
      attachmentCount: exportAttachmentCount,
      memoryRowLimit: MEMORY_EXPORT_ROW_LIMIT,
      memoryAttachmentLimit: MEMORY_EXPORT_ATTACHMENT_LIMIT,
      countsKnown,
    };

    // Pre-flight disk-space check (Electron only). A streaming export writes the
    // backup straight to disk, so if the disk fills up partway through it leaves
    // a truncated, unusable archive. Estimating the backup size (attachment file
    // sizes — stored uncompressed in the ZIP — plus a per-row allowance for the
    // compressed tables) and comparing it against free space lets the user free
    // space BEFORE any partial archive is written. Best-effort: if either probe
    // fails we let the export proceed rather than block it.
    if (isElectron() && !bypassDiskCheckRef.current) {
      try {
        const api = getElectronAPI();
        const [space, attachSize] = await Promise.all([
          api.getDiskSpace(),
          api.getAttachmentsSize(),
        ]);
        if (
          space.success &&
          typeof space.freeBytes === "number" &&
          attachSize.success &&
          typeof attachSize.totalBytes === "number"
        ) {
          const estimatedBytes = estimateExportBytes({
            attachmentBytes: attachSize.totalBytes,
            rowCount: totalRowCount,
          });
          const estimate = evaluateDiskSpace(estimatedBytes, space.freeBytes);
          if (!estimate.sufficient) {
            setExporting(false);
            setProgress(0);
            setProgressMessage("");
            setDiskWarning({
              requiredBytes: estimate.requiredBytes,
              freeBytes: space.freeBytes,
            });
            return;
          }
        }
      } catch {
        // Probe failed — fall through and let the export proceed.
      }
    }
    bypassDiskCheckRef.current = false;

    // Pick where the backup bytes go. The streaming-to-disk paths (Electron
    // desktop, browser File System Access API) never hold the whole archive in
    // memory. The in-memory download fallback does, so it is only used for small
    // datasets of known size — larger or unknown-size ones are refused rather
    // than risking an out-of-memory crash.
    const sinkKind = decideExportSinkKind({
      isElectron: isElectron(),
      supportsFileSystemAccess: supportsFileSystemAccess(),
      supportsElectronBackup: supportsElectronBackup(),
      ...memorySafetyInput,
    });

    if (sinkKind === "blocked") {
      setExporting(false);
      toast({
        variant: "destructive",
        title: "Backup Too Large For This Browser",
        description:
          "This dataset is too large to export safely from a web browser without streaming-to-disk support. Use the desktop app, or a Chromium-based browser that can save directly to a file.",
      });
      return;
    }

    let sink: BackupSink | null = null;
    let memorySink: MemorySink | null = null;
    let savedToDisk = false;
    try {
      if (sinkKind === "electron") {
        sink = await openElectronFileSink(fileName);
        savedToDisk = true;
      } else if (sinkKind === "filesystem") {
        sink = await openFileSystemSink(fileName);
        savedToDisk = true;
      }
      // A disk path can still report "unsupported" at open time (null) even when
      // the capability check passed; fall back to memory only when the dataset
      // is small and its size is known (same gate as the primary decision).
      if (!sink) {
        if (!isMemoryFallbackSafe(memorySafetyInput)) {
          setExporting(false);
          toast({
            variant: "destructive",
            title: "Backup Too Large For This Browser",
            description:
              "This dataset is too large to export safely without streaming-to-disk support. Use the desktop app, or a Chromium-based browser that can save directly to a file.",
          });
          return;
        }
        memorySink = new MemorySink();
        sink = memorySink;
        savedToDisk = false;
      }
    } catch (error) {
      if (error instanceof BackupCancelledError) {
        setExporting(false);
        return; // user dismissed the save dialog
      }
      setExporting(false);
      toast({
        variant: "destructive",
        title: "Export Failed",
        description: error instanceof Error ? error.message : "Could not start the export.",
      });
      return;
    }

    if (!sink) {
      setExporting(false);
      return;
    }

    try {
      getActivityBus().publishTask({
        id: 'evidence-export',
        label: 'Exporting Backup',
        phase: 'Starting',
        current: 0,
        total: 1,
      });
    } catch {}

    try {
      await exportBackup({
        sink,
        encrypted,
        password,
        attachmentIO: { listAll: listAllAttachmentFiles, read: readAttachmentFile, totalBytes: totalAttachmentFileBytes },
        onProgress: (p) => {
          setProgress(p.percent);
          setProgressMessage(p.phase);
        },
      });

      if (memorySink && memorySink.blob) {
        downloadBlob(memorySink.blob, fileName);
      }

      setProgress(100);
      setProgressMessage("Export complete!");
      setExportComplete(true);
      try { getActivityBus().completeTask('evidence-export'); } catch {}

      toast({
        title: "Export Successful",
        description: savedToDisk
          ? `Your backup "${fileName}" has been saved.`
          : `Your backup "${fileName}" has been downloaded.`,
      });
    } catch (error) {
      try { getActivityBus().completeTask('evidence-export'); } catch {}
      if (error instanceof BackupCancelledError) {
        toast({
          title: "Export Cancelled",
          description: "The backup was cancelled before completion.",
        });
      } else {
        console.error("Export failed:", error);
        toast({
          variant: "destructive",
          title: "Export Failed",
          description: error instanceof Error ? error.message : "Failed to export data",
        });
      }
    } finally {
      setExporting(false);
    }
  };

  const estimatedSize = () => {
    const estimate = (recordCount * 500) + (attachmentCount * 100) + (tagCount * 50) + (categoryCount * 50);
    if (estimate < 1024) return `${estimate} B`;
    if (estimate < 1024 * 1024) return `${(estimate / 1024).toFixed(1)} KB`;
    return `${(estimate / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Backup</h1>
          <p className="text-muted-foreground">
            Download your Bitcoin records and metadata as a backup ZIP file
          </p>
        </div>

        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Export includes all records, transactions, tags, categories, vocabulary, lineage data, and attachment files.
            Large databases stream directly to disk in the desktop app and in browsers that support saving to a file.
            In other browsers, smaller backups download as a ZIP file; very large databases must be exported from the
            desktop app.
          </AlertDescription>
        </Alert>

        {exportComplete && (
          <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700 dark:text-green-300">
              Export complete! Check your Downloads folder for the backup ZIP file.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileJson className="h-5 w-5" />
              Export Configuration
            </CardTitle>
            <CardDescription>
              Configure your data export options
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base">Encrypt Export</Label>
                <p className="text-sm text-muted-foreground">
                  Protect your backup with a separate password
                </p>
              </div>
              <Switch
                checked={encrypted}
                onCheckedChange={setEncrypted}
                data-testid="switch-encrypt"
              />
            </div>

            {!encrypted && (
              <Alert variant="destructive" data-testid="alert-unencrypted-export">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Your backup will contain unencrypted plaintext data including Bitcoin addresses, transaction IDs, labels, notes, wallet names, owner information, and financial data. Anyone who obtains this file can read all of its contents. Consider enabling encryption above or storing the exported file in a secure location.
                </AlertDescription>
              </Alert>
            )}

            {encrypted && (
              <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
                <div className="flex items-center gap-2 mb-3">
                  <Lock className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">
                    Export Encryption Password
                  </span>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter a strong password (min 8 characters)"
                    data-testid="input-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    data-testid="input-confirm-password"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  You'll need this password to import the backup. Store it securely.
                </p>
              </div>
            )}

            {exporting && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{progressMessage}</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} />
              </div>
            )}

            <Button
              className="w-full"
              size="lg"
              onClick={handleExport}
              disabled={exporting || (encrypted && (!password || password !== confirmPassword || password.length < 8))}
              data-testid="button-export"
            >
              <Download className="h-4 w-4 mr-2" />
              {exporting ? "Exporting..." : "Export & Download Backup"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              What's Included
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm space-y-2">
              <p className="font-medium">The ZIP file contains:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
                <li><code className="text-xs bg-muted px-1 rounded">backup.json</code> - Manifest with counts, settings, and smaller tables</li>
                <li><code className="text-xs bg-muted px-1 rounded">tables/</code> - Large tables (records, transactions, participants, attachments, sync state) as streamed NDJSON</li>
                <li><code className="text-xs bg-muted px-1 rounded">attachments/</code> - Folder containing all attachment files</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Export Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Records</span>
              <span className="font-medium" data-testid="text-record-count">{recordCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Tags</span>
              <span className="font-medium" data-testid="text-tag-count">{tagCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Categories</span>
              <span className="font-medium" data-testid="text-category-count">{categoryCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Vocabulary Items</span>
              <span className="font-medium" data-testid="text-vocabulary-count">{vocabularyCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Derivation Templates</span>
              <span className="font-medium" data-testid="text-template-count">{derivationTemplateCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Attachments</span>
              <span className="font-medium" data-testid="text-attachment-count">{attachmentCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Estimated Size</span>
              <span className="font-medium" data-testid="text-file-size">{estimatedSize()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Format</span>
              <span className="font-medium">ZIP (JSON + NDJSON)</span>
            </div>
          </CardContent>
        </Card>

        {attachmentCount > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Paperclip className="h-5 w-5" />
                File Attachments
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                <span className="font-medium">Attachments are included in backup</span>
              </div>
              <p className="text-sm text-muted-foreground">
                All {attachmentCount} attachment file(s) will be exported to the <code className="bg-muted px-1 rounded">attachments/</code> folder 
                in the ZIP file and automatically restored when you import this backup.
              </p>
              <p className="text-xs text-muted-foreground">
                Attachment files are stored unencrypted. Use the ZIP password protection option 
                above to secure your exported backup.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Pre-flight low-disk-space warning. Shown BEFORE any bytes are written so
          the user can free space without leaving a truncated archive behind. */}
      <AlertDialog
        open={diskWarning !== null}
        onOpenChange={(open) => !open && setDiskWarning(null)}
      >
        <AlertDialogContent data-testid="dialog-export-disk-warning">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Not enough free disk space
            </AlertDialogTitle>
            <AlertDialogDescription>
              {diskWarning
                ? `This backup needs about ${formatBytes(diskWarning.requiredBytes)} of free space, but only ${formatBytes(diskWarning.freeBytes)} is available. Free up some space and try again, or export anyway — but if the disk fills up partway through, the backup file will be incomplete and unusable.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setDiskWarning(null)}
              data-testid="button-cancel-export-disk-warning"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                bypassDiskCheckRef.current = true;
                setDiskWarning(null);
                void handleExport();
              }}
              data-testid="button-proceed-export-disk-warning"
            >
              Export Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
