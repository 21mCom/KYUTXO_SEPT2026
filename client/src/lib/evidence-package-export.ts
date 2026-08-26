import JSZip from "jszip";
import type {
  BlockchainTransaction,
  CustodySegment,
  Evidence,
  EvidenceAttachment,
  LineageSnapshot,
  Record as DbRecord,
  TransactionParticipant,
  UtxoLineage,
} from "@/lib/db-types";

export const EVIDENCE_PACKAGE_VERSION = 1;
export const EVIDENCE_PACKAGE_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const EVIDENCE_PACKAGE_MAX_TOTAL_ATTACHMENT_BYTES = 75 * 1024 * 1024;

export interface EvidencePackageRedaction {
  redactAddresses: boolean;
  redactNotes: boolean;
  redactParties: boolean;
}

export const NO_EVIDENCE_PACKAGE_REDACTION: EvidencePackageRedaction = {
  redactAddresses: false,
  redactNotes: false,
  redactParties: false,
};

export interface EvidencePackageSelection {
  evidence: Evidence[];
  records: DbRecord[];
  transactions: BlockchainTransaction[];
  participants: TransactionParticipant[];
  utxoLineage: UtxoLineage[];
  custodySegments: CustodySegment[];
  lineageSnapshots: LineageSnapshot[];
  evidenceAttachments: EvidenceAttachment[];
  redaction?: EvidencePackageRedaction;
}

export interface EvidencePackageAttachmentReader {
  read: (attachment: EvidenceAttachment) => Promise<Blob | ArrayBuffer | Uint8Array>;
}

export interface EvidencePackageManifestAttachment {
  id?: number;
  evidenceId: number;
  filename: string;
  mimeType: string;
  size: number;
  sourceStoragePath: string;
  packagePath: string;
  sha256: string;
}

export interface EvidencePackageManifest {
  packageVersion: number;
  app: "KYUTXO";
  generatedAt: number;
  offline: true;
  redaction: EvidencePackageRedaction;
  sourceIdentifiers: {
    evidenceIds: number[];
    recordIds: number[];
    transactionIds: string[];
    utxoOutpoints: string[];
    custodySegmentIds: string[];
    lineageSnapshotIds: string[];
  };
  counts: {
    evidence: number;
    records: number;
    transactions: number;
    participants: number;
    utxoLineage: number;
    custodySegments: number;
    lineageSnapshots: number;
    attachments: number;
  };
  attachments: EvidencePackageManifestAttachment[];
  files: Array<{ path: string; kind: "report" | "data" | "attachment"; size: number; sha256: string }>;
  manifestSha256: string;
}

export interface EvidencePackageResult {
  blob: Blob;
  manifest: EvidencePackageManifest;
  reportHtml: string;
}

export interface EvidencePackageBuildOptions {
  generatedAt?: number;
  shouldCancel?: () => boolean;
  onProgress?: (phase: string, current: number, total: number) => void;
}

export class EvidencePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidencePackageError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value), null, 2);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function attachmentPath(attachment: EvidenceAttachment): string {
  const base = attachment.filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, "_").trim();
  if (!base) throw new EvidencePackageError(`Attachment ${attachment.id ?? "without an id"} has no safe filename.`);
  const evidenceId = Number.isInteger(attachment.evidenceId) ? attachment.evidenceId : "unknown";
  const attachmentId = Number.isInteger(attachment.id) ? attachment.id : "unknown";
  return `attachments/evidence-${evidenceId}-attachment-${attachmentId}-${base}`;
}

function validateStoragePath(path: string, attachment: EvidenceAttachment): void {
  if (
    !path ||
    path.includes("\u0000") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new EvidencePackageError(
      `Attachment "${attachment.filename}" has an unsafe storage path and was not exported.`,
    );
  }
}

function redactText(value: unknown, enabled: boolean): unknown {
  return enabled && typeof value === "string" ? "[REDACTED]" : value;
}

function redactRecord(record: DbRecord, options: EvidencePackageRedaction): DbRecord {
  const copy = redactGeneric(record as unknown as Record<string, unknown>, options) as unknown as DbRecord;
  if (options.redactAddresses && copy.type === "address") {
    copy.inputString = "[REDACTED ADDRESS]";
    if (copy.inputStringLower) copy.inputStringLower = "[REDACTED ADDRESS]";
  }
  return copy;
}

function redactGeneric<T extends Record<string, unknown>>(row: T, options: EvidencePackageRedaction): T {
  const redact = (value: unknown, key = ""): unknown => {
    if (options.redactAddresses && /address|xpub/i.test(key)) {
      if (Array.isArray(value)) return value.map(() => "[REDACTED ADDRESS]");
      if (typeof value === "string") return "[REDACTED ADDRESS]";
    }
    if (options.redactNotes && /note|narrative/i.test(key)) {
      if (Array.isArray(value)) return value.map(() => "[REDACTED]");
      if (typeof value === "string") return "[REDACTED]";
    }
    if (options.redactParties && /party|source|owner|wallet|seed|vault/i.test(key)) {
      if (Array.isArray(value)) return value.map(() => "[REDACTED]");
      if (typeof value === "string") return "[REDACTED]";
    }
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
    }
    return value;
  };
  return redact(row) as T;
}

function redactedSelection(selection: EvidencePackageSelection, options: EvidencePackageRedaction) {
  return {
    evidence: selection.evidence.map((item) => {
      const copy = { ...item };
      if (options.redactNotes) copy.notes = "[REDACTED]";
      if (options.redactParties) {
        copy.partiesInvolved = copy.partiesInvolved?.map(() => "[REDACTED]");
        copy.source = copy.source ? "[REDACTED]" : copy.source;
      }
      return copy;
    }),
    records: selection.records.map((item) => redactRecord(item, options)),
    transactions: selection.transactions.map((item) => redactGeneric(item as unknown as Record<string, unknown>, options)),
    participants: selection.participants.map((item) => redactGeneric(item as unknown as Record<string, unknown>, options)),
    utxoLineage: selection.utxoLineage.map((item) => redactGeneric(item as unknown as Record<string, unknown>, options)),
    custodySegments: selection.custodySegments.map((item) => redactGeneric(item as unknown as Record<string, unknown>, options)),
    lineageSnapshots: selection.lineageSnapshots.map((item) => redactGeneric(item as unknown as Record<string, unknown>, options)),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] as string));
}

function buildReportHtml(
  manifest: Omit<EvidencePackageManifest, "files" | "manifestSha256" | "attachments"> & {
    attachments: EvidencePackageManifestAttachment[];
  },
  data: ReturnType<typeof redactedSelection>,
): string {
  const redactions = Object.entries(manifest.redaction)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .join(", ") || "None";
  const sections = [
    ["Evidence", data.evidence],
    ["Records", data.records],
    ["Transactions", data.transactions],
    ["Transaction participants", data.participants],
    ["UTXO provenance", data.utxoLineage],
    ["Custody segments", data.custodySegments],
    ["Proof snapshots", data.lineageSnapshots],
  ] as const;
  const body = sections.map(([title, rows]) => `
    <section>
      <h2>${escapeHtml(title)} <small>(${rows.length})</small></h2>
      ${rows.length ? `<pre>${escapeHtml(stableJson(rows))}</pre>` : "<p>None selected.</p>"}
    </section>`).join("");
  const attachmentList = manifest.attachments.length
    ? `<ul>${manifest.attachments.map((item) => `<li>${escapeHtml(item.filename)} — ${item.size} bytes — SHA-256 <code>${item.sha256}</code></li>`).join("")}</ul>`
    : "<p>None selected.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>KYUTXO Evidence Package</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#172033;max-width:1100px;margin:0 auto;padding:32px}
h1{margin-bottom:4px}h2{border-bottom:1px solid #ccd3df;padding-bottom:6px;margin-top:28px}
small{font-weight:400;color:#596579}pre{background:#f4f6f8;border:1px solid #d9dfe8;border-radius:6px;padding:12px;overflow:auto;white-space:pre-wrap}
.notice{background:#fff7df;border:1px solid #e4c66a;padding:12px;border-radius:6px}code{word-break:break-all}
</style></head><body>
<h1>KYUTXO Evidence Package</h1>
<p>Offline evidence report generated ${escapeHtml(new Date(manifest.generatedAt).toISOString())}.</p>
<div class="notice"><strong>Redactions:</strong> ${escapeHtml(redactions)}. This package contains only explicitly selected sources; it does not include the rest of the vault.</div>
<h2>Selection</h2>
<pre>${escapeHtml(stableJson(manifest.sourceIdentifiers))}</pre>
<h2>Attachments <small>(${manifest.attachments.length})</small></h2>${attachmentList}
${body}
</body></html>`;
}

export async function buildEvidencePackage(
  selection: EvidencePackageSelection,
  reader: EvidencePackageAttachmentReader,
  options: EvidencePackageBuildOptions = {},
): Promise<EvidencePackageResult> {
  const checkCancelled = () => {
    if (options.shouldCancel?.()) throw new EvidencePackageError("Export cancelled.");
  };
  checkCancelled();
  const redaction = selection.redaction ?? NO_EVIDENCE_PACKAGE_REDACTION;
  const generatedAt = options.generatedAt ?? Date.now();
  if (!Number.isFinite(generatedAt)) throw new EvidencePackageError("The package timestamp is invalid.");

  const evidenceIds = selection.evidence.map((item) => item.id).filter((id): id is number => id !== undefined).sort((a, b) => a - b);
  const recordIds = selection.records.map((item) => item.id).filter((id): id is number => id !== undefined).sort((a, b) => a - b);
  const transactionIds = selection.transactions.map((item) => item.txid).sort();
  const utxoOutpoints = selection.utxoLineage
    .flatMap((item) => [item.spentTxid != null && item.spentVout != null ? `${item.spentTxid}:${item.spentVout}` : null, item.createdTxid != null && item.createdVout != null ? `${item.createdTxid}:${item.createdVout}` : null])
    .filter((item): item is string => item !== null).sort();
  const custodySegmentIds = selection.custodySegments.map((item) => item.segmentId).sort();
  const lineageSnapshotIds = selection.lineageSnapshots.map((item) => item.snapshotId).sort();

  const selectedEvidenceIds = new Set(evidenceIds);
  const attachments = [...selection.evidenceAttachments].sort((a, b) =>
    `${a.evidenceId}:${a.id ?? 0}:${a.filename}`.localeCompare(`${b.evidenceId}:${b.id ?? 0}:${b.filename}`),
  );
  for (const attachment of attachments) {
    if (!selectedEvidenceIds.has(attachment.evidenceId)) {
      throw new EvidencePackageError(`Attachment "${attachment.filename}" references an unselected evidence item.`);
    }
    validateStoragePath(attachment.objectStoragePath, attachment);
    if (!Number.isFinite(attachment.size) || attachment.size < 0) {
      throw new EvidencePackageError(`Attachment "${attachment.filename}" has invalid size metadata.`);
    }
    if (attachment.size > EVIDENCE_PACKAGE_MAX_ATTACHMENT_BYTES) {
      throw new EvidencePackageError(
        `Attachment "${attachment.filename}" is too large (${attachment.size} bytes; maximum is ${EVIDENCE_PACKAGE_MAX_ATTACHMENT_BYTES} bytes).`,
      );
    }
  }
  const totalMetadataBytes = attachments.reduce((total, item) => total + item.size, 0);
  if (totalMetadataBytes > EVIDENCE_PACKAGE_MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new EvidencePackageError(
      `Selected attachments total ${totalMetadataBytes} bytes; the maximum is ${EVIDENCE_PACKAGE_MAX_TOTAL_ATTACHMENT_BYTES} bytes.`,
    );
  }

  const data = redactedSelection(selection, redaction);
  const orderedData = {
    evidence: [...data.evidence].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    records: [...data.records].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    transactions: [...data.transactions].sort((a, b) => String(a.txid).localeCompare(String(b.txid))),
    participants: [...data.participants].sort((a, b) =>
      `${a.txid}:${a.role}:${a.id ?? 0}`.localeCompare(`${b.txid}:${b.role}:${b.id ?? 0}`),
    ),
    utxoLineage: [...data.utxoLineage].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? ""))),
    custodySegments: [...data.custodySegments].sort((a, b) => String(a.segmentId).localeCompare(String(b.segmentId))),
    lineageSnapshots: [...data.lineageSnapshots].sort((a, b) => String(a.snapshotId).localeCompare(String(b.snapshotId))),
  };
  const dataEntries = [
    ["data/evidence.json", orderedData.evidence],
    ["data/records.json", orderedData.records],
    ["data/transactions.json", orderedData.transactions],
    ["data/participants.json", orderedData.participants],
    ["data/utxo-lineage.json", orderedData.utxoLineage],
    ["data/custody-segments.json", orderedData.custodySegments],
    ["data/lineage-snapshots.json", orderedData.lineageSnapshots],
  ] as const;
  const zip = new JSZip();
  const files: EvidencePackageManifest["files"] = [];
  for (const [index, [path, value]] of dataEntries.entries()) {
    checkCancelled();
    options.onProgress?.("Writing selected data", index + 1, dataEntries.length + attachments.length + 2);
    const bytes = utf8(stableJson(value));
    files.push({ path, kind: "data", size: bytes.length, sha256: await sha256(bytes) });
    zip.file(path, bytes, { date: new Date(0) });
  }

  const manifestBase = {
    packageVersion: EVIDENCE_PACKAGE_VERSION,
    app: "KYUTXO" as const,
    generatedAt,
    offline: true as const,
    redaction,
    sourceIdentifiers: { evidenceIds, recordIds, transactionIds, utxoOutpoints, custodySegmentIds, lineageSnapshotIds },
    counts: {
      evidence: orderedData.evidence.length,
      records: orderedData.records.length,
      transactions: orderedData.transactions.length,
      participants: orderedData.participants.length,
      utxoLineage: orderedData.utxoLineage.length,
      custodySegments: orderedData.custodySegments.length,
      lineageSnapshots: orderedData.lineageSnapshots.length,
      attachments: attachments.length,
    },
  };

  const manifestAttachments: EvidencePackageManifestAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    checkCancelled();
    options.onProgress?.("Hashing selected attachments", dataEntries.length + index + 1, dataEntries.length + attachments.length + 2);
    const raw = await reader.read(attachment);
    checkCancelled();
    const bytes = raw instanceof Blob
      ? new Uint8Array(await raw.arrayBuffer())
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : raw;
    if (bytes.byteLength !== attachment.size) {
      throw new EvidencePackageError(
        `Attachment "${attachment.filename}" is missing or changed (metadata says ${attachment.size} bytes, read ${bytes.byteLength}).`,
      );
    }
    if (bytes.byteLength > EVIDENCE_PACKAGE_MAX_ATTACHMENT_BYTES) {
      throw new EvidencePackageError(`Attachment "${attachment.filename}" exceeds the package size limit.`);
    }
    const path = attachmentPath(attachment);
    const digest = await sha256(bytes);
    manifestAttachments.push({
      id: attachment.id,
      evidenceId: attachment.evidenceId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sourceStoragePath: attachment.objectStoragePath,
      packagePath: path,
      sha256: digest,
    });
    files.push({ path, kind: "attachment", size: bytes.byteLength, sha256: digest });
    zip.file(path, bytes, { date: new Date(0), binary: true });
  }

  const reportHtml = buildReportHtml({ ...manifestBase, attachments: manifestAttachments }, orderedData);
  checkCancelled();
  options.onProgress?.("Writing report and manifest", dataEntries.length + attachments.length + 1, dataEntries.length + attachments.length + 2);
  const reportBytes = utf8(reportHtml);
  files.push({ path: "report.html", kind: "report", size: reportBytes.length, sha256: await sha256(reportBytes) });
  zip.file("report.html", reportBytes, { date: new Date(0) });

  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestWithoutHash = { ...manifestBase, attachments: manifestAttachments, files };
  const manifestSha256 = await sha256(utf8(stableJson(manifestWithoutHash)));
  const manifest: EvidencePackageManifest = { ...manifestWithoutHash, manifestSha256 };
  zip.file("manifest.json", stableJson(manifest), { date: new Date(0) });
  checkCancelled();
  options.onProgress?.("Finalizing ZIP", dataEntries.length + attachments.length + 2, dataEntries.length + attachments.length + 2);
  checkCancelled();
  let cancelledDuringFinalization = false;
  const blob = await zip.generateAsync(
    { type: "blob", compression: "STORE", mimeType: "application/zip" },
    (metadata) => {
      options.onProgress?.("Finalizing ZIP", Math.max(1, Math.round(metadata.percent)), 100);
      // JSZip calls this listener from an event handler outside its promise
      // rejection path. Record cancellation here and reject cleanly once the
      // archive settles instead of throwing an uncaught callback exception.
      if (options.shouldCancel?.()) cancelledDuringFinalization = true;
    },
  );
  if (cancelledDuringFinalization || options.shouldCancel?.()) {
    throw new EvidencePackageError("Export cancelled.");
  }
  return { blob, manifest, reportHtml };
}