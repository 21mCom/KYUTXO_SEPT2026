import { useState, useRef, useEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "wouter";
import { Moon, Eye, Database, Plus, Trash2, Pencil, AlertTriangle, Upload, RefreshCw, Loader2, Paperclip, KeyRound, Shield, Download, Stethoscope, ChevronRight, ChevronDown, Wrench, Search, ArrowRight, Copy } from "lucide-react";
import { isElectron, getElectronAPI } from "@/lib/electron";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  useSettings,
  updateDisableOrphanCheck,
  useCustomFields,
  toggleFieldVisibility,
  addCustomField,
  toggleCustomField,
  deleteCustomField,
  updateCustomField,
  updateCancelConfirmThreshold,
  updatePrivacyHistoryLimit,
  updateFundTrailTxLimit,
} from "@/hooks/use-settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useAuth } from "@/contexts/AuthContext";
import { db, type TrashedAttachment } from "@/lib/database";
import { clearAllRecords } from "@/lib/data/record-crud";
import { getPrivacyAuditHistoryCount } from "@/lib/data/privacy-history-crud";
import { recomputeAddressStats } from "@/lib/data/address-stats";
import { clearTransactions, clearParticipants } from "@/lib/data/transaction-crud";
import { clearUtxoLineage, clearCustodySegments } from "@/lib/data/lineage-crud";
import { clearEvidence, clearEvidenceAttachments } from "@/lib/data/evidence-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import { clearRecordOrigins } from "@/lib/data/record-origins-crud";
import { clearCustomFields } from "@/lib/data/custom-fields-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import { clearPriceData } from "@/lib/data/price-data-crud";
import { clearNodeSettings, getNodeSettings } from "@/lib/data/node-settings-crud";
import {
  restoreNodeSettingsRows,
  restoreSettingsPreferences,
  previewSettingsPreferences,
  type PortablePreferencePreview,
} from "@/lib/backup/inline-tables";
import {
  restoreLegacyRecords,
  restoreLegacyAttachments,
  restoreLegacyTransactions,
  restoreLegacyAddressSyncState,
} from "@/lib/backup/legacy-restore";
import {
  restoreLegacyVocabulary,
  restoreLegacyCustomFields,
  restoreLegacyDerivationTemplates,
  restoreLegacyEvidence,
  restoreLegacyPriceData,
  restoreLegacyLineage,
} from "@/lib/backup/legacy-restore-misc";
import { clearDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { updateSettings } from "@/lib/data/settings-crud";
import {
  prepareEntitySnapshot,
  applyEntitySnapshot,
  resetEntitySnapshot,
  serializeActiveEntityList,
  ENTITY_ERROR_KIND_LABELS,
  type EntitySnapshotError,
  type EntitySnapshotErrorKind,
  type EntitySnapshotWarning,
  type EntitySnapshotPreview,
  type EntityListMode,
  type EntityChange,
  type EntityOverride,
} from "@/lib/data/entity-list-store";
import { getBundledEntityCount, ENTITY_CATEGORY_LABELS, type EntityEntry, type EntityCategory } from "@/lib/privacy-entity-list";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { deriveKey, decrypt, base64ToBuffer, verifyPassword } from "@/lib/crypto";
import { getVaultSettings, vaultDb } from "@/lib/vault";
import { generateSalt, hashPassword, bufferToBase64 } from "@/lib/crypto";
import { migrateAttachmentPaths, auditAttachments, reconcileAttachmentPaths, downloadFile, deleteFile, formatFileSize, type AttachmentAuditResult, type AttachmentReconcileResult } from "@/lib/attachments";
import { getTrashedAttachments, deleteTrashedAttachment } from "@/lib/data/trash-crud";
import { 
  setAttachmentPathsMigrated,
} from "@/lib/vault";
import JSZip from "jszip";
import { peekManifest, restoreV3Backup, RestoreInterruptedError, type AttachmentFileWriter } from "@/lib/backup/restore";
import { BackupCancelledError, downloadBlob } from "@/lib/backup/sink";
import { blobChunks } from "@/lib/backup/zip-stream";
import { isV3Manifest, parseInline } from "@/lib/backup/format";
import VocabularyManager from "@/components/VocabularyManager";
import { AddressLink } from "@/components/AddressLink";
import StripMarkersPanel from "@/components/StripMarkersPanel";
import MigrationAuditPanel from "@/components/MigrationAuditPanel";
import LegacyRecoveryPanel from "@/components/LegacyRecoveryPanel";
import { hasUnrecoveredLegacyData } from "@/lib/legacy-decrypt";
import {
  getSearchFadePreference,
  setSearchFadePreference,
  SEARCH_FADE_OPTIONS,
  type SearchFadeOption,
} from "@/config/debounce";
import { useActivityBus } from "@/lib/activity-bus";
import { detectAndBackfill, detectOrphanedTxRecords, runTxidBackfill, resolveAllBlankInputAddresses, type BackfillResult } from "@/lib/txid-backfill";
import { resetOrphanCheckGate } from "@/lib/orphan-check-session";
import { createProviderFromSettings } from "@/lib/blockchain-api";

const DELETE_CONFIRMATION_PHRASE = "DELETE ALL DATA";

// Lowering the Privacy Audit History limit deletes the oldest runs. When more
// than this many runs would be removed, confirm with the user first so a misclick
// doesn't silently wipe a lot of history.
const PRIVACY_HISTORY_TRIM_CONFIRM_THRESHOLD = 20;

const ENTITY_DIFF_ROW_HEIGHT = 52;
const ENTITY_OVERRIDE_ROW_HEIGHT = 60;
const ENTITY_ERROR_ROW_HEIGHT = 44;

/**
 * Virtualized list of entity entries (address + name + category) shown in the
 * import confirmation dialog so users can inspect exactly which entries are
 * being added or removed. Virtualized so large diffs stay responsive.
 */
function EntityDiffList({
  entries,
  emptyLabel,
  variant,
}: {
  entries: EntityEntry[];
  emptyLabel: string;
  variant: "added" | "removed";
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_DIFF_ROW_HEIGHT,
    overscan: 8,
  });

  if (entries.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground px-3 py-6 text-center"
        data-testid={`text-entity-diff-empty-${variant}`}
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      ref={parentRef}
      className="max-h-64 overflow-y-auto rounded-md border"
      data-testid={`list-entity-diff-${variant}`}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 top-0 w-full border-b px-3 py-1.5 flex items-center justify-between gap-3"
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              data-testid={`row-entity-diff-${variant}-${virtualRow.index}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate" data-testid={`text-entity-diff-name-${variant}-${virtualRow.index}`}>
                  {entry.name}
                </p>
                <p className="text-xs font-mono text-muted-foreground truncate">{entry.address}</p>
              </div>
              <Badge variant="secondary" className="shrink-0">
                {ENTITY_CATEGORY_LABELS[entry.category]}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Virtualized list of entries whose name and/or category changed between the
 * current list and the incoming snapshot. Shows the old value struck through
 * alongside the new value so users can review re-categorizations / renames.
 */
function ChangedEntityList({
  changes,
  emptyLabel,
}: {
  changes: EntityChange[];
  emptyLabel: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: changes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_DIFF_ROW_HEIGHT,
    overscan: 8,
  });

  if (changes.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground px-3 py-6 text-center"
        data-testid="text-entity-diff-empty-changed"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      ref={parentRef}
      className="max-h-64 overflow-y-auto rounded-md border"
      data-testid="list-entity-diff-changed"
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const change = changes[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full border-b px-3 py-1.5"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
              data-testid={`row-entity-diff-changed-${virtualRow.index}`}
            >
              <div className="flex items-center justify-between gap-3 min-w-0">
                <div className="min-w-0">
                  {change.nameChanged ? (
                    <p className="text-sm truncate" data-testid={`text-entity-diff-name-changed-${virtualRow.index}`}>
                      <span className="line-through text-muted-foreground">{change.current.name}</span>
                      <span className="mx-1 text-muted-foreground">→</span>
                      <span className="font-medium">{change.incoming.name}</span>
                    </p>
                  ) : (
                    <p className="text-sm font-medium truncate" data-testid={`text-entity-diff-name-changed-${virtualRow.index}`}>
                      {change.incoming.name}
                    </p>
                  )}
                  <p className="text-xs font-mono text-muted-foreground truncate">{change.address}</p>
                </div>
                {change.categoryChanged ? (
                  <span className="flex items-center gap-1 shrink-0">
                    <Badge variant="outline" className="line-through opacity-70">
                      {ENTITY_CATEGORY_LABELS[change.current.category]}
                    </Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="secondary">
                      {ENTITY_CATEGORY_LABELS[change.incoming.category]}
                    </Badge>
                  </span>
                ) : (
                  <Badge variant="secondary" className="shrink-0">
                    {ENTITY_CATEGORY_LABELS[change.incoming.category]}
                  </Badge>
                )}
              </div>
              {change.sourceNoteChanged && (
                <p
                  className="mt-1 text-xs text-muted-foreground min-w-0"
                  data-testid={`text-entity-diff-sourcenote-changed-${virtualRow.index}`}
                >
                  <span className="mr-1 font-medium">Source:</span>
                  <span className="line-through break-words">
                    {change.current.sourceNote ?? "(none)"}
                  </span>
                  <span className="mx-1">→</span>
                  <span className="text-foreground break-words">
                    {change.incoming.sourceNote ?? "(none)"}
                  </span>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Virtualized list of bundled entries a merge will overwrite, paired with the
 * incoming entry that replaces each. Shows old → new (name + category), and
 * flags identical re-imports as "no change".
 */
function EntityOverrideList({
  overrides,
  emptyLabel,
}: {
  overrides: EntityOverride[];
  emptyLabel: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: overrides.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_OVERRIDE_ROW_HEIGHT,
    overscan: 8,
  });

  if (overrides.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground px-3 py-6 text-center"
        data-testid="text-entity-overrides-empty"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      ref={parentRef}
      className="max-h-64 overflow-y-auto rounded-md border"
      data-testid="list-entity-overrides"
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const { previous, incoming, changed } = overrides[virtualRow.index];
          const sourceNoteChanged =
            (previous.sourceNote ?? "") !== (incoming.sourceNote ?? "");
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full border-b px-3 py-1.5 space-y-1"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
              data-testid={`row-entity-override-${virtualRow.index}`}
            >
              <p className="text-xs font-mono text-muted-foreground truncate">{previous.address}</p>
              <div className="flex items-center gap-2 text-sm min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate text-muted-foreground line-through" title={previous.name}>
                    {previous.name}
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {ENTITY_CATEGORY_LABELS[previous.category]}
                  </Badge>
                </span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium" title={incoming.name}>
                    {incoming.name}
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {ENTITY_CATEGORY_LABELS[incoming.category]}
                  </Badge>
                </span>
                {!changed && (
                  <Badge variant="outline" className="shrink-0">
                    no change
                  </Badge>
                )}
              </div>
              {sourceNoteChanged && (
                <p
                  className="text-xs text-muted-foreground min-w-0"
                  data-testid={`text-entity-override-sourcenote-${virtualRow.index}`}
                >
                  <span className="mr-1 font-medium">Source:</span>
                  <span className="line-through break-words">
                    {previous.sourceNote ?? "(none)"}
                  </span>
                  <span className="mx-1">→</span>
                  <span className="text-foreground break-words">
                    {incoming.sourceNote ?? "(none)"}
                  </span>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Above this many errors the list switches to virtual scrolling. Below it the
 * rows render in normal flow, which keeps the common case simple.
 */
const ENTITY_ERROR_VIRTUALIZE_THRESHOLD = 100;

/**
 * Copy plain text to the clipboard, falling back to a hidden `<textarea>` +
 * `execCommand("copy")` when the async Clipboard API is unavailable or rejects
 * (e.g. an older Electron renderer or a denied permission). Returns whether the
 * copy succeeded so the caller can surface the right toast. Mirrors the fallback
 * used by the printable report copy button.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand fallback below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Render a single error's entry label for copy output: "Entry N" for a
 * 1-based entry position, or "File" for a file-level (index -1) problem.
 */
function entityErrorLabel(err: EntitySnapshotError): string {
  return err.index >= 0 ? `Entry ${err.index + 1}` : "File";
}

/** A single per-entry validation error row (index label + reason). */
function EntityErrorRow({
  err,
  index,
  style,
}: {
  err: EntitySnapshotError;
  index: number;
  style?: React.CSSProperties;
}) {
  const label = entityErrorLabel(err);
  return (
    <div
      className="border-b border-destructive/20 px-3 py-1.5 flex items-start gap-2"
      style={style}
      data-testid={`text-entity-error-${index}`}
    >
      <Badge variant="outline" className="shrink-0 mt-0.5 font-mono">
        {label}
      </Badge>
      <p className="text-sm text-muted-foreground line-clamp-2" title={err.message}>
        {err.message}
      </p>
    </div>
  );
}

/** A kind of error paired with all the entries that hit that kind. */
interface EntityErrorGroup {
  kind: EntitySnapshotErrorKind;
  label: string;
  errors: EntitySnapshotError[];
}

/**
 * Bucket a flat list of validation errors by their stable `kind`, preserving
 * first-seen order of each kind, then sort groups by descending count so the
 * most common problems (the ones worth fixing first) bubble to the top.
 */
function groupEntityErrors(errors: EntitySnapshotError[]): EntityErrorGroup[] {
  const groups = new Map<EntitySnapshotErrorKind, EntitySnapshotError[]>();
  for (const err of errors) {
    const existing = groups.get(err.kind);
    if (existing) {
      existing.push(err);
    } else {
      groups.set(err.kind, [err]);
    }
  }
  return Array.from(groups.entries())
    .map(([kind, errs]) => ({ kind, label: ENTITY_ERROR_KIND_LABELS[kind], errors: errs }))
    .sort((a, b) => b.errors.length - a.errors.length);
}

/**
 * Validation errors shown when a hand-edited entity-list import fails, grouped
 * by problem type (e.g. "Unknown category", "Invalid Bitcoin address") with a
 * per-group count. Each group collapses by default so a file with many similar
 * mistakes is fast to triage; expanding a group reveals the individual
 * offending entries (their 1-based position + specific reason). Large groups
 * keep the existing virtual scrolling so hundreds of bad entries stay
 * responsive.
 */
function EntityErrorList({ errors }: { errors: EntitySnapshotError[] }) {
  const allGroups = useMemo(() => groupEntityErrors(errors), [errors]);
  const [kindFilter, setKindFilter] = useState<EntitySnapshotErrorKind | "all">("all");
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  // A purely-numeric query is treated as "jump to entry #N" (1-based, matching
  // the row labels); anything else is a free-text match on the error message.
  const entryNumber = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
  const lowerQuery = trimmed.toLowerCase();
  const filterActive = trimmed.length > 0 || kindFilter !== "all";

  const groups = useMemo(() => {
    return allGroups
      .filter((group) => kindFilter === "all" || group.kind === kindFilter)
      .map((group) => {
        if (!trimmed) return group;
        const matched = group.errors.filter((err) =>
          entryNumber !== null
            ? err.index + 1 === entryNumber
            : err.message.toLowerCase().includes(lowerQuery),
        );
        return { ...group, errors: matched };
      })
      .filter((group) => group.errors.length > 0);
  }, [allGroups, kindFilter, trimmed, entryNumber, lowerQuery]);

  const totalMatches = useMemo(
    () => groups.reduce((sum, group) => sum + group.errors.length, 0),
    [groups],
  );
  // When the user is actively filtering, open every matching group so the
  // results are visible without extra clicks; otherwise only auto-open a lone
  // group (nothing to triage between).
  const autoOpen = filterActive || groups.length === 1;

  return (
    <div className="space-y-2" data-testid="list-entity-errors">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to entry # or filter by reason…"
            className="pl-8"
            data-testid="input-entity-error-filter"
          />
        </div>
        <Select
          value={kindFilter}
          onValueChange={(value) => setKindFilter(value as EntitySnapshotErrorKind | "all")}
        >
          <SelectTrigger className="w-[12rem]" data-testid="select-entity-error-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All problem types</SelectItem>
            {allGroups.map((group) => (
              <SelectItem key={group.kind} value={group.kind}>
                {group.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filterActive && (
        <p className="text-sm text-muted-foreground" data-testid="text-entity-error-match-count">
          {totalMatches === 0
            ? "No matching entries."
            : `${totalMatches.toLocaleString()} matching ${totalMatches === 1 ? "entry" : "entries"}.`}
        </p>
      )}
      {groups.map((group) => (
        <EntityErrorGroupItem
          key={group.kind}
          group={group}
          defaultOpen={autoOpen}
        />
      ))}
    </div>
  );
}

/** A single collapsible problem-type group with its count and offending rows. */
function EntityErrorGroupItem({
  group,
  defaultOpen,
}: {
  group: EntityErrorGroup;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { toast } = useToast();
  // Re-open when filtering forces groups open (defaultOpen flips to true) so
  // matched results appear without the user re-expanding each group by hand.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const count = group.errors.length;

  // Copy actions operate on the full `group.errors` array, not just the rows
  // currently rendered, so they cover large virtual-scrolled groups in full.
  // The "json" action copies the raw offending entries (address/name/category/
  // sourceNote) as a valid JSON array so users can fix or remove them without
  // re-finding each line in their source file. Entries that pre-date raw-entry
  // capture (or structure-level errors not tied to an entry) carry no
  // `rawEntry`, so only those that actually have one are exported.
  const entriesWithRaw = group.errors.filter((err) => "rawEntry" in err);
  const handleCopy = async (what: "numbers" | "details" | "json") => {
    let text: string;
    if (what === "numbers") {
      text = group.errors.map((err) => entityErrorLabel(err)).join("\n");
    } else if (what === "details") {
      text = group.errors.map((err) => `${entityErrorLabel(err)}: ${err.message}`).join("\n");
    } else {
      text = JSON.stringify(entriesWithRaw.map((err) => err.rawEntry), null, 2);
    }
    const ok = await copyTextToClipboard(text);
    const jsonCount = entriesWithRaw.length;
    toast({
      title: ok ? "Copied to clipboard" : "Copy failed",
      description: ok
        ? what === "numbers"
          ? `${count.toLocaleString()} entry ${count === 1 ? "number" : "numbers"} copied — paste to search your source file.`
          : what === "details"
            ? `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"} with reasons copied.`
            : `${jsonCount.toLocaleString()} ${jsonCount === 1 ? "entry" : "entries"} copied as JSON.`
        : "Couldn't access the clipboard. Try selecting the text manually.",
      variant: ok ? undefined : "destructive",
    });
  };

  // Saves the raw offending entries to a JSON file so large error groups can be
  // fixed and re-imported without the awkwardness of a giant clipboard paste.
  // The error kind is in the filename so downloading several groups never
  // overwrites a previous file.
  const handleDownload = () => {
    const text = JSON.stringify(entriesWithRaw.map((err) => err.rawEntry), null, 2);
    const blob = new Blob([text], { type: "application/json" });
    downloadBlob(blob, `entity-import-errors-${group.kind}.json`);
    const jsonCount = entriesWithRaw.length;
    toast({
      title: "Download started",
      description: `${jsonCount.toLocaleString()} ${jsonCount === 1 ? "entry" : "entries"} saved as JSON.`,
    });
  };

  return (
    <div
      className="rounded-md border border-destructive/40 overflow-hidden"
      data-testid={`group-entity-error-${group.kind}`}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover-elevate"
        aria-expanded={open}
        data-testid={`button-entity-error-group-${group.kind}`}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium flex-1">{group.label}</span>
        <Badge variant="secondary" className="shrink-0" data-testid={`badge-entity-error-count-${group.kind}`}>
          {count.toLocaleString()}
        </Badge>
      </button>
      {open && (
        <div className="border-t border-destructive/40">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-destructive/40">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleCopy("numbers")}
              data-testid={`button-copy-entity-error-numbers-${group.kind}`}
            >
              <Copy className="h-4 w-4" />
              Copy entry numbers
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleCopy("details")}
              data-testid={`button-copy-entity-error-details-${group.kind}`}
            >
              <Copy className="h-4 w-4" />
              Copy entries with reasons
            </Button>
            {entriesWithRaw.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleCopy("json")}
                data-testid={`button-copy-entity-error-json-${group.kind}`}
              >
                <Copy className="h-4 w-4" />
                Copy entries (JSON)
              </Button>
            )}
            {entriesWithRaw.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleDownload}
                data-testid={`button-download-entity-error-json-${group.kind}`}
              >
                <Download className="h-4 w-4" />
                Download entries (JSON)
              </Button>
            )}
          </div>
          {count <= ENTITY_ERROR_VIRTUALIZE_THRESHOLD ? (
            <div className="max-h-64 overflow-y-auto">
              {group.errors.map((err, i) => (
                <EntityErrorRow key={i} err={err} index={i} />
              ))}
            </div>
          ) : (
            <VirtualizedEntityErrorList errors={group.errors} />
          )}
        </div>
      )}
    </div>
  );
}

/** Virtual-scrolling variant for a large group of errors. */
function VirtualizedEntityErrorList({ errors }: { errors: EntitySnapshotError[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: errors.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_ERROR_ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="max-h-64 overflow-y-auto">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <EntityErrorRow
            key={virtualRow.key}
            err={errors[virtualRow.index]}
            index={virtualRow.index}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, fieldVisibility, cancelConfirmThreshold, privacyHistoryLimit, disableOrphanCheck, fundTrailTxLimit, isLoading: settingsLoading } = useSettings();
  const { customFields, isLoading: customFieldsLoading } = useCustomFields();
  const { toast } = useToast();

  // Privacy entity list import state
  const entitySnapshot = settings?.entityListSnapshot;
  const bundledEntityCount = getBundledEntityCount();
  const [isImportingEntities, setIsImportingEntities] = useState(false);
  const [isResettingEntities, setIsResettingEntities] = useState(false);
  const [entityImportErrors, setEntityImportErrors] = useState<EntitySnapshotError[] | null>(null);
  const [entityImportWarnings, setEntityImportWarnings] = useState<EntitySnapshotWarning[]>([]);
  const [entityPreview, setEntityPreview] = useState<EntitySnapshotPreview | null>(null);
  const [entityPreviewSource, setEntityPreviewSource] = useState<string | undefined>(undefined);
  const [showEntityDiff, setShowEntityDiff] = useState(false);
  const [overridesOnlyChanged, setOverridesOnlyChanged] = useState(false);
  const [entityDiffSearch, setEntityDiffSearch] = useState("");
  const [entityDiffCategory, setEntityDiffCategory] = useState<EntityCategory | "all">("all");
  const [isApplyingEntities, setIsApplyingEntities] = useState(false);
  const [entityImportMode, setEntityImportMode] = useState<EntityListMode>("replace");
  const entityFileInputRef = useRef<HTMLInputElement>(null);
  
  const [newFieldName, setNewFieldName] = useState("");
  const [isAddingField, setIsAddingField] = useState(false);
  const [editingField, setEditingField] = useState<{ id: number; name: string } | null>(null);
  const [deletingFieldId, setDeletingFieldId] = useState<number | null>(null);
  
  // Clear database state
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearPassword, setClearPassword] = useState("");
  const [clearPhrase, setClearPhrase] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  
  // Restore state
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreMode, setRestoreMode] = useState<"replace" | "merge">("replace");
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [backupInfo, setBackupInfo] = useState<{ encrypted: boolean; date: string; recordCount: number } | null>(null);
  // Cancel support for the v3 streaming restore. `restoreCancellable` gates the
  // cancel button (the legacy whole-file path has no abort point). `clearedRef`
  // tracks the point of no return — once the destructive clear runs, cancelling
  // can no longer keep the existing vault, so we warn before allowing it.
  const [restoreCancellable, setRestoreCancellable] = useState(false);
  const [showCancelRestoreConfirm, setShowCancelRestoreConfirm] = useState(false);
  // Confirmation before lowering the Privacy Audit History limit when a large
  // number of runs would be deleted, so a misclick doesn't silently wipe a lot
  // of history. Holds the pending new limit and how many runs would be removed.
  const [pendingHistoryTrim, setPendingHistoryTrim] = useState<
    { limit: number; removeCount: number } | null
  >(null);
  // Two-stage restore for v3 backups: "configure" (pick file/password/mode) then
  // "confirm" (review which portable preferences the backup will carry over,
  // before the destructive restore runs). `prefPreview` is computed without
  // touching the vault.
  const [restoreStage, setRestoreStage] = useState<"configure" | "confirm">("configure");
  const [prefPreview, setPrefPreview] = useState<PortablePreferencePreview[] | null>(null);
  const restoreAbortRef = useRef<AbortController | null>(null);
  const restoreClearedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [changePasswordDialogOpen, setChangePasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isMigratingAttachments, setIsMigratingAttachments] = useState(false);
  const [isAuditingAttachments, setIsAuditingAttachments] = useState(false);
  const [attachmentAudit, setAttachmentAudit] = useState<AttachmentAuditResult | null>(null);
  const [isRepairingAttachments, setIsRepairingAttachments] = useState(false);
  const [attachmentRepair, setAttachmentRepair] = useState<AttachmentReconcileResult | null>(null);
  const [trashList, setTrashList] = useState<TrashedAttachment[] | null>(null);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  const [isPurgingTrash, setIsPurgingTrash] = useState(false);
  const [showEmptyTrashDialog, setShowEmptyTrashDialog] = useState(false);

  // Recompute address stats state
  const [isRecomputingStats, setIsRecomputingStats] = useState(false);
  const [recomputeProgress, setRecomputeProgress] = useState(0);
  const [recomputeMessage, setRecomputeMessage] = useState("");
  const recomputeAbortRef = useRef<AbortController | null>(null);

  const [searchFadeIntensity, setSearchFadeIntensity] = useState<SearchFadeOption>(getSearchFadePreference);
  const [, setIsStripRunning] = useState(false);
  const { monitorEnabled, setMonitorEnabled } = useActivityBus();

  // Txid backfill state (post-restore and manual)
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState(0);
  const [backfillMessage, setBackfillMessage] = useState("");
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const backfillAbortRef = useRef<AbortController | null>(null);
  const rebuildSectionRef = useRef<HTMLDivElement | null>(null);

  // Resolve blank input addresses (whole-database one-off pass) state
  const [isResolvingInputs, setIsResolvingInputs] = useState(false);
  const [resolveInputsProgress, setResolveInputsProgress] = useState(0);
  const [resolveInputsMessage, setResolveInputsMessage] = useState("");
  const resolveInputsAbortRef = useRef<AbortController | null>(null);

  const handleToggleBuiltInField = async (field: keyof typeof fieldVisibility) => {
    try {
      await toggleFieldVisibility(field);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update field visibility",
        variant: "destructive",
      });
    }
  };

  const handleEntityFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file fires the change event again.
    e.target.value = "";
    if (!file) return;

    setEntityImportErrors(null);
    setEntityImportWarnings([]);
    setEntityPreview(null);
    setIsImportingEntities(true);
    try {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("File is not valid JSON.");
      }

      const result = prepareEntitySnapshot(raw, entityImportMode);
      if (!result.valid || !result.preview) {
        setEntityImportErrors(result.errors);
        toast({
          title: "Import failed",
          description: `${result.errors.length} problem${result.errors.length === 1 ? "" : "s"} found. No changes were made.`,
          variant: "destructive",
        });
        return;
      }

      // Valid — stage a preview and wait for explicit confirmation. Any
      // non-fatal warnings (e.g. a source note that cites a different address)
      // are surfaced alongside the preview so the user can review before applying.
      setEntityPreviewSource(file.name);
      setShowEntityDiff(false);
      setEntityDiffSearch("");
      setEntityDiffCategory("all");
      setEntityImportWarnings(result.warnings);
      setEntityPreview(result.preview);
    } catch (error: any) {
      toast({
        title: "Import failed",
        description: error?.message || "Could not read the file.",
        variant: "destructive",
      });
    } finally {
      setIsImportingEntities(false);
    }
  };

  const handleConfirmEntityImport = async () => {
    if (!entityPreview) return;
    setIsApplyingEntities(true);
    try {
      const activeCount = await applyEntitySnapshot(
        entityPreview.entries,
        entityPreviewSource,
        entityImportMode,
      );
      toast({
        title: "Entity list updated",
        description:
          entityImportMode === "merge"
            ? `Merged ${entityPreview.incomingCount.toLocaleString()} imported entries with the bundled list — ${activeCount.toLocaleString()} entries now active for Privacy Audit.`
            : `Now using ${entityPreview.incomingCount.toLocaleString()} imported entries for Privacy Audit.`,
      });
      setEntityPreview(null);
      setEntityPreviewSource(undefined);
      setEntityImportWarnings([]);
    } catch (error: any) {
      toast({
        title: "Import failed",
        description: error?.message || "Could not apply the snapshot.",
        variant: "destructive",
      });
    } finally {
      setIsApplyingEntities(false);
    }
  };

  const handleCancelEntityImport = () => {
    setEntityPreview(null);
    setEntityPreviewSource(undefined);
    setEntityDiffSearch("");
    setEntityDiffCategory("all");
    setEntityImportWarnings([]);
  };

  const filteredAddedEntries = useMemo(() => {
    const q = entityDiffSearch.trim().toLowerCase();
    const entries = entityPreview?.addedEntries ?? [];
    return entries.filter(
      (e) =>
        (entityDiffCategory === "all" || e.category === entityDiffCategory) &&
        (!q ||
          e.address.toLowerCase().includes(q) ||
          e.name.toLowerCase().includes(q)),
    );
  }, [entityPreview, entityDiffSearch, entityDiffCategory]);

  const filteredRemovedEntries = useMemo(() => {
    const q = entityDiffSearch.trim().toLowerCase();
    const entries = entityPreview?.removedEntries ?? [];
    return entries.filter(
      (e) =>
        (entityDiffCategory === "all" || e.category === entityDiffCategory) &&
        (!q ||
          e.address.toLowerCase().includes(q) ||
          e.name.toLowerCase().includes(q)),
    );
  }, [entityPreview, entityDiffSearch, entityDiffCategory]);

  const filteredChangedEntries = useMemo(() => {
    const q = entityDiffSearch.trim().toLowerCase();
    const changes = entityPreview?.changedEntries ?? [];
    return changes.filter(
      (c) =>
        (entityDiffCategory === "all" ||
          c.current.category === entityDiffCategory ||
          c.incoming.category === entityDiffCategory) &&
        (!q ||
          c.address.toLowerCase().includes(q) ||
          c.current.name.toLowerCase().includes(q) ||
          c.incoming.name.toLowerCase().includes(q)),
    );
  }, [entityPreview, entityDiffSearch, entityDiffCategory]);

  const searchedOverrides = useMemo(() => {
    const q = entityDiffSearch.trim().toLowerCase();
    const overrides = entityPreview?.overrides ?? [];
    return overrides.filter(
      (o) =>
        (entityDiffCategory === "all" ||
          o.incoming.category === entityDiffCategory ||
          o.previous.category === entityDiffCategory) &&
        (!q ||
          o.incoming.address.toLowerCase().includes(q) ||
          o.incoming.name.toLowerCase().includes(q) ||
          o.previous.name.toLowerCase().includes(q)),
    );
  }, [entityPreview, entityDiffSearch, entityDiffCategory]);

  const changedOverrideCount = useMemo(
    () => searchedOverrides.filter((o) => o.changed).length,
    [searchedOverrides],
  );

  const filteredOverrides = useMemo(
    () => (overridesOnlyChanged ? searchedOverrides.filter((o) => o.changed) : searchedOverrides),
    [searchedOverrides, overridesOnlyChanged],
  );

  const entityDiffCategoryCounts = useMemo(() => {
    const counts = {} as Record<EntityCategory, number>;
    let total = 0;
    if (!entityPreview) return { counts, total };
    const bump = (cats: EntityCategory[]) => {
      for (const c of Array.from(new Set(cats))) {
        counts[c] = (counts[c] ?? 0) + 1;
      }
      total += 1;
    };
    if (entityPreview.mode === "merge") {
      for (const o of entityPreview.overrides) bump([o.previous.category, o.incoming.category]);
      for (const e of entityPreview.addedEntries) bump([e.category]);
    } else {
      for (const e of entityPreview.addedEntries) bump([e.category]);
      for (const e of entityPreview.removedEntries) bump([e.category]);
      for (const c of entityPreview.changedEntries) bump([c.current.category, c.incoming.category]);
    }
    return { counts, total };
  }, [entityPreview]);

  const entityDiffCategoryOptions = useMemo(
    () => (
      <>
        <SelectItem value="all" data-testid="option-entity-diff-category-all">
          All categories ({entityDiffCategoryCounts.total.toLocaleString()})
        </SelectItem>
        {Object.entries(ENTITY_CATEGORY_LABELS).map(([value, label]) => {
          const count = entityDiffCategoryCounts.counts[value as EntityCategory] ?? 0;
          return (
            <SelectItem
              key={value}
              value={value}
              disabled={count === 0}
              data-testid={`option-entity-diff-category-${value}`}
            >
              {label} ({count.toLocaleString()})
            </SelectItem>
          );
        })}
      </>
    ),
    [entityDiffCategoryCounts],
  );

  const entityDiffFiltering = entityDiffSearch.trim().length > 0 || entityDiffCategory !== "all";

  const handleResetEntities = async () => {
    setIsResettingEntities(true);
    try {
      await resetEntitySnapshot();
      setEntityImportErrors(null);
      toast({
        title: "Reverted to bundled list",
        description: `Privacy Audit is using the bundled list of ${bundledEntityCount.toLocaleString()} entries again.`,
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to revert to the bundled list",
        variant: "destructive",
      });
    } finally {
      setIsResettingEntities(false);
    }
  };

  const handleExportEntities = () => {
    try {
      const json = serializeActiveEntityList();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "kyutxo-entity-list.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast({
        title: "Error",
        description: "Failed to export the entity list",
        variant: "destructive",
      });
    }
  };

  const handleAddCustomField = async () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) {
      toast({
        title: "Error",
        description: "Please enter a field name",
        variant: "destructive",
      });
      return;
    }

    try {
      await addCustomField(trimmedName);
      setNewFieldName("");
      setIsAddingField(false);
      toast({
        title: "Success",
        description: `Custom field "${trimmedName}" added`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to add custom field",
        variant: "destructive",
      });
    }
  };

  const handleToggleCustomField = async (id: number) => {
    try {
      await toggleCustomField(id);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to toggle custom field",
        variant: "destructive",
      });
    }
  };

  const handleUpdateCustomField = async () => {
    if (!editingField) return;
    
    const trimmedName = editingField.name.trim();
    if (!trimmedName) {
      toast({
        title: "Error",
        description: "Please enter a field name",
        variant: "destructive",
      });
      return;
    }

    try {
      await updateCustomField(editingField.id, { name: trimmedName });
      setEditingField(null);
      toast({
        title: "Success",
        description: "Custom field updated",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to update custom field",
        variant: "destructive",
      });
    }
  };

  const handleDeleteCustomField = async () => {
    if (deletingFieldId === null) return;
    
    try {
      await deleteCustomField(deletingFieldId);
      setDeletingFieldId(null);
      toast({
        title: "Success",
        description: "Custom field deleted",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete custom field",
        variant: "destructive",
      });
    }
  };

  // Clear database handler
  const handleClearDatabase = async () => {
    if (clearPhrase !== DELETE_CONFIRMATION_PHRASE) {
      toast({
        variant: "destructive",
        title: "Incorrect Phrase",
        description: `Please type "${DELETE_CONFIRMATION_PHRASE}" exactly to confirm.`,
      });
      return;
    }

    setIsClearing(true);
    try {
      // Verify password
      const settings = await getVaultSettings();
      if (!settings) {
        throw new Error("Vault not initialized");
      }

      const salt = base64ToBuffer(settings.salt);
      const isValid = await verifyPassword(clearPassword, salt, settings.passwordHash);

      if (!isValid) {
        toast({
          variant: "destructive",
          title: "Invalid Password",
          description: "The password you entered is incorrect.",
        });
        setIsClearing(false);
        return;
      }

      await clearAllRecords({ skipNotification: true });
      await db.tags.clear();
      await db.categories.clear();
      await clearAttachments({ skipNotification: true });
      await clearRecordOrigins({ skipNotification: true });
      await clearCustomFields({ skipNotification: true });
      
      // Clear blockchain sync data
      await clearTransactions({ skipNotification: true });
      await clearParticipants({ skipNotification: true });
      await clearAddressSyncState({ skipNotification: true });
      
      // Clear vocabulary tables
      await db.owners.clear();
      await db.walletNames.clear();
      await db.seedNames.clear();
      await db.walletSoftware.clear();
      
      // Clear price data
      await clearPriceData({ skipNotification: true });

      // Reset settings to defaults (but keep them)
      await updateSettings('default', {
        fieldVisibility: {
          seedName: true,
          walletSoftware: true,
          privateKeyStatus: false,
          owner: true,
          walletName: true,
          source: true,
        },
        tableColumns: {
          tags: true,
          categories: false,
          walletSoftware: false,
          seedName: false,
          privateKeyStatus: false,
          hasAttachments: true,
          owner: false,
          walletName: false,
          firstSeen: false,
          balance: false,
          lastTxDate: false,
          txCount: false,
          source: false,
        },
        customFieldColumns: {},
        cancelConfirmThreshold: 75,
        privacyHistoryLimit: 30,
      });

      setClearDialogOpen(false);
      setClearPassword("");
      setClearPhrase("");
      
      toast({
        title: "Database Cleared",
        description: "All records, blockchain data, vocabularies, and attachments have been deleted.",
      });

      // Reload the page to reset all state
      window.location.reload();
    } catch (error) {
      console.error("Failed to clear database:", error);
      toast({
        variant: "destructive",
        title: "Clear Failed",
        description: error instanceof Error ? error.message : "Failed to clear database",
      });
    } finally {
      setIsClearing(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast({
        variant: "destructive",
        title: "Missing Information",
        description: "Please fill in all password fields.",
      });
      return;
    }

    if (newPassword !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Passwords Don't Match",
        description: "New password and confirmation must match.",
      });
      return;
    }

    if (newPassword.length < 8) {
      toast({
        variant: "destructive",
        title: "Password Too Short",
        description: "New password must be at least 8 characters.",
      });
      return;
    }

    setIsChangingPassword(true);

    try {
      const settings = await getVaultSettings();
      if (!settings) {
        throw new Error("Vault settings not found");
      }

      const salt = base64ToBuffer(settings.salt);
      const isValid = await verifyPassword(currentPassword, salt, settings.passwordHash);

      if (!isValid) {
        toast({
          variant: "destructive",
          title: "Invalid Password",
          description: "Current password is incorrect.",
        });
        setIsChangingPassword(false);
        return;
      }

      // Guard: some records may still hold legacy encrypted payloads that were
      // locked with the CURRENT password's key. Changing the password regenerates
      // the salt/hash, so those payloads could never be unlocked again. Block the
      // change until the user runs "Restore Locked Data" first.
      const hasLocked = await hasUnrecoveredLegacyData();
      if (hasLocked) {
        toast({
          variant: "destructive",
          title: "Unlock Your Data First",
          description:
            'Some records are still locked. Run "Restore Locked Data" in Settings before changing your password, otherwise that locked data would become permanently unreadable.',
        });
        setIsChangingPassword(false);
        return;
      }

      const newSalt = generateSalt();
      const newHash = await hashPassword(newPassword, newSalt);
      const newSaltBase64 = bufferToBase64(newSalt);

      await vaultDb.vault.update('main', { salt: newSaltBase64, passwordHash: newHash });

      toast({
        title: "Password Changed",
        description: "Password updated successfully.",
      });

      setChangePasswordDialogOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      console.error("Failed to change password:", error);
      toast({
        variant: "destructive",
        title: "Password Change Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleManualAttachmentMigration = async () => {
    setIsMigratingAttachments(true);
    try {
      await setAttachmentPathsMigrated(false);
      const result = await migrateAttachmentPaths((current, total, message) => {
        console.log(`[Migration] ${message}`);
      });
      if (result.failed === 0 && result.migrated > 0) {
        await setAttachmentPathsMigrated(true);
        toast({
          title: "Migration Complete",
          description: `Successfully migrated ${result.migrated} attachment path${result.migrated > 1 ? 's' : ''} to hashed names.`,
        });
      } else if (result.failed > 0) {
        toast({
          variant: "destructive",
          title: "Migration Partially Failed",
          description: `Migrated ${result.migrated} path${result.migrated !== 1 ? 's' : ''}, but ${result.failed} failed. Check browser console for details. Try again or check file permissions.`,
        });
      } else if (result.migrated === 0) {
        await setAttachmentPathsMigrated(true);
        toast({
          title: "No Migration Needed",
          description: "All attachment paths are already using hashed names, or no attachments exist in the database.",
        });
      }
    } catch (error) {
      console.error("Manual attachment migration failed:", error);
      toast({
        variant: "destructive",
        title: "Migration Failed",
        description: error instanceof Error ? error.message : "An error occurred during migration.",
      });
    } finally {
      setIsMigratingAttachments(false);
    }
  };

  const handleAuditAttachments = async () => {
    setIsAuditingAttachments(true);
    try {
      const result = await auditAttachments();
      setAttachmentAudit(result);
      const issues = result.missingFiles.length + result.orphanedFiles.length;
      toast({
        title: issues === 0 ? "Audit Complete — All Good" : "Audit Complete",
        description:
          issues === 0
            ? `All ${result.matched} attachment${result.matched !== 1 ? "s" : ""} on record match a file on disk.`
            : `${result.matched} matched, ${result.missingFiles.length} missing file${result.missingFiles.length !== 1 ? "s" : ""}, ${result.orphanedFiles.length} unreferenced file${result.orphanedFiles.length !== 1 ? "s" : ""}.`,
      });
    } catch (error) {
      console.error("Attachment audit failed:", error);
      toast({
        variant: "destructive",
        title: "Audit Failed",
        description: error instanceof Error ? error.message : "An error occurred during the audit.",
      });
    } finally {
      setIsAuditingAttachments(false);
    }
  };

  const handleRepairAttachmentLinks = async () => {
    setIsRepairingAttachments(true);
    try {
      const result = await reconcileAttachmentPaths((current, total, message) => {
        console.log(`[Repair] ${message}`);
      });
      setAttachmentRepair(result);
      if (result.repaired === 0 && result.unresolved === 0) {
        toast({
          title: "Nothing to repair",
          description: "All attachments already point to a file on disk.",
        });
      } else if (result.unresolved === 0) {
        toast({
          title: "Repair complete",
          description: `Reconnected ${result.repaired} attachment${result.repaired !== 1 ? "s" : ""} to ${result.repaired !== 1 ? "their" : "its"} file on disk.`,
        });
      } else {
        toast({
          variant: result.repaired > 0 ? "default" : "destructive",
          title: result.repaired > 0 ? "Repair partially complete" : "Some attachments couldn't be repaired",
          description: `Reconnected ${result.repaired}, but ${result.unresolved} file${result.unresolved !== 1 ? "s" : ""} could not be found on disk. Run "Check" for details, or restore from a backup.`,
        });
      }
    } catch (error) {
      console.error("Attachment repair failed:", error);
      toast({
        variant: "destructive",
        title: "Repair Failed",
        description: error instanceof Error ? error.message : "An error occurred during repair.",
      });
    } finally {
      setIsRepairingAttachments(false);
    }
  };

  const handleLoadTrash = async () => {
    setIsLoadingTrash(true);
    try {
      const items = await getTrashedAttachments();
      setTrashList(items);
    } catch (error) {
      console.error("Failed to load deleted attachments:", error);
      toast({
        variant: "destructive",
        title: "Could Not Load",
        description: error instanceof Error ? error.message : "Failed to load deleted attachments.",
      });
    } finally {
      setIsLoadingTrash(false);
    }
  };

  const handleDownloadTrashed = async (item: TrashedAttachment) => {
    try {
      await downloadFile(item.objectStoragePath, item.filename);
    } catch (error) {
      console.error("Failed to download deleted attachment:", error);
      toast({
        variant: "destructive",
        title: "Download Failed",
        description:
          error instanceof Error ? error.message : "The file may have already been permanently removed.",
      });
    }
  };

  const handlePurgeTrashed = async (item: TrashedAttachment) => {
    try {
      await deleteFile(item.objectStoragePath);
      await deleteTrashedAttachment(item.id!);
      setTrashList((prev) => (prev ? prev.filter((t) => t.id !== item.id) : prev));
      toast({
        title: "File Permanently Removed",
        description: `${item.filename} was deleted from disk.`,
      });
    } catch (error) {
      console.error("Failed to purge deleted attachment:", error);
      toast({
        variant: "destructive",
        title: "Could Not Remove File",
        description: error instanceof Error ? error.message : "An error occurred while removing the file.",
      });
    }
  };

  const handleEmptyTrash = async () => {
    setShowEmptyTrashDialog(false);
    setIsPurgingTrash(true);
    try {
      const items = trashList ?? (await getTrashedAttachments());
      let removed = 0;
      for (const item of items) {
        try {
          await deleteFile(item.objectStoragePath);
          await deleteTrashedAttachment(item.id!, { skipNotification: true });
          removed++;
        } catch (error) {
          console.error("Failed to purge", item.objectStoragePath, error);
        }
      }
      const remaining = await getTrashedAttachments();
      setTrashList(remaining);
      toast({
        title: "Trash Emptied",
        description: `Permanently removed ${removed.toLocaleString()} file${removed === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      console.error("Failed to empty trash:", error);
      toast({
        variant: "destructive",
        title: "Could Not Empty Trash",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsPurgingTrash(false);
    }
  };

  const handleRecomputeStats = async () => {
    const controller = new AbortController();
    recomputeAbortRef.current = controller;
    setIsRecomputingStats(true);
    setRecomputeProgress(0);
    setRecomputeMessage("Preparing...");
    try {
      const result = await recomputeAddressStats({
        origin: "user",
        signal: controller.signal,
        onProgress: ({ processed, total }) => {
          const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
          setRecomputeProgress(pct);
          setRecomputeMessage(
            total > 0
              ? `Processed ${processed.toLocaleString()} of ${total.toLocaleString()} addresses...`
              : "No address records to process.",
          );
        },
      });
      if (result.cancelled) {
        toast({
          title: "Recompute Cancelled",
          description: `Stopped after updating ${result.updated.toLocaleString()} address${result.updated !== 1 ? "es" : ""}.`,
        });
      } else {
        toast({
          title: "Stats Recomputed",
          description: `Updated cached stats for ${result.updated.toLocaleString()} address${result.updated !== 1 ? "es" : ""}.`,
        });
      }
    } catch (error) {
      console.error("Recompute address stats failed:", error);
      toast({
        variant: "destructive",
        title: "Recompute Failed",
        description: error instanceof Error ? error.message : "An error occurred while recomputing stats.",
      });
    } finally {
      recomputeAbortRef.current = null;
      setIsRecomputingStats(false);
      setRecomputeProgress(0);
      setRecomputeMessage("");
    }
  };

  const handleCancelRecompute = () => {
    recomputeAbortRef.current?.abort();
    setRecomputeMessage("Cancelling...");
  };

  // Manual backfill: detect orphaned txids and fetch their on-chain data
  const handleManualBackfill = async () => {
    const controller = new AbortController();
    backfillAbortRef.current = controller;
    setIsBackfilling(true);
    setBackfillProgress(0);
    setBackfillMessage("Scanning for orphaned transaction records...");
    setBackfillResult(null);

    try {
      const result = await detectAndBackfill({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'scanning') {
            setBackfillProgress(2);
            setBackfillMessage("Scanning for orphaned transaction records...");
          } else if (p.phase === 'fetching') {
            const pct = p.orphansFound > 0
              ? Math.round(4 + (p.processed / p.orphansFound) * 94)
              : 98;
            setBackfillProgress(pct);
            setBackfillMessage(
              `Rebuilding ${p.processed.toLocaleString()} of ${p.orphansFound.toLocaleString()} transactions...`
            );
          } else if (p.phase === 'resolving') {
            if (p.fetchTotal && p.fetchTotal > 0) {
              // Fetch sub-phase occupies the first half of the resolving bar.
              const pct = Math.round((p.fetchProcessed ?? 0) / p.fetchTotal * 50);
              setBackfillProgress(pct);
              setBackfillMessage(
                `Fetching previous transactions... ${(p.fetchProcessed ?? 0).toLocaleString()} of ${p.fetchTotal.toLocaleString()}`
              );
            } else if (p.resolveTotal && p.resolveTotal > 0) {
              // Write sub-phase occupies the second half of the resolving bar.
              const pct = 50 + Math.round((p.resolveProcessed ?? 0) / p.resolveTotal * 50);
              setBackfillProgress(pct);
              setBackfillMessage(
                `Resolving input addresses... ${(p.resolveProcessed ?? 0).toLocaleString()} of ${p.resolveTotal.toLocaleString()}`
              );
            } else {
              setBackfillProgress(99);
              setBackfillMessage("Resolving input addresses...");
            }
          } else if (p.phase === 'complete' || p.phase === 'deferred') {
            setBackfillProgress(100);
            setBackfillMessage("Done.");
          }
        },
      });

      setBackfillResult(result);

      if (result.deferred) {
        toast({
          title: "Transaction Rebuild Deferred",
          description: result.deferReason ?? "No connectivity. Run again when a blockchain node is reachable.",
        });
      } else if (result.orphansFound === 0) {
        toast({
          title: "No Orphaned Transactions",
          description: "All transaction records already have on-chain data.",
        });
      } else {
        const parts: string[] = [];
        if (result.rebuilt > 0) parts.push(`${result.rebuilt} rebuilt`);
        if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
        if (result.failed > 0) parts.push(`${result.failed} failed`);
        toast({
          title: "Transaction Rebuild Complete",
          description: `Found ${result.orphansFound} orphaned transaction${result.orphansFound !== 1 ? "s" : ""}. ${parts.join(", ")}.`,
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Transaction Rebuild Failed",
        description: err instanceof Error ? err.message : "An error occurred.",
      });
    } finally {
      backfillAbortRef.current = null;
      setIsBackfilling(false);
      setBackfillProgress(0);
      setBackfillMessage("");
    }
  };

  const handleCancelBackfill = () => {
    backfillAbortRef.current?.abort();
    setBackfillMessage("Cancelling...");
  };

  // One-off pass: resolve blank input addresses across the entire database, not
  // just txids rebuilt in the current run. Covers transactions rebuilt by older
  // backfills before automatic prevout resolution existed.
  const handleResolveInputs = async () => {
    const controller = new AbortController();
    resolveInputsAbortRef.current = controller;
    setIsResolvingInputs(true);
    setResolveInputsProgress(2);
    setResolveInputsMessage("Scanning for inputs missing addresses...");

    try {
      const result = await resolveAllBlankInputAddresses({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "scanning") {
            setResolveInputsProgress(5);
            setResolveInputsMessage(
              `Scanning for inputs missing addresses... (${p.unresolvedFound.toLocaleString()} found)`,
            );
          } else if (p.phase === "resolving") {
            const pct = p.totalToFetch > 0
              ? Math.round(10 + (p.fetched / p.totalToFetch) * 88)
              : 50;
            setResolveInputsProgress(pct);
            setResolveInputsMessage(
              p.totalToFetch > 0
                ? `Resolving addresses... fetched ${p.fetched.toLocaleString()} of ${p.totalToFetch.toLocaleString()} prior transactions`
                : "Resolving addresses from local data...",
            );
          } else if (p.phase === "recomputing") {
            if (p.recomputeTotal && p.recomputeTotal > 0) {
              const pct = Math.round(
                (p.recomputeProcessed ?? 0) / p.recomputeTotal * 100,
              );
              setResolveInputsProgress(pct);
              setResolveInputsMessage(
                `Updating balances... ${(p.recomputeProcessed ?? 0).toLocaleString()} of ${p.recomputeTotal.toLocaleString()} addresses`,
              );
            } else {
              setResolveInputsProgress(99);
              setResolveInputsMessage("Updating balances...");
            }
          } else if (p.phase === "complete") {
            setResolveInputsProgress(100);
            setResolveInputsMessage("Done.");
          }
        },
      });

      if (result.deferred) {
        toast({
          title: "Resolution Deferred",
          description: result.deferReason ?? "No connectivity. Try again when a blockchain node is reachable.",
        });
      } else if (result.cancelled) {
        const recomputeNote =
          result.recomputed > 0
            ? ` Updated balances for ${result.recomputed.toLocaleString()} address${result.recomputed !== 1 ? "es" : ""}.`
            : "";
        toast({
          title: "Resolution Cancelled",
          description: `Cancelled after resolving ${result.resolved.toLocaleString()} input address${result.resolved !== 1 ? "es" : ""}.${recomputeNote}`,
        });
      } else if (result.errors.length > 0) {
        toast({
          variant: "destructive",
          title: "Resolution Finished With Errors",
          description: `Resolved ${result.resolved.toLocaleString()} input address${result.resolved !== 1 ? "es" : ""}. ${result.errors[0]}`,
        });
      } else if (result.unresolvedFound === 0) {
        toast({
          title: "No Missing Input Addresses",
          description: "All transaction inputs already have resolved addresses.",
        });
      } else {
        const recomputeNote =
          result.recomputed > 0
            ? ` Updated balances for ${result.recomputed.toLocaleString()} address${result.recomputed !== 1 ? "es" : ""}.`
            : "";
        toast({
          title: "Input Addresses Resolved",
          description: `Resolved ${result.resolved.toLocaleString()} of ${result.unresolvedFound.toLocaleString()} blank input address${result.unresolvedFound !== 1 ? "es" : ""}.${recomputeNote}`,
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Resolution Failed",
        description: err instanceof Error ? err.message : "An error occurred.",
      });
    } finally {
      resolveInputsAbortRef.current = null;
      setIsResolvingInputs(false);
      setResolveInputsProgress(0);
      setResolveInputsMessage("");
    }
  };

  const handleCancelResolveInputs = () => {
    resolveInputsAbortRef.current?.abort();
    setResolveInputsMessage("Cancelling...");
  };

  // When the user opens Settings via the startup "missing transaction data"
  // notification, a one-shot sessionStorage flag is set. Consume it here to
  // scroll to and automatically start the rebuild.
  useEffect(() => {
    if (sessionStorage.getItem("kyutxo:autoBackfill") !== "1") return;
    sessionStorage.removeItem("kyutxo:autoBackfill");
    rebuildSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (!isBackfilling) {
      handleManualBackfill();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle file selection for restore
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setRestoreFile(file);
    setBackupInfo(null);
    setRestoreStage("configure");
    setPrefPreview(null);

    try {
      // v3 streaming backups: read ONLY the manifest (first ZIP entry) via the
      // streaming peek so a multi-GB backup is never loaded into memory just to
      // preview it. The v3 manifest carries counts/encrypted/date in plaintext.
      const manifestPeek = await peekManifest(blobChunks(file));
      if (isV3Manifest(manifestPeek)) {
        setBackupInfo({
          encrypted: manifestPeek.encrypted || false,
          date: manifestPeek.exportDate || "Unknown",
          recordCount: manifestPeek.counts?.records ?? 0,
        });
        return;
      }

      // Legacy backups (single backup.json holding the whole vault): unchanged
      // whole-file read for backward compatibility.
      const zip = await JSZip.loadAsync(file);
      const backupFile = zip.file("backup.json");

      if (!backupFile) {
        throw new Error("Invalid backup file - missing backup.json");
      }

      const content = await backupFile.async("text");
      const backup = JSON.parse(content);

      setBackupInfo({
        encrypted: backup.encrypted || false,
        date: backup.exportDate || "Unknown",
        recordCount: backup.encrypted ? -1 : (backup.data?.records?.length || 0),
      });
    } catch (error) {
      console.error("Failed to read backup file:", error);
      toast({
        variant: "destructive",
        title: "Invalid Backup",
        description: "Could not read the backup file. Make sure it's a valid KYUTXO backup.",
      });
      setRestoreFile(null);
    }
  };

  // First stage of restoring a v3 backup: read (without touching the vault)
  // which portable preferences the backup will carry over, then move to the
  // confirmation stage so the user can review them BEFORE the destructive
  // restore runs. Legacy (pre-v3) backups have no preview step and restore
  // directly. Nothing here clears or writes any data.
  const handlePrepareRestore = async () => {
    if (!restoreFile) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a backup file.",
      });
      return;
    }

    try {
      const manifestPeek = await peekManifest(blobChunks(restoreFile));
      if (isV3Manifest(manifestPeek)) {
        let key: CryptoKey | null = null;
        if (manifestPeek.encrypted) {
          if (!restorePassword) {
            toast({
              variant: "destructive",
              title: "Password required",
              description: "Enter the password used to encrypt this backup.",
            });
            return;
          }
          const salt = base64ToBuffer(manifestPeek.salt ?? "");
          key = await deriveKey(restorePassword, salt);
        }

        let inline: Record<string, unknown>;
        try {
          inline = await parseInline(manifestPeek, key);
        } catch {
          // A wrong password (or corrupted inline data) fails here, BEFORE any
          // destructive work — surface it and stay on the configure stage.
          toast({
            variant: "destructive",
            title: "Could not read backup",
            description: "The password may be incorrect, or the backup is corrupted.",
          });
          return;
        }

        const settingsRows = Array.isArray(inline.settings) ? (inline.settings as any[]) : [];
        setPrefPreview(previewSettingsPreferences(settingsRows));
        setRestoreStage("confirm");
        return;
      }

      // Legacy backups: read the (possibly encrypted) settings rows WITHOUT
      // touching the vault, then show the same configure -> confirm preview the
      // v3 path uses. A wrong password fails here, before any destructive work.
      const zip = await JSZip.loadAsync(restoreFile);
      const backupFile = zip.file("backup.json");
      if (!backupFile) {
        throw new Error("Invalid backup file - missing backup.json");
      }
      const backup = JSON.parse(await backupFile.async("text"));

      let legacyData = backup.data;
      if (backup.encrypted) {
        if (!restorePassword) {
          toast({
            variant: "destructive",
            title: "Password required",
            description: "Enter the password used to encrypt this backup.",
          });
          return;
        }
        try {
          const salt = base64ToBuffer(backup.salt);
          const backupKey = await deriveKey(restorePassword, salt);
          legacyData = JSON.parse(await decrypt(backup.data, backupKey));
        } catch {
          // Wrong password (or corrupted payload) surfaces here, BEFORE any
          // destructive work — stay on the configure stage.
          toast({
            variant: "destructive",
            title: "Could not read backup",
            description: "The password may be incorrect, or the backup is corrupted.",
          });
          return;
        }
      }

      const legacySettings = Array.isArray(legacyData?.settings)
        ? (legacyData.settings as any[])
        : [];
      setPrefPreview(previewSettingsPreferences(legacySettings));
      setRestoreStage("confirm");
    } catch (error) {
      console.error("Failed to prepare restore:", error);
      toast({
        variant: "destructive",
        title: "Invalid Backup",
        description: "Could not read the backup file. Make sure it's a valid KYUTXO backup.",
      });
    }
  };

  // Restore from backup handler
  const handleRestore = async () => {
    if (!restoreFile) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a backup file.",
      });
      return;
    }

    setIsRestoring(true);
    setRestoreProgress(0);
    setRestoreMessage("Reading backup file...");
    setRestoreCancellable(false);
    restoreClearedRef.current = false;
    restoreAbortRef.current = null;

    try {
      // v3 streaming backups: peek the manifest (first ZIP entry) without
      // reading the whole archive. If it is a v3 backup, restore it with the
      // streaming pipeline that never loads a whole table into memory. Older
      // backups (no formatVersion / a `.data` blob) fall through to the legacy
      // JSON path below, which is left untouched for backward compatibility.
      const manifestPeek = await peekManifest(blobChunks(restoreFile));
      if (isV3Manifest(manifestPeek)) {
        const attachmentWriter: AttachmentFileWriter = {
          async write(relativePath, fileData) {
            if (isElectron()) {
              const api = getElectronAPI();
              const result = await api.writeAttachment(relativePath, fileData);
              if (!result.success) {
                throw new Error(result.error || `Failed to write attachment ${relativePath}`);
              }
            } else {
              const formData = new FormData();
              formData.append('file', new Blob([fileData]));
              formData.append('relativePath', relativePath);
              const response = await fetch('/api/attachments/write', {
                method: 'POST',
                body: formData,
              });
              if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || response.statusText);
              }
            }
          },
        };

        const controller = new AbortController();
        restoreAbortRef.current = controller;
        setRestoreCancellable(true);

        const result = await restoreV3Backup({
          source: blobChunks(restoreFile),
          password: restorePassword || undefined,
          attachmentWriter,
          signal: controller.signal,
          onProgress: (p) => {
            // Once clearing begins, the existing vault is being destroyed; mark
            // the point of no return so cancel prompts for confirmation.
            if (p.percent >= 8) restoreClearedRef.current = true;
            setRestoreProgress(p.percent);
            setRestoreMessage(p.phase);
          },
        });

        setRestoreProgress(100);
        setRestoreMessage("Restore complete! Checking for missing transaction data...");

        // --- Post-restore txid backfill ---
        // Detect orphaned transaction records and fetch their on-chain data.
        // If the provider is unreachable, defer gracefully and tell the user.
        try {
          const { txids } = await detectOrphanedTxRecords();
          if (txids.length > 0) {
            setRestoreMessage(`Rebuilding on-chain data for ${txids.length} transaction${txids.length !== 1 ? "s" : ""}…`);
            const nodeSettings = await getNodeSettings('default');
            let backfillSummary = "";
            if (!nodeSettings) {
              backfillSummary = ` ${txids.length} transaction${txids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
            } else {
              try {
                const provider = createProviderFromSettings(nodeSettings);
                await provider.getBlockHeight(); // connectivity probe
                const bfResult = await runTxidBackfill(provider, txids, {
                  onProgress: (p) => {
                    const pct = p.orphansFound > 0
                      ? Math.round(p.processed / p.orphansFound * 100)
                      : 100;
                    setRestoreMessage(
                      `Rebuilding ${p.processed.toLocaleString()} of ${p.orphansFound.toLocaleString()} transactions…`
                    );
                    setRestoreProgress(pct);
                  },
                });
                const parts: string[] = [];
                if (bfResult.rebuilt > 0) parts.push(`${bfResult.rebuilt} rebuilt`);
                if (bfResult.skipped > 0) parts.push(`${bfResult.skipped} skipped`);
                if (bfResult.failed > 0) parts.push(`${bfResult.failed} failed`);
                if (bfResult.prevoutsResolved > 0) parts.push(`${bfResult.prevoutsResolved} input addresses resolved`);
                backfillSummary = parts.length > 0
                  ? ` Transaction data: ${parts.join(", ")}.`
                  : "";
              } catch {
                backfillSummary = ` ${txids.length} transaction${txids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
              }
            }
            toast({
              title: "Restore Successful",
              description: `Restored ${result.counts.records} records, ${result.counts.blockchainTransactions} transactions, ${result.counts.transactionParticipants} participants, ${result.counts.attachmentFiles} attachment files.${backfillSummary}`,
            });
          } else {
            toast({
              title: "Restore Successful",
              description: `Restored ${result.counts.records} records, ${result.counts.blockchainTransactions} transactions, ${result.counts.transactionParticipants} participants, ${result.counts.attachmentFiles} attachment files. Existing data was replaced.`,
            });
          }
        } catch {
          toast({
            title: "Restore Successful",
            description: `Restored ${result.counts.records} records, ${result.counts.blockchainTransactions} transactions, ${result.counts.transactionParticipants} participants, ${result.counts.attachmentFiles} attachment files. Existing data was replaced.`,
          });
        }

        // A restore can introduce transaction records missing on-chain data.
        // Reset the once-per-session orphan-check gate so the startup check in
        // OrphanedTxNotifier re-evaluates after the reload and re-prompts (or
        // auto-backfills) via the normal path. It sets the gate again on load,
        // so this cannot loop.
        resetOrphanCheckGate();

        setTimeout(() => {
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setRestoreProgress(0);
          setRestoreMessage("");
          setBackupInfo(null);
          setRestoreStage("configure");
          setPrefPreview(null);
          window.location.reload();
        }, 1500);
        return;
      }

      const zip = await JSZip.loadAsync(restoreFile);
      const backupFile = zip.file("backup.json");
      
      if (!backupFile) {
        throw new Error("Invalid backup file");
      }

      setRestoreProgress(10);
      const content = await backupFile.async("text");
      const backup = JSON.parse(content);

      let data = backup.data;

      // If backup is encrypted, decrypt it
      if (backup.encrypted) {
        setRestoreMessage("Decrypting backup...");
        setRestoreProgress(20);

        if (!restorePassword) {
          throw new Error("Password required for encrypted backup");
        }

        // Properly decode the salt from base64
        const salt = base64ToBuffer(backup.salt);
        const backupKey = await deriveKey(restorePassword, salt);

        try {
          const decrypted = await decrypt(backup.data, backupKey);
          data = JSON.parse(decrypted);
        } catch {
          throw new Error("Invalid password or corrupted backup");
        }
      }

      setRestoreProgress(30);
      setRestoreMessage("Processing data...");

      const { 
        records, 
        tags, 
        categories, 
        attachments, 
        recordOrigins, 
        customFields: backupCustomFields,
        owners = [],
        walletNames = [],
        seedNames = [],
        walletSoftware = [],
        derivationTemplates = [],
        evidence = [],
        evidenceAttachments = [],
        priceData = [],
        settings: backupSettings = [],
        nodeSettings: backupNodeSettings = [],
        utxoLineage = [],
        custodySegments = [],
        blockchainTransactions = [],
        transactionParticipants = [],
        addressSyncState = [],
      } = data;

      if (restoreMode === "replace") {
        setRestoreMessage("Clearing existing data...");
        setRestoreProgress(40);
        
        await clearAllRecords({ skipNotification: true });
        await db.tags.clear();
        await db.categories.clear();
        await clearAttachments({ skipNotification: true });
        await clearRecordOrigins({ skipNotification: true });
        await clearCustomFields({ skipNotification: true });
        await db.owners.clear();
        await db.walletNames.clear();
        await db.seedNames.clear();
        await db.walletSoftware.clear();
        await clearDerivationTemplates({ skipNotification: true });
        await clearEvidence({ skipNotification: true });
        await clearEvidenceAttachments({ skipNotification: true });
        await clearPriceData({ skipNotification: true });
        await clearNodeSettings({ skipNotification: true });
        await clearUtxoLineage({ skipNotification: true });
        await clearCustodySegments({ skipNotification: true });
        await clearTransactions({ skipNotification: true });
        await clearParticipants({ skipNotification: true });
        await clearAddressSyncState({ skipNotification: true });
      }

      setRestoreProgress(50);
      setRestoreMessage("Restoring records...");

      // Track statistics
      let recordsAdded = 0;
      let recordsSkipped = 0;

      // Backup record id -> live record id. bulkCreateRecords assigns fresh
      // autoincrement ids (it does NOT preserve the backup's ids), and in merge
      // mode an incoming record may map to an already-present record. Every
      // dependent row (attachments, transaction participants, address sync
      // state) must rewrite its recordId through this map, or it would link to
      // the wrong record — or to none at all.
      const recordIdMap = new Map<number, number>();

      // Restore records (de-dup by inputString in merge mode; backup id -> live
      // id recorded in recordIdMap for dependent rows). Shared with tests via
      // the legacy-restore helpers.
      const recordResult = await restoreLegacyRecords(records, restoreMode, recordIdMap);
      recordsAdded = recordResult.recordsAdded;
      recordsSkipped = recordResult.recordsSkipped;
      if (records && records.length > 0) {
        setRestoreProgress(70);
      }

      setRestoreMessage("Restoring tags and categories...");

      // Restore vocabulary (tags, categories, owners, wallet names, seed names,
      // wallet software). Merge mode skips entries whose name already exists;
      // replace mode adds every entry (cleared above). Shared with tests via the
      // legacy-restore-misc helpers.
      const vocabResult = await restoreLegacyVocabulary(
        { tags, categories, owners, walletNames, seedNames, walletSoftware },
        restoreMode,
      );
      const tagsAdded = vocabResult.tagsAdded;
      const categoriesAdded = vocabResult.categoriesAdded;
      const vocabularyAdded = vocabResult.vocabularyAdded;

      setRestoreProgress(80);
      setRestoreMessage("Restoring attachments...");

      // Restore attachment metadata (de-dup by objectStoragePath in merge mode;
      // recordId remapped through recordIdMap, orphans dropped). Shared with
      // tests via the legacy-restore helpers.
      const attachmentsAdded = await restoreLegacyAttachments(
        attachments,
        restoreMode,
        recordIdMap,
      );

      // Restore attachment files from ZIP
      setRestoreProgress(85);
      setRestoreMessage("Restoring attachment files...");
      
      let attachmentFilesRestored = 0;
      let attachmentFilesErrors = 0;
      const attachmentsFolder = zip.folder("attachments");
      if (attachmentsFolder) {
        const filePromises: Promise<void>[] = [];
        
        attachmentsFolder.forEach((relativePath, file) => {
          if (!file.dir) {
            filePromises.push((async () => {
              try {
                const fileData = await file.async("arraybuffer");
                
                if (isElectron()) {
                  const api = getElectronAPI();
                  const result = await api.writeAttachment(relativePath, fileData);
                  if (!result.success) {
                    console.error(`Failed to restore attachment file ${relativePath}:`, result.error);
                    attachmentFilesErrors++;
                    return;
                  }
                } else {
                  // Web mode: use API endpoint
                  const formData = new FormData();
                  formData.append('file', new Blob([fileData]));
                  formData.append('relativePath', relativePath);
                  
                  const response = await fetch('/api/attachments/write', {
                    method: 'POST',
                    body: formData,
                  });
                  
                  if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error(`Failed to restore attachment file ${relativePath}:`, errorData.error || response.statusText);
                    attachmentFilesErrors++;
                    return;
                  }
                }
                
                attachmentFilesRestored++;
              } catch (err) {
                console.error(`Failed to restore attachment file ${relativePath}:`, err);
                attachmentFilesErrors++;
              }
            })());
          }
        });
        
        await Promise.all(filePromises);
      }

      setRestoreProgress(90);
      setRestoreMessage("Restoring custom fields...");

      // Restore custom fields (merge mode de-dups by `slug`; replace mode adds
      // every field). Shared with tests via the legacy-restore-misc helpers.
      const customFieldsAdded = await restoreLegacyCustomFields(
        backupCustomFields,
        restoreMode,
      );

      setRestoreProgress(96);
      setRestoreMessage("Restoring derivation templates...");

      // Restore derivation templates (merge mode de-dups by
      // `fingerprint:scriptType`; replace mode adds every template). Shared with
      // tests via the legacy-restore-misc helpers.
      const templatesAdded = await restoreLegacyDerivationTemplates(
        derivationTemplates,
        restoreMode,
      );

      setRestoreProgress(97);
      setRestoreMessage("Restoring evidence and additional data...");

      // Restore evidence documents and their attachments. Evidence rows get
      // fresh auto-increment ids on restore (clear() does NOT reset IndexedDB
      // key generation), so the attachments' evidenceId must be remapped to the
      // new ids — otherwise restore orphans/mislinks every evidence file. The
      // shared helper does this remapping (mirroring the v3 path) and is covered
      // by a regression test.
      const evidenceResult = await restoreLegacyEvidence(
        evidence,
        evidenceAttachments,
      );
      const evidenceAdded = evidenceResult.evidenceAdded;
      const evidenceAttachmentsAdded = evidenceResult.evidenceAttachmentsAdded;

      // Restore price data (v2.2.0+, not encrypted): append-only, no de-dup or
      // id remapping (replace mode cleared the table above). Shared with tests
      // via the legacy-restore-misc helpers.
      const priceDataAdded = await restoreLegacyPriceData(priceData);

      // Restore node settings (v2.2.0+, not encrypted). Uses the shared helper
      // so the legacy path and the v3 streaming path can never diverge in how
      // the nodeSettings singleton is restored (id preserved, `put` semantics).
      await restoreNodeSettingsRows(backupNodeSettings);

      // Restore the small allow-list of portable settings preferences (e.g.
      // disableOrphanCheck). Shared helper keeps the legacy and v3 paths from
      // diverging; fields absent from older backups are left at their defaults.
      await restoreSettingsPreferences(backupSettings);

      // Restore UTXO lineage data and custody segments (v2.2.0+, not encrypted):
      // backup ids stripped, no id remapping. In replace mode the tables were
      // cleared above and rows are appended as-is. In merge mode segments whose
      // unique `segmentId` already exists (and lineage edges already present) are
      // skipped, so a merge over an already-present segment no longer throws on
      // the unique index and aborts the restore. Shared with tests via the
      // legacy-restore-misc helpers; only lineage rows are surfaced to the user.
      const lineageResult = await restoreLegacyLineage(utxoLineage, custodySegments, restoreMode);
      const lineageDataAdded = lineageResult.lineageAdded;

      // Restore blockchain transaction data (v2.2.0+, not encrypted): confirmed
      // transactions, their input/output participants, and per-address sync
      // state. Without this a restored vault would have to re-sync everything
      // from scratch. Transactions de-dup by txid; participants are only added
      // for transactions actually inserted and their recordId is rewritten
      // through the recordIdMap (or left undefined when the owning record is
      // absent). Shared with tests via the legacy-restore helpers.
      const txResult = await restoreLegacyTransactions(
        blockchainTransactions,
        transactionParticipants,
        restoreMode,
        recordIdMap,
      );
      const transactionsAdded = txResult.transactionsAdded;
      const participantsAdded = txResult.participantsAdded;

      // Address sync state: unique `address` index, de-duped against existing
      // (merge) and the incoming set; recordId remapped. Shared with tests via
      // the legacy-restore helpers.
      const addressSyncAdded = await restoreLegacyAddressSyncState(
        addressSyncState,
        restoreMode,
        recordIdMap,
      );

      console.log(`[Restore] transactions: ${transactionsAdded}, participants: ${participantsAdded}, synced addresses: ${addressSyncAdded}`);

      setRestoreProgress(100);
      setRestoreMessage("Restore complete! Checking for missing transaction data...");

      let attachmentFilesMsg = "";
      if (attachmentFilesRestored > 0 && attachmentFilesErrors === 0) {
        attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files`;
      } else if (attachmentFilesRestored > 0 && attachmentFilesErrors > 0) {
        attachmentFilesMsg = `, ${attachmentFilesRestored} attachment files (${attachmentFilesErrors} failed)`;
      } else if (attachmentFilesErrors > 0) {
        attachmentFilesMsg = ` (${attachmentFilesErrors} attachment files failed)`;
      }
      let additionalDataMsg = "";
      if (evidenceAdded > 0 || priceDataAdded > 0 || lineageDataAdded > 0 || transactionsAdded > 0 || addressSyncAdded > 0) {
        const parts = [];
        if (evidenceAdded > 0) parts.push(`${evidenceAdded} evidence`);
        if (priceDataAdded > 0) parts.push(`${priceDataAdded} prices`);
        if (lineageDataAdded > 0) parts.push(`${lineageDataAdded} lineage`);
        if (transactionsAdded > 0) parts.push(`${transactionsAdded} transactions`);
        if (addressSyncAdded > 0) parts.push(`${addressSyncAdded} synced addresses`);
        additionalDataMsg = `, ${parts.join(", ")}`;
      }

      const baseMessage = restoreMode === "merge"
        ? `Added ${recordsAdded} records (${recordsSkipped} skipped), ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`
        : `Restored ${recordsAdded} records, ${tagsAdded} tags, ${categoriesAdded} categories, ${vocabularyAdded} vocabulary items, ${templatesAdded} templates${attachmentFilesMsg}${additionalDataMsg}.`;

      // --- Post-restore txid backfill ---
      let backfillSuffix = "";
      try {
        const { txids: orphanTxids } = await detectOrphanedTxRecords();
        if (orphanTxids.length > 0) {
          setRestoreMessage(`Rebuilding on-chain data for ${orphanTxids.length} transaction${orphanTxids.length !== 1 ? "s" : ""}…`);
          const nodeSettingsForBf = await getNodeSettings('default');
          if (!nodeSettingsForBf) {
            backfillSuffix = ` ${orphanTxids.length} transaction${orphanTxids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
          } else {
            try {
              const bfProvider = createProviderFromSettings(nodeSettingsForBf);
              await bfProvider.getBlockHeight(); // connectivity probe
              const bfResult = await runTxidBackfill(bfProvider, orphanTxids, {
                onProgress: (p) => {
                  const pct = p.orphansFound > 0
                    ? Math.round(p.processed / p.orphansFound * 100)
                    : 100;
                  setRestoreMessage(
                    `Rebuilding ${p.processed.toLocaleString()} of ${p.orphansFound.toLocaleString()} transactions…`
                  );
                  setRestoreProgress(pct);
                },
              });
              const bfParts: string[] = [];
              if (bfResult.rebuilt > 0) bfParts.push(`${bfResult.rebuilt} rebuilt`);
              if (bfResult.skipped > 0) bfParts.push(`${bfResult.skipped} skipped`);
              if (bfResult.failed > 0) bfParts.push(`${bfResult.failed} failed`);
              if (bfResult.prevoutsResolved > 0) bfParts.push(`${bfResult.prevoutsResolved} input addresses resolved`);
              backfillSuffix = bfParts.length > 0
                ? ` Transaction data: ${bfParts.join(", ")}.`
                : "";
            } catch {
              backfillSuffix = ` ${orphanTxids.length} transaction${orphanTxids.length !== 1 ? "s" : ""} need on-chain data — run "Rebuild Missing Transactions" in Settings when connected.`;
            }
          }
        }
      } catch {
        // backfill detection failure is non-fatal
      }

      toast({
        title: "Restore Successful",
        description: baseMessage + backfillSuffix,
      });

      // A restore can introduce transaction records missing on-chain data. Reset
      // the once-per-session orphan-check gate so the startup check in
      // OrphanedTxNotifier re-evaluates after the reload and re-prompts (or
      // auto-backfills) via the normal path. It sets the gate again on load, so
      // this cannot loop.
      resetOrphanCheckGate();

      // Close dialog and reset state
      setTimeout(() => {
        setRestoreDialogOpen(false);
        setRestoreFile(null);
        setRestorePassword("");
        setRestoreProgress(0);
        setRestoreMessage("");
        setBackupInfo(null);
        // Reload to refresh all data
        window.location.reload();
      }, 1500);

    } catch (error) {
      // User-initiated cancel of the v3 streaming restore. The library tells us
      // which side of the destructive clear the cancel happened on so we can
      // give an honest message about the resulting vault state.
      if (error instanceof BackupCancelledError) {
        setRestoreProgress(0);
        setRestoreMessage("");
        if (error.clearedBeforeCancel) {
          // Old data was already wiped and only part of the backup written; the
          // library reset the vault to a known-empty state. Reload so the UI
          // reflects the empty vault and prompt the user to restore again.
          toast({
            variant: "destructive",
            title: "Restore Cancelled",
            description:
              "Your existing data had already been cleared, so the vault is now empty. Run the restore again to recover your data.",
          });
          // A cancel-after-clear can leave partially-written transaction records
          // (missing on-chain data) behind. Reset the once-per-session
          // orphan-check gate so the startup check re-evaluates after the reload,
          // the same way a successful restore does. The check re-sets the gate on
          // load, so this cannot loop.
          resetOrphanCheckGate();
          setTimeout(() => {
            setRestoreDialogOpen(false);
            setRestoreFile(null);
            setRestorePassword("");
            setBackupInfo(null);
            window.location.reload();
          }, 2000);
        } else {
          // Cancelled before the clear: nothing was touched.
          toast({
            title: "Restore Cancelled",
            description: "No changes were made — your existing data is intact.",
          });
        }
        return;
      }
      // Cancelled after the clear, but the vault could NOT be reset to a clean
      // state — it is in an unknown partial state. Be explicit and reload so the
      // UI reflects the real (partial) contents and prompt a re-restore.
      if (error instanceof RestoreInterruptedError) {
        console.error("Restore interrupted:", error);
        setRestoreProgress(0);
        setRestoreMessage("");
        toast({
          variant: "destructive",
          title: "Restore Interrupted",
          description: error.message,
        });
        // The vault is in an unknown partial state that can include transaction
        // records missing on-chain data. Reset the once-per-session orphan-check
        // gate so the startup check re-evaluates after the reload, the same way a
        // successful restore does. The check re-sets the gate on load, so this
        // cannot loop.
        resetOrphanCheckGate();
        setTimeout(() => {
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setBackupInfo(null);
          window.location.reload();
        }, 2500);
        return;
      }
      console.error("Restore failed:", error);
      toast({
        variant: "destructive",
        title: "Restore Failed",
        description: error instanceof Error ? error.message : "Failed to restore backup",
      });
      setRestoreProgress(0);
      setRestoreMessage("");
    } finally {
      setIsRestoring(false);
      setRestoreCancellable(false);
      restoreAbortRef.current = null;
      restoreClearedRef.current = false;
    }
  };

  // Cancel button on the restore dialog. Before the destructive clear we abort
  // immediately (existing data is safe). After it, we confirm first because the
  // vault has already been wiped and cancelling will leave it empty.
  const handleRequestCancelRestore = () => {
    if (restoreClearedRef.current) {
      setShowCancelRestoreConfirm(true);
    } else {
      restoreAbortRef.current?.abort();
      setRestoreMessage("Cancelling...");
    }
  };

  const confirmCancelRestore = () => {
    setShowCancelRestoreConfirm(false);
    restoreAbortRef.current?.abort();
    setRestoreMessage("Cancelling...");
  };

  // Commit a new Privacy Audit History retention limit, trimming older runs and
  // surfacing how many were removed.
  const applyPrivacyHistoryLimit = async (limit: number) => {
    try {
      const removed = await updatePrivacyHistoryLimit(limit);
      if (removed > 0) {
        toast({
          title: `Removed ${removed.toLocaleString()} older ${removed === 1 ? "run" : "runs"}`,
          description: "Older Privacy Audit runs beyond the new limit were deleted.",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to update retention limit",
        variant: "destructive",
      });
    }
  };

  // Picking a new limit: if a large number of runs would be deleted, confirm
  // first so a misclick doesn't silently wipe a lot of history. Small/no-op
  // trims apply immediately.
  const handlePrivacyHistoryLimitChange = async (limit: number) => {
    try {
      const total = await getPrivacyAuditHistoryCount();
      const removeCount = total - limit;
      if (removeCount > PRIVACY_HISTORY_TRIM_CONFIRM_THRESHOLD) {
        setPendingHistoryTrim({ limit, removeCount });
        return;
      }
    } catch {
      // If we can't preview the count, fall through to applying directly; the
      // trim itself still reports what it removed.
    }
    await applyPrivacyHistoryLimit(limit);
  };

  const confirmPrivacyHistoryTrim = async () => {
    if (!pendingHistoryTrim) return;
    const { limit } = pendingHistoryTrim;
    setPendingHistoryTrim(null);
    await applyPrivacyHistoryLimit(limit);
  };

  const isLoading = settingsLoading || customFieldsLoading;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Settings</h1>
          <p className="text-muted-foreground">
            Configure your KYUTXO application preferences
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Moon className="h-5 w-5" />
              Appearance
            </CardTitle>
            <CardDescription>
              Customize the look and feel of the application
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Dark Mode</Label>
                <p className="text-sm text-muted-foreground">
                  Switch between light and dark theme
                </p>
              </div>
              <ThemeToggle />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Activity Monitor</Label>
                <p className="text-sm text-muted-foreground">
                  Show a live activity indicator in the header and sidebar
                </p>
              </div>
              <Switch
                checked={monitorEnabled}
                onCheckedChange={setMonitorEnabled}
                data-testid="toggle-activity-monitor"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label className="text-base">Search Fade Intensity</Label>
                <p className="text-sm text-muted-foreground">
                  How much the results dim while a search is in progress
                </p>
              </div>
              <Select
                value={searchFadeIntensity}
                onValueChange={(val) => {
                  setSearchFadeIntensity(val as SearchFadeOption);
                  setSearchFadePreference(val as SearchFadeOption);
                  toast({
                    title: "Search fade updated",
                    description: SEARCH_FADE_OPTIONS.find(o => o.value === val)?.label ?? val,
                  });
                }}
              >
                <SelectTrigger className="w-[200px]" data-testid="select-search-fade">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEARCH_FADE_OPTIONS.map((opt) => (
                    <SelectItem
                      key={opt.value}
                      value={opt.value}
                      data-testid={`option-fade-${opt.value}`}
                    >
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Field Visibility
            </CardTitle>
            <CardDescription>
              Choose which fields to show in forms and tables
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground">Built-in Fields</h4>
              
              <div className="flex items-center justify-between">
                <Label>Seed Name</Label>
                <Switch
                  checked={fieldVisibility.seedName}
                  onCheckedChange={() => handleToggleBuiltInField('seedName')}
                  disabled={isLoading}
                  data-testid="switch-seed"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Wallet Software</Label>
                <Switch
                  checked={fieldVisibility.walletSoftware}
                  onCheckedChange={() => handleToggleBuiltInField('walletSoftware')}
                  disabled={isLoading}
                  data-testid="switch-wallet"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Owner</Label>
                <Switch
                  checked={fieldVisibility.owner}
                  onCheckedChange={() => handleToggleBuiltInField('owner')}
                  disabled={isLoading}
                  data-testid="switch-owner"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Wallet Name</Label>
                <Switch
                  checked={fieldVisibility.walletName}
                  onCheckedChange={() => handleToggleBuiltInField('walletName')}
                  disabled={isLoading}
                  data-testid="switch-wallet-name"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Private Key Status</Label>
                <Switch
                  checked={fieldVisibility.privateKeyStatus}
                  onCheckedChange={() => handleToggleBuiltInField('privateKeyStatus')}
                  disabled={isLoading}
                  data-testid="switch-private-key"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <Label>Source</Label>
                <Switch
                  checked={fieldVisibility.source}
                  onCheckedChange={() => handleToggleBuiltInField('source')}
                  disabled={isLoading}
                  data-testid="switch-source"
                />
              </div>
            </div>

            <Separator className="my-4" />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-muted-foreground">Custom Fields</h4>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setIsAddingField(true)}
                  data-testid="button-add-custom-field"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Field
                </Button>
              </div>

              {customFields.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No custom fields defined. Add your own fields to track additional metadata.
                </p>
              ) : (
                <div className="space-y-2">
                  {customFields.map((field) => (
                    <div
                      key={field.id}
                      className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/50"
                      data-testid={`custom-field-row-${field.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={field.enabled}
                          onCheckedChange={() => handleToggleCustomField(field.id!)}
                          data-testid={`switch-custom-field-${field.id}`}
                        />
                        <span className={field.enabled ? "" : "text-muted-foreground"}>
                          {field.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditingField({ id: field.id!, name: field.name })}
                          data-testid={`button-edit-field-${field.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeletingFieldId(field.id!)}
                          data-testid={`button-delete-field-${field.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <VocabularyManager />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Lineage Build
            </CardTitle>
            <CardDescription>
              Configure how the Continuity Proof lineage builder behaves
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label className="text-base">Cancel Confirmation</Label>
                <p className="text-sm text-muted-foreground">
                  Ask for confirmation before cancelling a build that has reached this progress level
                </p>
              </div>
              <Select
                value={String(cancelConfirmThreshold)}
                onValueChange={async (val) => {
                  try {
                    await updateCancelConfirmThreshold(Number(val));
                  } catch {
                    toast({
                      title: "Error",
                      description: "Failed to update threshold",
                      variant: "destructive",
                    });
                  }
                }}
                disabled={isLoading}
              >
                <SelectTrigger className="w-[160px]" data-testid="select-cancel-threshold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0" data-testid="option-threshold-0">Always confirm</SelectItem>
                  <SelectItem value="25" data-testid="option-threshold-25">25%</SelectItem>
                  <SelectItem value="50" data-testid="option-threshold-50">50%</SelectItem>
                  <SelectItem value="75" data-testid="option-threshold-75">75% (default)</SelectItem>
                  <SelectItem value="90" data-testid="option-threshold-90">90%</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Fund Trail
            </CardTitle>
            <CardDescription>
              Control how many transactions the Fund Trail loads per hop
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <Label className="text-base">Recent transactions per hop</Label>
                <p className="text-sm text-muted-foreground">
                  On busy wallets only the most recent transactions are shown per hop. A higher limit traces more history but is slower.
                </p>
              </div>
              <Select
                value={String(fundTrailTxLimit)}
                onValueChange={async (val) => {
                  try {
                    await updateFundTrailTxLimit(Number(val));
                  } catch {
                    toast({
                      title: "Error",
                      description: "Failed to update transaction limit",
                      variant: "destructive",
                    });
                  }
                }}
                disabled={settingsLoading}
              >
                <SelectTrigger className="w-[180px]" data-testid="select-fund-trail-tx-limit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="500" data-testid="option-fund-trail-limit-500">500</SelectItem>
                  <SelectItem value="1000" data-testid="option-fund-trail-limit-1000">1,000</SelectItem>
                  <SelectItem value="2000" data-testid="option-fund-trail-limit-2000">2,000 (default)</SelectItem>
                  <SelectItem value="5000" data-testid="option-fund-trail-limit-5000">5,000</SelectItem>
                  <SelectItem value="10000" data-testid="option-fund-trail-limit-10000">10,000</SelectItem>
                  <SelectItem value="25000" data-testid="option-fund-trail-limit-25000">25,000</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Privacy Audit History
            </CardTitle>
            <CardDescription>
              Control how many past Privacy Audit runs are kept for trend tracking
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <Label className="text-base">Runs to keep</Label>
                <p className="text-sm text-muted-foreground">
                  Older runs beyond this limit are removed automatically (oldest first)
                </p>
              </div>
              <Select
                value={String(privacyHistoryLimit)}
                onValueChange={(val) => {
                  void handlePrivacyHistoryLimitChange(Number(val));
                }}
                disabled={settingsLoading}
              >
                <SelectTrigger className="w-[160px]" data-testid="select-privacy-history-limit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10" data-testid="option-history-limit-10">10 runs</SelectItem>
                  <SelectItem value="30" data-testid="option-history-limit-30">30 runs (default)</SelectItem>
                  <SelectItem value="50" data-testid="option-history-limit-50">50 runs</SelectItem>
                  <SelectItem value="100" data-testid="option-history-limit-100">100 runs</SelectItem>
                  <SelectItem value="250" data-testid="option-history-limit-250">250 runs</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Privacy Audit Entity List
            </CardTitle>
            <CardDescription>
              The Privacy Audit flags transactions that touch known exchanges, mixers,
              darknet markets and sanctioned addresses. KYUTXO ships a bundled list compiled
              from public sources (WalletExplorer, GraphSense TagPacks, OFAC SDN). Because
              KYUTXO stays fully offline, you can refresh it by importing an updated JSON
              snapshot — nothing is ever fetched from the network.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <Label className="text-base">Current list</Label>
                <p className="text-sm text-muted-foreground">
                  {entitySnapshot ? (
                    entitySnapshot.mode === "merge" ? (
                      <>
                        Imported snapshot merged with bundled —{" "}
                        <span data-testid="text-entity-count">
                          {entitySnapshot.entries.length.toLocaleString()}
                        </span>{" "}
                        imported {entitySnapshot.entries.length === 1 ? "entry" : "entries"} on top of{" "}
                        {bundledEntityCount.toLocaleString()} bundled, loaded{" "}
                        {new Date(entitySnapshot.importedAt).toLocaleString()}
                        {entitySnapshot.sourceLabel ? ` from "${entitySnapshot.sourceLabel}"` : ""}.
                      </>
                    ) : (
                      <>
                        Imported snapshot —{" "}
                        <span data-testid="text-entity-count">
                          {entitySnapshot.entries.length.toLocaleString()}
                        </span>{" "}
                        entries, loaded {new Date(entitySnapshot.importedAt).toLocaleString()}
                        {entitySnapshot.sourceLabel ? ` from "${entitySnapshot.sourceLabel}"` : ""}.
                      </>
                    )
                  ) : (
                    <>
                      Bundled default —{" "}
                      <span data-testid="text-entity-count">
                        {bundledEntityCount.toLocaleString()}
                      </span>{" "}
                      entries.
                    </>
                  )}
                </p>
              </div>
              <Badge variant={entitySnapshot ? "default" : "secondary"} data-testid="badge-entity-source">
                {entitySnapshot ? "Imported" : "Bundled"}
              </Badge>
            </div>

            <p className="text-sm text-muted-foreground">
              Snapshot format: a JSON array (or an object with an{" "}
              <code className="text-xs">entries</code> array) of{" "}
              <code className="text-xs">{`{ address, name, category, sourceNote? }`}</code>{" "}
              objects. Every address is validated and the category must be one of: exchange,
              payment-service, gambling, scam, darknet, mining-pool, mixer, p2p-exchange.
              Export the current list to use it as a starting template.
            </p>

            <input
              ref={entityFileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleEntityFileSelected}
              data-testid="input-entity-file"
            />

            <div className="space-y-2">
              <Label>Import mode</Label>
              <RadioGroup
                value={entityImportMode}
                onValueChange={(value) => setEntityImportMode(value as EntityListMode)}
                disabled={isImportingEntities}
              >
                <div className="flex items-start space-x-3 p-3 rounded-md border bg-background hover-elevate">
                  <RadioGroupItem value="replace" id="entity-mode-replace" data-testid="radio-entity-replace" />
                  <div className="space-y-1">
                    <Label htmlFor="entity-mode-replace" className="font-medium cursor-pointer">
                      Replace
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Use only the imported entries. The bundled list stays available as a fallback
                      via "Revert to bundled".
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-3 p-3 rounded-md border bg-background hover-elevate">
                  <RadioGroupItem value="merge" id="entity-mode-merge" data-testid="radio-entity-merge" />
                  <div className="space-y-1">
                    <Label htmlFor="entity-mode-merge" className="font-medium cursor-pointer">
                      Merge with bundled
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Add the imported entries on top of the {bundledEntityCount.toLocaleString()}{" "}
                      bundled entries. Your entries win on duplicate addresses, so you can add new
                      sanctions or markets without re-supplying the bundled defaults.
                    </p>
                  </div>
                </div>
              </RadioGroup>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={() => entityFileInputRef.current?.click()}
                disabled={isImportingEntities}
                data-testid="button-import-entities"
              >
                {isImportingEntities ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Import snapshot
              </Button>
              <Button
                variant="outline"
                onClick={handleExportEntities}
                data-testid="button-export-entities"
              >
                <Download className="h-4 w-4" />
                Export current list
              </Button>
              {entitySnapshot && (
                <Button
                  variant="outline"
                  onClick={handleResetEntities}
                  disabled={isResettingEntities}
                  data-testid="button-reset-entities"
                >
                  {isResettingEntities ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Revert to bundled
                </Button>
              )}
            </div>

            {entityImportErrors && entityImportErrors.length > 0 && (
              <div
                className="rounded-md border border-destructive/50 bg-destructive/10 p-3 space-y-1"
                data-testid="container-entity-errors"
              >
                <p className="text-sm font-medium text-destructive flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  {entityImportErrors.length.toLocaleString()} problem
                  {entityImportErrors.length === 1 ? "" : "s"} — nothing was imported
                </p>
                <p className="text-xs text-muted-foreground">
                  Fix the entries below in your file, then import again.
                </p>
                <EntityErrorList errors={entityImportErrors} />
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog
          open={!!entityPreview}
          onOpenChange={(open) => {
            if (!open && !isApplyingEntities) handleCancelEntityImport();
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Confirm entity list import</DialogTitle>
              <DialogDescription>
                Review the snapshot{entityPreviewSource ? ` from "${entityPreviewSource}"` : ""} before it{" "}
                {entityPreview?.mode === "merge"
                  ? "merges into the bundled Privacy Audit list"
                  : "replaces the current Privacy Audit list"}
                . Nothing changes until you confirm.
              </DialogDescription>
            </DialogHeader>

            {entityPreview && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">New snapshot</p>
                    <p className="text-2xl font-semibold" data-testid="text-preview-incoming">
                      {entityPreview.incomingCount.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">entries</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">
                      {entityPreview.mode === "merge" ? "After merge" : "Current list"}
                    </p>
                    <p className="text-2xl font-semibold" data-testid="text-preview-current">
                      {entityPreview.mode === "merge"
                        ? entityPreview.resultingCount.toLocaleString()
                        : entityPreview.currentCount.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {entityPreview.mode === "merge"
                        ? `entries (from ${entityPreview.currentCount.toLocaleString()} bundled)`
                        : "entries"}
                    </p>
                  </div>
                </div>

                {entityPreview.mode === "merge" ? (
                  (() => {
                    const overriddenChanged = entityPreview.overrides.filter(
                      (o) => o.changed,
                    ).length;
                    return (
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <Badge variant="default" data-testid="badge-preview-added">
                          +{entityPreview.added.toLocaleString()} brand-new
                        </Badge>
                        <Badge variant="destructive" data-testid="badge-preview-overridden">
                          {entityPreview.overridden.toLocaleString()} override bundled
                          {entityPreview.overridden > 0
                            ? ` (${overriddenChanged.toLocaleString()} changed)`
                            : ""}
                        </Badge>
                      </div>
                    );
                  })()
                ) : (
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <Badge variant="default" data-testid="badge-preview-added">
                      +{entityPreview.added.toLocaleString()} added
                    </Badge>
                    <Badge variant="destructive" data-testid="badge-preview-removed">
                      −{entityPreview.removed.toLocaleString()} removed
                    </Badge>
                    <Badge variant="outline" data-testid="badge-preview-changed">
                      {entityPreview.changed.toLocaleString()} changed
                    </Badge>
                    <Badge variant="secondary" data-testid="badge-preview-unchanged">
                      {entityPreview.unchanged.toLocaleString()} unchanged
                    </Badge>
                  </div>
                )}

                {entityPreview.mode === "merge" && entityPreview.overridden > 0 && (() => {
                  const overriddenChanged = entityPreview.overrides.filter(
                    (o) => o.changed,
                  ).length;
                  return (
                    <p className="text-xs text-muted-foreground" data-testid="text-merge-override-note">
                      {entityPreview.overridden.toLocaleString()} imported{" "}
                      {entityPreview.overridden === 1 ? "address" : "addresses"} already exist in the bundled
                      list, but only {overriddenChanged.toLocaleString()} will actually change{" "}
                      {overriddenChanged === 1 ? "an entry" : "entries"}
                      {overriddenChanged < entityPreview.overridden
                        ? ` (the other ${(entityPreview.overridden - overriddenChanged).toLocaleString()} ${
                            entityPreview.overridden - overriddenChanged === 1 ? "is" : "are"
                          } identical re-imports)`
                        : ""}
                      . Review them below.
                    </p>
                  );
                })()}

                {entityImportWarnings.length > 0 && (
                  <div
                    className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 space-y-1.5"
                    data-testid="container-entity-import-warnings"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-yellow-700 dark:text-yellow-400">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span data-testid="text-entity-warning-heading">
                        {entityImportWarnings.length.toLocaleString()}{" "}
                        {entityImportWarnings.length === 1 ? "entry has" : "entries have"} a mismatched
                        source citation
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The source note links to a different address than the entry itself — usually a
                      copy/paste mistake. You can still import, but review these attributions first.
                    </p>
                    <ul className="space-y-1.5 max-h-40 overflow-y-auto text-xs">
                      {entityImportWarnings.map((w, i) => (
                        <li
                          key={`${w.index}-${i}`}
                          className="text-yellow-700 dark:text-yellow-400 break-words"
                          data-testid={`text-entity-warning-${i}`}
                        >
                          {w.citedAddresses && w.citedAddresses.length > 0 ? (
                            <span className="flex flex-wrap items-center gap-1">
                              <span>
                                Source note for{" "}
                                {w.address && (
                                  <>
                                    "
                                    <AddressLink
                                      address={w.address}
                                      showMetadataIndicator={false}
                                    />
                                    "
                                  </>
                                )}{" "}
                                cites a different address
                                {w.citedAddresses.length > 1 ? "es" : ""}:
                              </span>
                              {w.citedAddresses.map((addr) => (
                                <AddressLink
                                  key={addr}
                                  address={addr}
                                  showMetadataIndicator={false}
                                />
                              ))}
                            </span>
                          ) : (
                            w.message
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <p className="text-sm font-medium mb-2">By category</p>
                  <div className="rounded-md border divide-y max-h-64 overflow-y-auto">
                    <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                      <span>Category</span>
                      <span className="flex items-center gap-4">
                        <span className="w-16 text-right">
                          {entityPreview.mode === "merge" ? "Bundled" : "Current"}
                        </span>
                        <span className="w-16 text-right">New</span>
                        <span className="w-14 text-right">Change</span>
                      </span>
                    </div>
                    {entityPreview.categories.map((c) => (
                      <div
                        key={c.category}
                        className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
                        data-testid={`row-preview-category-${c.category}`}
                      >
                        <span data-testid={`text-preview-category-label-${c.category}`}>
                          {c.label}
                        </span>
                        <span className="flex items-center gap-4 tabular-nums">
                          <span
                            className="w-16 text-right text-muted-foreground"
                            data-testid={`text-preview-category-current-${c.category}`}
                          >
                            {c.current.toLocaleString()}
                          </span>
                          <span
                            className="w-16 text-right font-medium"
                            data-testid={`text-preview-category-incoming-${c.category}`}
                          >
                            {c.incoming.toLocaleString()}
                          </span>
                          <span
                            className={`w-14 text-right font-medium ${
                              c.delta > 0
                                ? "text-green-600 dark:text-green-400"
                                : c.delta < 0
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-muted-foreground"
                            }`}
                            data-testid={`text-preview-category-delta-${c.category}`}
                          >
                            {c.delta > 0
                              ? `+${c.delta.toLocaleString()}`
                              : c.delta < 0
                                ? `\u2212${Math.abs(c.delta).toLocaleString()}`
                                : "0"}
                          </span>
                        </span>
                      </div>
                    ))}
                    {(() => {
                      const totalCurrent = entityPreview.currentCount;
                      const totalIncoming = entityPreview.incomingCount;
                      const totalDelta =
                        entityPreview.resultingCount - entityPreview.currentCount;
                      return (
                        <div
                          className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm font-medium bg-muted/50"
                          data-testid="row-preview-total"
                        >
                          <span data-testid="text-preview-total-label">Total</span>
                          <span className="flex items-center gap-4 tabular-nums">
                            <span
                              className="w-16 text-right text-muted-foreground"
                              data-testid="text-preview-total-current"
                            >
                              {totalCurrent.toLocaleString()}
                            </span>
                            <span
                              className="w-16 text-right"
                              data-testid="text-preview-total-incoming"
                            >
                              {totalIncoming.toLocaleString()}
                            </span>
                            <span
                              className={`w-14 text-right ${
                                totalDelta > 0
                                  ? "text-green-600 dark:text-green-400"
                                  : totalDelta < 0
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-muted-foreground"
                              }`}
                              data-testid="text-preview-total-delta"
                            >
                              {totalDelta > 0
                                ? `+${totalDelta.toLocaleString()}`
                                : totalDelta < 0
                                  ? `\u2212${Math.abs(totalDelta).toLocaleString()}`
                                  : "0"}
                            </span>
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {entityPreview.mode === "merge"
                  ? (entityPreview.added > 0 || entityPreview.overridden > 0) && (
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2"
                          onClick={() => setShowEntityDiff((v) => !v)}
                          data-testid="button-toggle-entity-diff"
                        >
                          {showEntityDiff ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          {showEntityDiff ? "Hide affected entries" : "Show affected entries"}
                        </Button>

                        {showEntityDiff && (
                          <Tabs defaultValue="overrides" className="mt-2">
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              <div className="relative flex-1 min-w-[12rem]">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                                <Input
                                  value={entityDiffSearch}
                                  onChange={(e) => setEntityDiffSearch(e.target.value)}
                                  placeholder="Filter by address or name..."
                                  className="pl-8"
                                  data-testid="input-entity-diff-search"
                                />
                              </div>
                              <Select
                                value={entityDiffCategory}
                                onValueChange={(v) => setEntityDiffCategory(v as EntityCategory | "all")}
                              >
                                <SelectTrigger className="w-[12rem]" data-testid="select-entity-diff-category">
                                  <SelectValue placeholder="All categories" />
                                </SelectTrigger>
                                <SelectContent>{entityDiffCategoryOptions}</SelectContent>
                              </Select>
                            </div>
                            <TabsList className="grid w-full grid-cols-2">
                              <TabsTrigger value="overrides" data-testid="tab-entity-diff-overrides">
                                Overrides ({searchedOverrides.length.toLocaleString()}
                                {changedOverrideCount !== searchedOverrides.length
                                  ? `, ${changedOverrideCount.toLocaleString()} changed`
                                  : ""}
                                )
                              </TabsTrigger>
                              <TabsTrigger value="added" data-testid="tab-entity-diff-added">
                                Brand-new ({filteredAddedEntries.length.toLocaleString()})
                              </TabsTrigger>
                            </TabsList>
                            <TabsContent value="overrides" className="mt-2 space-y-2">
                              <div className="flex items-center gap-2">
                                <Switch
                                  id="overrides-only-changed"
                                  checked={overridesOnlyChanged}
                                  onCheckedChange={setOverridesOnlyChanged}
                                  data-testid="switch-overrides-only-changed"
                                />
                                <Label
                                  htmlFor="overrides-only-changed"
                                  className="text-sm font-normal cursor-pointer"
                                >
                                  Only show changed
                                </Label>
                              </div>
                              <EntityOverrideList
                                overrides={filteredOverrides}
                                emptyLabel={
                                  overridesOnlyChanged && searchedOverrides.length > 0
                                    ? "No overrides change anything — every match is identical to the bundled entry."
                                    : entityDiffFiltering
                                      ? "No overrides match your search."
                                      : "No bundled entries will be overridden."
                                }
                              />
                            </TabsContent>
                            <TabsContent value="added" className="mt-2">
                              <EntityDiffList
                                entries={filteredAddedEntries}
                                emptyLabel={
                                  entityDiffFiltering
                                    ? "No brand-new entries match your search."
                                    : "No brand-new entries will be added."
                                }
                                variant="added"
                              />
                            </TabsContent>
                          </Tabs>
                        )}
                      </div>
                    )
                  : (entityPreview.added > 0 || entityPreview.removed > 0 || entityPreview.changed > 0) && (
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2"
                          onClick={() => setShowEntityDiff((v) => !v)}
                          data-testid="button-toggle-entity-diff"
                        >
                          {showEntityDiff ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          {showEntityDiff ? "Hide changed entries" : "Show changed entries"}
                        </Button>

                        {showEntityDiff && (
                          <Tabs defaultValue="added" className="mt-2">
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              <div className="relative flex-1 min-w-[12rem]">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                                <Input
                                  value={entityDiffSearch}
                                  onChange={(e) => setEntityDiffSearch(e.target.value)}
                                  placeholder="Filter by address or name..."
                                  className="pl-8"
                                  data-testid="input-entity-diff-search"
                                />
                              </div>
                              <Select
                                value={entityDiffCategory}
                                onValueChange={(v) => setEntityDiffCategory(v as EntityCategory | "all")}
                              >
                                <SelectTrigger className="w-[12rem]" data-testid="select-entity-diff-category">
                                  <SelectValue placeholder="All categories" />
                                </SelectTrigger>
                                <SelectContent>{entityDiffCategoryOptions}</SelectContent>
                              </Select>
                            </div>
                            <TabsList className="grid w-full grid-cols-3">
                              <TabsTrigger value="added" data-testid="tab-entity-diff-added">
                                Added ({filteredAddedEntries.length.toLocaleString()})
                              </TabsTrigger>
                              <TabsTrigger value="changed" data-testid="tab-entity-diff-changed">
                                Changed ({filteredChangedEntries.length.toLocaleString()})
                              </TabsTrigger>
                              <TabsTrigger value="removed" data-testid="tab-entity-diff-removed">
                                Removed ({filteredRemovedEntries.length.toLocaleString()})
                              </TabsTrigger>
                            </TabsList>
                            <TabsContent value="added" className="mt-2">
                              <EntityDiffList
                                entries={filteredAddedEntries}
                                emptyLabel={
                                  entityDiffFiltering
                                    ? "No added entries match your search."
                                    : "No entries will be added."
                                }
                                variant="added"
                              />
                            </TabsContent>
                            <TabsContent value="changed" className="mt-2">
                              <ChangedEntityList
                                changes={filteredChangedEntries}
                                emptyLabel={
                                  entityDiffFiltering
                                    ? "No changed entries match your search."
                                    : "No entries changed name or category."
                                }
                              />
                            </TabsContent>
                            <TabsContent value="removed" className="mt-2">
                              <EntityDiffList
                                entries={filteredRemovedEntries}
                                emptyLabel={
                                  entityDiffFiltering
                                    ? "No removed entries match your search."
                                    : "No entries will be removed."
                                }
                                variant="removed"
                              />
                            </TabsContent>
                          </Tabs>
                        )}
                      </div>
                    )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleCancelEntityImport}
                disabled={isApplyingEntities}
                data-testid="button-cancel-entity-import"
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmEntityImport}
                disabled={isApplyingEntities}
                data-testid="button-confirm-entity-import"
              >
                {isApplyingEntities ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Replace list
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Storage
            </CardTitle>
            <CardDescription>
              Information about local data storage
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Storage Type</span>
              <Badge variant="secondary">IndexedDB (Offline)</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Data Location</span>
              <span className="text-sm font-mono">Local Device</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Storage Used</span>
              <span className="text-sm font-medium" data-testid="text-storage">2.1 MB</span>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-database-doctor-link">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5" />
              Database Doctor
            </CardTitle>
            <CardDescription>
              A safe, read-only health check that tells you in plain language whether your records
              are actually there and readable — or still locked from an unfinished migration.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/database-doctor">
              <Button variant="outline" data-testid="button-open-database-doctor">
                Open Database Doctor
                <ChevronRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        <LegacyRecoveryPanel />

        <StripMarkersPanel
          onRunningChange={setIsStripRunning}
        />

        <MigrationAuditPanel />


        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Security
            </CardTitle>
            <CardDescription>
              Manage your vault password and attachment security
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Change Password</Label>
                <p className="text-sm text-muted-foreground">
                  Update your vault password
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setChangePasswordDialogOpen(true)}
                data-testid="button-change-password"
              >
                <KeyRound className="h-4 w-4 mr-2" />
                Change
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Migrate Attachment Paths</Label>
                <p className="text-sm text-muted-foreground">
                  Hash attachment directory and file names for privacy
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleManualAttachmentMigration}
                disabled={isMigratingAttachments}
                data-testid="button-migrate-attachments"
              >
                {isMigratingAttachments ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Migrating...
                  </>
                ) : (
                  <>
                    <Paperclip className="h-4 w-4 mr-2" />
                    Migrate
                  </>
                )}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Repair Attachment Links</Label>
                <p className="text-sm text-muted-foreground">
                  Reconnect attachments whose file moved during a previous migration. Relinks records to the matching file on disk — never moves or deletes files.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleRepairAttachmentLinks}
                disabled={isRepairingAttachments}
                data-testid="button-repair-attachments"
              >
                {isRepairingAttachments ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Repairing...
                  </>
                ) : (
                  <>
                    <Wrench className="h-4 w-4 mr-2" />
                    Repair
                  </>
                )}
              </Button>
            </div>
            {attachmentRepair && (
              <div
                className="rounded-md border p-4 space-y-2 text-sm"
                data-testid="text-attachment-repair-result"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Reconnected</span>
                  <span data-testid="text-repair-repaired">{attachmentRepair.repaired}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Still missing (no matching file found)</span>
                  <span data-testid="text-repair-unresolved">{attachmentRepair.unresolved}</span>
                </div>
                {attachmentRepair.repaired === 0 && attachmentRepair.unresolved === 0 && (
                  <p className="text-muted-foreground pt-1">
                    Everything was already linked. No repairs were needed.
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Check Attachments</Label>
                <p className="text-sm text-muted-foreground">
                  Compare your records against the files on disk. Read-only — nothing is changed or deleted.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleAuditAttachments}
                disabled={isAuditingAttachments}
                data-testid="button-audit-attachments"
              >
                {isAuditingAttachments ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Checking...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Check
                  </>
                )}
              </Button>
            </div>
            {attachmentAudit && (
              <div
                className="rounded-md border p-4 space-y-2 text-sm"
                data-testid="text-attachment-audit-result"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Attachments on record</span>
                  <span data-testid="text-audit-total-rows">{attachmentAudit.totalDbRows}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Files found on disk</span>
                  <span data-testid="text-audit-total-files">{attachmentAudit.totalDiskFiles}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Matched</span>
                  <span data-testid="text-audit-matched">{attachmentAudit.matched}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Missing files (on record but not on disk)</span>
                  <span data-testid="text-audit-missing">{attachmentAudit.missingFiles.length}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Unreferenced files (on disk but not on record)</span>
                  <span data-testid="text-audit-orphaned">{attachmentAudit.orphanedFiles.length}</span>
                </div>
                {attachmentAudit.missingFiles.length === 0 && attachmentAudit.orphanedFiles.length === 0 && (
                  <p className="text-muted-foreground pt-1">
                    Everything matches. No missing or unreferenced files.
                  </p>
                )}
              </div>
            )}

            <Separator />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Deleted Attachments (Recoverable)</Label>
                <p className="text-sm text-muted-foreground">
                  When you delete records or attachments, their files are kept here so you can get
                  them back. Download a file to recover it, or permanently remove files to free up space.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleLoadTrash}
                disabled={isLoadingTrash}
                data-testid="button-load-trash"
              >
                {isLoadingTrash ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Show
                  </>
                )}
              </Button>
            </div>
            {trashList !== null && (
              <div className="rounded-md border p-4 space-y-3 text-sm" data-testid="container-trash-list">
                {trashList.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="text-trash-empty">
                    No deleted attachments. Nothing to recover.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-muted-foreground" data-testid="text-trash-summary">
                        {trashList.length.toLocaleString()} recoverable file{trashList.length === 1 ? "" : "s"}
                        {" · "}
                        {formatFileSize(trashList.reduce((sum, t) => sum + (t.size || 0), 0))}
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setShowEmptyTrashDialog(true)}
                        disabled={isPurgingTrash}
                        data-testid="button-empty-trash"
                      >
                        {isPurgingTrash ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Removing...
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Permanently delete all
                          </>
                        )}
                      </Button>
                    </div>
                    <div className="space-y-2 max-h-80 overflow-auto" data-testid="list-trash-items">
                      {trashList.slice(0, 300).map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 rounded-md border p-2"
                          data-testid={`trash-item-${item.id}`}
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium" data-testid={`text-trash-filename-${item.id}`}>
                              {item.filename}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {formatFileSize(item.size)}
                              {" · "}
                              {new Date(item.deletedAt).toLocaleDateString()}
                              {item.identifier ? ` · ${item.identifier}` : ""}
                            </p>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={() => handleDownloadTrashed(item)}
                              data-testid={`button-download-trash-${item.id}`}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={() => handlePurgeTrashed(item)}
                              data-testid={`button-purge-trash-${item.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {trashList.length > 300 && (
                      <p className="text-xs text-muted-foreground">
                        Showing the 300 most recent. Use "Permanently delete all" to clear everything.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            <AlertDialog open={showEmptyTrashDialog} onOpenChange={setShowEmptyTrashDialog}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Permanently delete all recoverable files?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes every deleted attachment file from disk. This cannot be
                    undone. Any file you have not downloaded will be lost.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-cancel-empty-trash">Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleEmptyTrash} data-testid="button-confirm-empty-trash">
                    Permanently delete all
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Data Management
            </CardTitle>
            <CardDescription>
              Clear or restore your database
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Recompute Address Stats</Label>
                <p className="text-sm text-muted-foreground">
                  Rebuild cached balances, transaction counts, and last-activity dates from locally stored data. No network access.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleRecomputeStats}
                disabled={isRecomputingStats}
                data-testid="button-recompute-stats"
              >
                {isRecomputingStats ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Recomputing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Recompute
                  </>
                )}
              </Button>
            </div>

            <Separator />

            <div ref={rebuildSectionRef} className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Rebuild Missing Transactions</Label>
                <p className="text-sm text-muted-foreground">
                  Fetch on-chain data for transaction records that were restored from an older backup or added manually without syncing. Requires a connected blockchain provider.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleManualBackfill}
                disabled={isBackfilling}
                data-testid="button-rebuild-transactions"
              >
                {isBackfilling ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Rebuilding...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Rebuild
                  </>
                )}
              </Button>
            </div>

            <Separator />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Startup Missing-Data Reminder</Label>
                <p className="text-sm text-muted-foreground">
                  Show a one-per-session reminder when transaction records are missing on-chain data. Turn this off if you knowingly keep records without on-chain data.
                </p>
              </div>
              <Switch
                checked={!disableOrphanCheck}
                onCheckedChange={async (checked) => {
                  await updateDisableOrphanCheck(!checked);
                }}
                disabled={settingsLoading}
                data-testid="switch-orphan-check"
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Resolve Input Addresses</Label>
                <p className="text-sm text-muted-foreground">
                  Fill in missing input addresses across all transactions, including ones rebuilt by earlier imports. Requires a connected blockchain provider.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleResolveInputs}
                disabled={isResolvingInputs}
                data-testid="button-resolve-inputs"
              >
                {isResolvingInputs ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Resolving...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Resolve
                  </>
                )}
              </Button>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Restore from Backup</Label>
                <p className="text-sm text-muted-foreground">
                  Import data from a previously exported backup file
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setRestoreDialogOpen(true)}
                data-testid="button-open-restore"
              >
                <Upload className="h-4 w-4 mr-2" />
                Restore
              </Button>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base text-destructive">Clear Database</Label>
                <p className="text-sm text-muted-foreground">
                  Permanently delete all records, tags, and categories
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={() => setClearDialogOpen(true)}
                data-testid="button-open-clear"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>About KYUTXO</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Version</span>
              <span className="font-medium">1.0.0</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Type</span>
              <Badge variant="outline">Progressive Web App</Badge>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Privacy</span>
              <span className="font-medium">All data stored locally</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add Custom Field Dialog */}
      <Dialog open={isAddingField} onOpenChange={setIsAddingField}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Custom Field</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="field-name">Field Name</Label>
            <Input
              id="field-name"
              value={newFieldName}
              onChange={(e) => setNewFieldName(e.target.value)}
              placeholder="e.g., Exchange, Account Number"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAddCustomField();
                }
              }}
              data-testid="input-new-field-name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddingField(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddCustomField} data-testid="button-confirm-add-field">
              Add Field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Custom Field Dialog */}
      <Dialog open={editingField !== null} onOpenChange={(open) => !open && setEditingField(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Custom Field</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="edit-field-name">Field Name</Label>
            <Input
              id="edit-field-name"
              value={editingField?.name || ""}
              onChange={(e) => setEditingField(prev => prev ? { ...prev, name: e.target.value } : null)}
              placeholder="Field name"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleUpdateCustomField();
                }
              }}
              data-testid="input-edit-field-name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingField(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateCustomField} data-testid="button-confirm-edit-field">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deletingFieldId !== null} onOpenChange={(open) => !open && setDeletingFieldId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Custom Field</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this custom field? This will not remove existing data from records, but the field will no longer appear in forms.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteCustomField} data-testid="button-confirm-delete-field">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear Database Dialog */}
      <Dialog open={clearDialogOpen} onOpenChange={(open) => {
        if (!open && !isClearing) {
          setClearDialogOpen(false);
          setClearPassword("");
          setClearPhrase("");
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Clear All Data
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-4 bg-destructive/10 rounded-lg border border-destructive/20">
              <p className="text-sm text-destructive font-medium">
                Warning: This action cannot be undone!
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                All records, tags, categories, attachments, and custom fields will be permanently deleted.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="clear-password">Enter your vault password</Label>
              <Input
                id="clear-password"
                type="password"
                value={clearPassword}
                onChange={(e) => setClearPassword(e.target.value)}
                placeholder="Your vault password"
                disabled={isClearing}
                data-testid="input-clear-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="clear-phrase">
                Type <span className="font-mono text-destructive">{DELETE_CONFIRMATION_PHRASE}</span> to confirm
              </Label>
              <Input
                id="clear-phrase"
                type="text"
                value={clearPhrase}
                onChange={(e) => setClearPhrase(e.target.value)}
                placeholder={DELETE_CONFIRMATION_PHRASE}
                disabled={isClearing}
                data-testid="input-clear-phrase"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setClearDialogOpen(false);
              setClearPassword("");
              setClearPhrase("");
            }} disabled={isClearing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearDatabase}
              disabled={isClearing || !clearPassword || clearPhrase !== DELETE_CONFIRMATION_PHRASE}
              data-testid="button-confirm-clear"
            >
              {isClearing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Clearing...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear All Data
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Dialog */}
      <Dialog open={restoreDialogOpen} onOpenChange={(open) => {
        if (!open && !isRestoring) {
          setRestoreDialogOpen(false);
          setRestoreFile(null);
          setRestorePassword("");
          setRestoreProgress(0);
          setRestoreMessage("");
          setBackupInfo(null);
          setRestoreStage("configure");
          setPrefPreview(null);
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Restore from Backup
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {restoreStage === "configure" && (
            <>
            <div className="space-y-2">
              <Label>Select backup file</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileSelect}
                className="hidden"
                data-testid="input-restore-file"
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRestoring}
                >
                  {restoreFile ? restoreFile.name : "Choose ZIP file..."}
                </Button>
                {restoreFile && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setRestoreFile(null);
                      setBackupInfo(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    disabled={isRestoring}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {backupInfo && (
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Backup Date:</span>
                  <span className="font-medium">
                    {new Date(backupInfo.date).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Encrypted:</span>
                  <Badge variant={backupInfo.encrypted ? "default" : "secondary"}>
                    {backupInfo.encrypted ? "Yes" : "No"}
                  </Badge>
                </div>
                {!backupInfo.encrypted && backupInfo.recordCount >= 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Records:</span>
                    <span className="font-medium">{backupInfo.recordCount}</span>
                  </div>
                )}
              </div>
            )}

            {backupInfo?.encrypted && (
              <div className="space-y-2">
                <Label htmlFor="restore-password">Backup password</Label>
                <Input
                  id="restore-password"
                  type="password"
                  value={restorePassword}
                  onChange={(e) => setRestorePassword(e.target.value)}
                  placeholder="Enter the password used to encrypt this backup"
                  disabled={isRestoring}
                  data-testid="input-restore-password"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>Restore mode</Label>
              <RadioGroup
                value={restoreMode}
                onValueChange={(value) => setRestoreMode(value as "replace" | "merge")}
                disabled={isRestoring}
              >
                <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background hover-elevate">
                  <RadioGroupItem value="replace" id="mode-replace" data-testid="radio-replace" />
                  <div className="space-y-1">
                    <Label htmlFor="mode-replace" className="font-medium cursor-pointer">
                      Replace all data
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Delete all existing data and replace with backup contents
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background hover-elevate">
                  <RadioGroupItem value="merge" id="mode-merge" data-testid="radio-merge" />
                  <div className="space-y-1">
                    <Label htmlFor="mode-merge" className="font-medium cursor-pointer">
                      Merge with existing
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Add backup data to existing records, skipping duplicates
                    </p>
                  </div>
                </div>
              </RadioGroup>
            </div>
            </>
            )}

            {restoreStage === "confirm" && (
              <div className="space-y-3" data-testid="restore-preferences-preview">
                <div>
                  <Label>Preferences this backup will restore</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    These portable preferences travel with your backup. Anything
                    marked "Kept (this device)" is left exactly as it is now.
                    Other device-only settings — theme, column layout, node
                    connection — are never touched by a restore.
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/40 divide-y">
                  {(prefPreview ?? []).map((p) => (
                    <div
                      key={p.key}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      data-testid={`pref-preview-${p.key}`}
                    >
                      <span className="font-medium">{p.label}</span>
                      {p.fromBackup ? (
                        <Badge variant="default" data-testid={`pref-status-${p.key}`}>
                          From backup: {p.backupValue}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" data-testid={`pref-status-${p.key}`}>
                          Kept (this device)
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
                {!isRestoring && prefPreview && !prefPreview.some((p) => p.fromBackup) && (
                  <p className="text-xs text-muted-foreground" data-testid="text-no-prefs-carried">
                    This backup doesn't change any of your portable preferences —
                    they'll all stay as they are on this device.
                  </p>
                )}
              </div>
            )}

            {isRestoring && (
              <div className="space-y-2" data-testid="restore-progress">
                <div className="flex items-center justify-between text-sm">
                  <span data-testid="text-restore-phase">{restoreMessage}</span>
                  <span>{restoreProgress}%</span>
                </div>
                <Progress value={restoreProgress} />
                {restoreCancellable && (
                  <p className="text-xs text-muted-foreground">
                    {restoreClearedRef.current
                      ? "Existing data has been cleared. Cancelling now will leave the vault empty."
                      : "You can cancel safely until the existing data starts being replaced."}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            {isRestoring ? (
              <Button
                variant="destructive"
                onClick={handleRequestCancelRestore}
                disabled={!restoreCancellable}
                data-testid="button-cancel-restore"
              >
                {restoreCancellable ? "Cancel Restore" : "Restoring..."}
              </Button>
            ) : restoreStage === "confirm" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setRestoreStage("configure")}
                  data-testid="button-back-restore"
                >
                  Back
                </Button>
                <Button
                  onClick={handleRestore}
                  disabled={!restoreFile || (backupInfo?.encrypted && !restorePassword)}
                  data-testid="button-confirm-restore"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Restore Now
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => {
                  setRestoreDialogOpen(false);
                  setRestoreFile(null);
                  setRestorePassword("");
                  setRestoreProgress(0);
                  setRestoreMessage("");
                  setBackupInfo(null);
                  setRestoreStage("configure");
                  setPrefPreview(null);
                }}>
                  Cancel
                </Button>
                <Button
                  onClick={handlePrepareRestore}
                  disabled={!restoreFile || (backupInfo?.encrypted && !restorePassword)}
                  data-testid="button-continue-restore"
                >
                  Continue
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before lowering the Privacy Audit History limit deletes a large batch of older runs */}
      <AlertDialog
        open={pendingHistoryTrim !== null}
        onOpenChange={(open) => !open && setPendingHistoryTrim(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Remove older audit runs?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingHistoryTrim
                ? `This will permanently remove ${pendingHistoryTrim.removeCount.toLocaleString()} older Privacy Audit ${pendingHistoryTrim.removeCount === 1 ? "run" : "runs"}, keeping only the most recent ${pendingHistoryTrim.limit.toLocaleString()}. This cannot be undone. Continue?`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-history-trim">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmPrivacyHistoryTrim()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-history-trim"
            >
              Remove runs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCancelRestoreConfirm} onOpenChange={setShowCancelRestoreConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Cancel restore?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your existing data has already been cleared to make room for the backup.
              If you cancel now, the vault will be left empty and you'll need to run
              the restore again to recover your data. Continue restoring instead?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-keep-restoring">Keep restoring</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancelRestore}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-cancel-restore"
            >
              Cancel and empty vault
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={isRecomputingStats}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-recompute-stats">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Recomputing Address Stats
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Progress value={recomputeProgress} data-testid="progress-recompute-stats" />
            <p className="text-sm text-muted-foreground" data-testid="text-recompute-message">
              {recomputeMessage}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelRecompute}
              data-testid="button-cancel-recompute"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isBackfilling}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-backfill-transactions">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Rebuilding Missing Transaction Data
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Progress value={backfillProgress} data-testid="progress-backfill" />
            <p className="text-sm text-muted-foreground" data-testid="text-backfill-message">
              {backfillMessage}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelBackfill}
              data-testid="button-cancel-backfill"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isResolvingInputs}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-resolve-inputs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Resolving Input Addresses
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Progress value={resolveInputsProgress} data-testid="progress-resolve-inputs" />
            <p className="text-sm text-muted-foreground" data-testid="text-resolve-inputs-message">
              {resolveInputsMessage}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelResolveInputs}
              data-testid="button-cancel-resolve-inputs"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={changePasswordDialogOpen} onOpenChange={(open) => {
        if (!open && !isChangingPassword) {
          setChangePasswordDialogOpen(false);
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Change Vault Password
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current Password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter your current password"
                disabled={isChangingPassword}
                data-testid="input-current-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password (min 8 characters)"
                disabled={isChangingPassword}
                data-testid="input-new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                disabled={isChangingPassword}
                data-testid="input-confirm-password"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => {
              setChangePasswordDialogOpen(false);
              setCurrentPassword("");
              setNewPassword("");
              setConfirmPassword("");
            }} disabled={isChangingPassword}>
              Cancel
            </Button>
            <Button
              onClick={handleChangePassword}
              disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}
              data-testid="button-confirm-change-password"
            >
              {isChangingPassword ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Changing...
                </>
              ) : (
                <>
                  <KeyRound className="h-4 w-4 mr-2" />
                  Change Password
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
