import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AlertCircle, CheckCircle2, Download, FileArchive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getFileBlob } from "@/lib/attachments";
import { getAllEvidence, getEvidenceAttachmentsByEvidenceId } from "@/lib/data/evidence-crud";
import { getRecordsByIds } from "@/lib/data/record-crud";
import { getParticipantsByTxids, getTransactionsByTxids } from "@/lib/data/transaction-crud";
import {
  getCustodySegmentsBySegmentIds,
  getLineageSnapshotsBySnapshotIds,
  getUtxoLineageByOutpoints,
} from "@/lib/data/lineage-crud";
import {
  buildEvidencePackage,
  buildEvidencePackageToSink,
  EVIDENCE_PACKAGE_MAX_TOTAL_ATTACHMENT_BYTES,
  EvidencePackageError,
  NO_EVIDENCE_PACKAGE_REDACTION,
  type EvidencePackageRedaction,
} from "@/lib/evidence-package-export";
import {
  BackupCancelledError,
  downloadBlob,
  openElectronFileSink,
  openFileSystemSink,
  supportsElectronBackup,
  supportsFileSystemAccess,
} from "@/lib/backup/sink";
import { isElectron } from "@/lib/electron";
import type { Evidence } from "@/lib/db-types";

function splitTokens(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseIds(value: string): { ids: number[]; invalid: string[] } {
  const tokens = splitTokens(value);
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    const id = Number(token);
    if (Number.isSafeInteger(id) && id > 0) ids.push(id);
    else invalid.push(token);
  }
  return { ids: [...new Set(ids)], invalid };
}

function parseOutpoints(value: string): {
  outpoints: Array<{ txid: string; vout: number }>;
  invalid: string[];
} {
  const outpoints: Array<{ txid: string; vout: number }> = [];
  const invalid: string[] = [];
  for (const token of splitTokens(value)) {
    const separator = token.lastIndexOf(":");
    const txid = separator > 0 ? token.slice(0, separator) : "";
    const vout = separator > 0 ? Number(token.slice(separator + 1)) : NaN;
    if (txid && Number.isSafeInteger(vout) && vout >= 0) outpoints.push({ txid, vout });
    else invalid.push(token);
  }
  const unique = new Map(outpoints.map((item) => [`${item.txid}:${item.vout}`, item]));
  return { outpoints: [...unique.values()], invalid };
}

function redactionLabel(redaction: EvidencePackageRedaction): string {
  const labels: string[] = [];
  if (redaction.redactAddresses) labels.push("addresses");
  if (redaction.redactNotes) labels.push("notes and narratives");
  if (redaction.redactParties) labels.push("owners, wallets, sources, and parties");
  return labels.length ? labels.join(", ") : "none";
}

export function EvidencePackageBuilder() {
  const { toast } = useToast();
  const evidence = useLiveQuery(() => getAllEvidence().catch(() => []), []);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<Set<number>>(new Set());
  const [recordIdsText, setRecordIdsText] = useState("");
  const [transactionIdsText, setTransactionIdsText] = useState("");
  const [outpointsText, setOutpointsText] = useState("");
  const [segmentIdsText, setSegmentIdsText] = useState("");
  const [snapshotIdsText, setSnapshotIdsText] = useState("");
  const [redaction, setRedaction] = useState<EvidencePackageRedaction>(NO_EVIDENCE_PACKAGE_REDACTION);
  const [streamToDisk, setStreamToDisk] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState("");
  const cancelRequested = useRef(false);

  // Explicit opt-in streaming path (Electron backup bridge or the browser File
  // System Access API): writes the ZIP straight to disk one entry at a time
  // instead of buffering it in memory, so a selection can exceed
  // EVIDENCE_PACKAGE_MAX_TOTAL_ATTACHMENT_BYTES. Only offered when a
  // streaming-to-disk destination actually exists.
  const canStreamElectron = isElectron() && supportsElectronBackup();
  const canStreamFilesystem = supportsFileSystemAccess();
  const canStreamToDisk = canStreamElectron || canStreamFilesystem;

  const selectedEvidence = useMemo(
    () => (evidence ?? []).filter((item): item is Evidence & { id: number } =>
      item.id !== undefined && selectedEvidenceIds.has(item.id),
    ),
    [evidence, selectedEvidenceIds],
  );
  const parsed = useMemo(() => ({
    records: parseIds(recordIdsText),
    transactions: splitTokens(transactionIdsText),
    outpoints: parseOutpoints(outpointsText),
    segments: splitTokens(segmentIdsText),
    snapshots: splitTokens(snapshotIdsText),
  }), [recordIdsText, transactionIdsText, outpointsText, segmentIdsText, snapshotIdsText]);
  const requestedCount =
    selectedEvidence.length +
    parsed.records.ids.length +
    parsed.transactions.length +
    parsed.outpoints.outpoints.length +
    parsed.segments.length +
    parsed.snapshots.length;
  const invalidInputCount =
    parsed.records.invalid.length +
    parsed.outpoints.invalid.length;

  const toggleEvidence = (id: number) => {
    setSelectedEvidenceIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateRedaction = (key: keyof EvidencePackageRedaction, checked: boolean) => {
    setRedaction((current) => ({ ...current, [key]: checked }));
  };

  const handleCancel = () => {
    cancelRequested.current = true;
    setProgress("Cancelling…");
  };

  const handleExport = async () => {
    if (isExporting) return;
    if (requestedCount === 0) {
      toast({
        title: "Select evidence first",
        description: "Choose at least one evidence item, record, transaction, UTXO, custody segment, or proof snapshot.",
      });
      return;
    }
    if (invalidInputCount > 0) {
      toast({
        title: "Invalid selection",
        description: `Fix the invalid ID/outpoint value${invalidInputCount === 1 ? "" : "s"} before exporting.`,
        variant: "destructive",
      });
      return;
    }

    cancelRequested.current = false;
    setIsExporting(true);
    setProgress("Reading selected sources…");
    try {
      const records = await getRecordsByIds(parsed.records.ids);
      const missingRecords = parsed.records.ids.filter((id) => !records.some((row) => row.id === id));
      if (missingRecords.length) throw new EvidencePackageError(`Record reference not found: ${missingRecords.join(", ")}.`);

      const transactions = await getTransactionsByTxids(parsed.transactions);
      const missingTransactions = parsed.transactions.filter((txid) => !transactions.some((row) => row.txid === txid));
      if (missingTransactions.length) throw new EvidencePackageError(`Transaction reference not found: ${missingTransactions.join(", ")}.`);
      const participants = await getParticipantsByTxids(transactions.map((row) => row.txid));

      const utxoLineage = await getUtxoLineageByOutpoints(parsed.outpoints.outpoints);
      const foundOutpoints = new Set(
        utxoLineage.flatMap((row) => [
          row.spentTxid != null && row.spentVout != null ? `${row.spentTxid}:${row.spentVout}` : null,
          row.createdTxid != null && row.createdVout != null ? `${row.createdTxid}:${row.createdVout}` : null,
        ]).filter((item): item is string => item !== null),
      );
      const missingOutpoints = parsed.outpoints.outpoints
        .map((item) => `${item.txid}:${item.vout}`)
        .filter((item) => !foundOutpoints.has(item));
      if (missingOutpoints.length) throw new EvidencePackageError(`UTXO reference not found: ${missingOutpoints.join(", ")}.`);

      const custodySegments = await getCustodySegmentsBySegmentIds(parsed.segments);
      const missingSegments = parsed.segments.filter((id) => !custodySegments.some((row) => row.segmentId === id));
      if (missingSegments.length) throw new EvidencePackageError(`Custody segment reference not found: ${missingSegments.join(", ")}.`);

      const lineageSnapshots = await getLineageSnapshotsBySnapshotIds(parsed.snapshots);
      const missingSnapshots = parsed.snapshots.filter((id) => !lineageSnapshots.some((row) => row.snapshotId === id));
      if (missingSnapshots.length) throw new EvidencePackageError(`Proof snapshot reference not found: ${missingSnapshots.join(", ")}.`);

      if (cancelRequested.current) throw new EvidencePackageError("Export cancelled.");
      setProgress("Collecting selected attachments…");
      const evidenceAttachments = (await Promise.all(
        selectedEvidence.map((item) => getEvidenceAttachmentsByEvidenceId(item.id)),
      )).flat();

      const selectionPayload = {
        evidence: selectedEvidence,
        records,
        transactions,
        participants,
        utxoLineage,
        custodySegments,
        lineageSnapshots,
        evidenceAttachments,
        redaction,
      };
      const reader = { read: (attachment: { objectStoragePath: string; mimeType: string }) => getFileBlob(attachment.objectStoragePath, attachment.mimeType) };

      if (streamToDisk && canStreamToDisk) {
        // The suggested filename embeds the date, and the save dialog must be
        // opened (and the user's choice known) before the build starts — so
        // generatedAt is fixed here rather than left to the library default.
        const generatedAt = Date.now();
        const fileName = `kyutxo-evidence-package-${new Date(generatedAt).toISOString().slice(0, 10)}.zip`;
        let sink;
        try {
          sink = canStreamElectron ? await openElectronFileSink(fileName) : await openFileSystemSink(fileName);
        } catch (error) {
          if (error instanceof BackupCancelledError) {
            setProgress("");
            return; // user dismissed the save dialog — not an error
          }
          throw error;
        }
        if (!sink) throw new EvidencePackageError("No streaming-to-disk destination is available.");

        setProgress("Hashing files and streaming the offline package to disk…");
        const result = await buildEvidencePackageToSink(selectionPayload, reader, sink, {
          generatedAt,
          shouldCancel: () => cancelRequested.current,
          onProgress: (phase, current, total) => setProgress(`${phase} (${current}/${total})…`),
        });
        setProgress("Export complete.");
        toast({
          title: "Evidence package exported",
          description: `${result.manifest.files.length} verified files, ${result.manifest.counts.attachments} attachment(s), and a redacted HTML report were saved to "${fileName}".`,
        });
      } else {
        setProgress("Hashing files and building the offline package…");
        const result = await buildEvidencePackage(selectionPayload, reader, {
          shouldCancel: () => cancelRequested.current,
          onProgress: (phase, current, total) => setProgress(`${phase} (${current}/${total})…`),
        });
        if (cancelRequested.current) throw new EvidencePackageError("Export cancelled.");

        const date = new Date(result.manifest.generatedAt).toISOString().slice(0, 10);
        downloadBlob(result.blob, `kyutxo-evidence-package-${date}.zip`);
        setProgress("Export complete.");
        toast({
          title: "Evidence package exported",
          description: `${result.manifest.files.length} verified files, ${result.manifest.counts.attachments} attachment(s), and a redacted HTML report were downloaded.`,
        });
      }
    } catch (error) {
      if (error instanceof BackupCancelledError) {
        setProgress("");
        return;
      }
      const message = error instanceof Error ? error.message : "Could not build the evidence package.";
      toast({
        title: message === "Export cancelled." ? "Export cancelled" : "Evidence package failed",
        description: message,
        variant: message === "Export cancelled." ? "default" : "destructive",
      });
      setProgress("");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card className="mb-6 border-primary/30" data-testid="evidence-package-builder">
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileArchive className="h-5 w-5" />
              Evidence package builder
            </CardTitle>
            <CardDescription>
              Assemble an offline ZIP containing only the sources you choose, a machine-readable manifest, verified attachments, and an HTML report.
            </CardDescription>
          </div>
          <span className="text-xs rounded-full bg-muted px-2 py-1" data-testid="text-package-selection-count">
            {requestedCount} source{requestedCount === 1 ? "" : "s"} selected
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-md border bg-muted/30 p-3 text-sm flex gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <span>Everything stays local and offline. Related rows are not pulled in implicitly; transaction participants are included only for transactions you explicitly select.</span>
        </div>

        <div className="space-y-2">
          <Label>Evidence items</Label>
          {!evidence ? (
            <p className="text-sm text-muted-foreground">Loading evidence…</p>
          ) : evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">No persisted evidence items yet.</p>
          ) : (
            <div className="max-h-48 overflow-auto rounded-md border divide-y">
              {evidence.map((item) => item.id === undefined ? null : (
                <label key={item.id} className="flex items-center gap-3 p-2 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={selectedEvidenceIds.has(item.id)}
                    onChange={() => toggleEvidence(item.id!)}
                    data-testid={`checkbox-evidence-${item.id}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="block text-xs text-muted-foreground">{item.documentType}{item.notes ? " · notes included" : ""}</span>
                  </span>
                  {selectedEvidenceIds.has(item.id) && <CheckCircle2 className="h-4 w-4 text-primary" />}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="package-record-ids">Record IDs</Label>
            <Input id="package-record-ids" value={recordIdsText} onChange={(event) => setRecordIdsText(event.target.value)} placeholder="e.g. 12, 14" data-testid="input-package-record-ids" />
            <p className="text-xs text-muted-foreground">Address/transaction metadata records from the Records screen.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="package-transaction-ids">Transaction IDs</Label>
            <Textarea id="package-transaction-ids" value={transactionIdsText} onChange={(event) => setTransactionIdsText(event.target.value)} placeholder="One txid per line" className="min-h-[72px]" data-testid="input-package-transaction-ids" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="package-outpoints">UTXO outpoints</Label>
            <Textarea id="package-outpoints" value={outpointsText} onChange={(event) => setOutpointsText(event.target.value)} placeholder="txid:vout" className="min-h-[72px]" data-testid="input-package-outpoints" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="package-segment-ids">Custody segment IDs</Label>
            <Textarea id="package-segment-ids" value={segmentIdsText} onChange={(event) => setSegmentIdsText(event.target.value)} placeholder="One segment ID per line" className="min-h-[72px]" data-testid="input-package-segment-ids" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="package-snapshot-ids">Proof snapshot IDs</Label>
            <Input id="package-snapshot-ids" value={snapshotIdsText} onChange={(event) => setSnapshotIdsText(event.target.value)} placeholder="Lineage snapshot IDs, if you want to include saved proof results" data-testid="input-package-snapshot-ids" />
          </div>
        </div>

        <div className="space-y-3">
          <Label>Redaction options</Label>
          <div className="grid gap-2 md:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={redaction.redactAddresses} onCheckedChange={(checked) => updateRedaction("redactAddresses", checked)} data-testid="switch-package-redact-addresses" />
              Hide address identifiers
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={redaction.redactNotes} onCheckedChange={(checked) => updateRedaction("redactNotes", checked)} data-testid="switch-package-redact-notes" />
              Remove notes and narratives
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={redaction.redactParties} onCheckedChange={(checked) => updateRedaction("redactParties", checked)} data-testid="switch-package-redact-parties" />
              Hide parties and sources
            </label>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="text-package-redaction-preview">
            Preview: {redactionLabel(redaction)} will be marked [REDACTED] in the report and JSON data.
          </p>
          {(selectedEvidence.length > 0 || parsed.records.ids.length > 0 || parsed.transactions.length > 0) && (
            <div className="rounded-md border p-3 text-sm" data-testid="package-selection-preview">
              <strong>Review before export</strong>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {selectedEvidence.map((item) => <li key={item.id}>{redaction.redactNotes ? "[REDACTED]" : item.title} (evidence)</li>)}
                {parsed.records.ids.length > 0 && <li>{parsed.records.ids.length} record reference(s)</li>}
                {parsed.transactions.length > 0 && <li>{parsed.transactions.length} transaction reference(s)</li>}
                {parsed.outpoints.outpoints.length > 0 && <li>{parsed.outpoints.outpoints.length} UTXO reference(s)</li>}
                {parsed.segments.length > 0 && <li>{parsed.segments.length} custody trail reference(s)</li>}
                {parsed.snapshots.length > 0 && <li>{parsed.snapshots.length} proof result reference(s)</li>}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={streamToDisk && canStreamToDisk}
              onCheckedChange={setStreamToDisk}
              disabled={!canStreamToDisk}
              data-testid="switch-package-stream-to-disk"
            />
            Stream to disk for large selections
          </label>
          <p className="text-xs text-muted-foreground" data-testid="text-package-stream-description">
            {canStreamToDisk
              ? `When on, the package is written straight to a file you choose instead of held in memory first, so a selection can exceed the normal in-memory limit (currently ${(EVIDENCE_PACKAGE_MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0)} MiB total). The manifest, hashes, and redaction are identical either way.`
              : "Unavailable in this browser: streaming to disk needs the desktop app or a Chromium-based browser with the File System Access API. Selections stay capped at the in-memory limit."}
          </p>
        </div>

        {invalidInputCount > 0 && <p className="text-sm text-destructive">Invalid record ID or UTXO outpoint values must be corrected before export.</p>}
        <div className="flex items-center gap-3 flex-wrap">
          <Button onClick={handleExport} disabled={isExporting || !evidence} data-testid="button-export-evidence-package">
            {isExporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
            {isExporting ? "Building package…" : "Export evidence package"}
          </Button>
          {isExporting && (
            <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-evidence-package">
              Cancel
            </Button>
          )}
          {progress && <span className="text-sm text-muted-foreground" data-testid="text-package-progress">{progress}</span>}
        </div>
      </CardContent>
    </Card>
  );
}