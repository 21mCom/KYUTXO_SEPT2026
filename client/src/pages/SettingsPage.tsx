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
  updateSourceOfFundsTxLimit,
  updateIntermediaryAddressCap,
  updateHoverTooltipPrefs,
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
import { renderSourceNote } from "@/lib/renderSourceNote";
import { clearTransactions, clearParticipants } from "@/lib/data/transaction-crud";
import { clearUtxoLineage, clearCustodySegments, clearLineageSnapshots } from "@/lib/data/lineage-crud";
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
import type { LegacyAttachmentsResult } from "@/lib/backup/legacy-restore";
import {
  restoreLegacyVocabulary,
  restoreLegacyCustomFields,
  restoreLegacyDerivationTemplates,
  restoreLegacyEvidence,
  restoreLegacyPriceData,
  restoreLegacyLineage,
  restoreLegacySnapshots,
} from "@/lib/backup/legacy-restore-misc";
import { clearDerivationTemplates } from "@/lib/data/derivation-templates-crud";
import { clearDustFlags, restoreDustFlagRows } from "@/lib/data/dust-flags-crud";
import { getSettings, updateSettings } from "@/lib/data/settings-crud";
import {
  prepareEntitySnapshot,
  applyEntitySnapshot,
  resetEntitySnapshot,
  serializeActiveEntityList,
  loadEntitySnapshotFromStorage,
  ENTITY_ERROR_KIND_LABELS,
  type EntitySnapshotError,
  type EntitySnapshotErrorKind,
  type EntitySnapshotWarning,
  type EntitySnapshotPreview,
  type EntityListMode,
} from "@/lib/data/entity-list-store";
import { getBundledEntityCount, type EntityCategory } from "@/lib/privacy-entity-list";
import { deriveKey, decrypt, base64ToBuffer, verifyPassword } from "@/lib/crypto";
import { getVaultSettings, vaultDb } from "@/lib/vault";
import { generateSalt, hashPassword, bufferToBase64 } from "@/lib/crypto";
import { migrateAttachmentPaths, auditAttachments, reconcileAttachmentPaths, downloadFile, deleteFile, formatFileSize, type AttachmentAuditResult, type AttachmentReconcileResult } from "@/lib/attachments";
import { getTrashedAttachments, deleteTrashedAttachment } from "@/lib/data/trash-crud";
import { 
  setAttachmentPathsMigrated,
} from "@/lib/vault";
import JSZip from "jszip";
import { peekManifest, restoreV3Backup, evaluateDiskSpace, RestoreInterruptedError, AttachmentWriteError, type AttachmentFileWriter } from "@/lib/backup/restore";
import { BackupCancelledError, downloadBlob } from "@/lib/backup/sink";
import { blobChunks } from "@/lib/backup/zip-stream";
import { isV3Manifest, parseInline, ATTACHMENTS_DIR } from "@/lib/backup/format";
import VocabularyManager from "@/components/VocabularyManager";
import { AddressLink } from "@/components/AddressLink";
import StripMarkersPanel from "@/components/StripMarkersPanel";
import MigrationAuditPanel from "@/components/MigrationAuditPanel";
import LegacyRecoveryPanel from "@/components/LegacyRecoveryPanel";
import NeedsReviewPanel from "@/components/NeedsReviewPanel";
import { hasUnrecoveredLegacyData } from "@/lib/legacy-decrypt";
import {
  getSearchFadePreference,
  setSearchFadePreference,
  SEARCH_FADE_OPTIONS,
  type SearchFadeOption,
} from "@/config/debounce";
import { useActivityBus } from "@/lib/activity-bus";
import { detectAndBackfill, detectOrphanedTxRecords, runTxidBackfill, resolveAllBlankInputAddresses, formatSkippedReasons, type BackfillResult } from "@/lib/txid-backfill";
import { describeResolveError } from "@/lib/resolve-error";
import { resetOrphanCheckGate } from "@/lib/orphan-check-session";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import { EntityImportDialog } from "./settings/entity-import-dialog";
import {
  ENTITY_ERROR_ROW_HEIGHT,
  entityErrorLabel,
  EntityErrorList,
  resetEntityErrorOpenState,
  VirtualizedEntityErrorList,
} from "./settings/entity-errors";
export { resetEntityErrorOpenState } from "./settings/entity-errors";
import { SecurityAttachmentSection } from "./settings/security-attachment-section";
import { DataManagementSection } from "./settings/data-management-section";

const DELETE_CONFIRMATION_PHRASE = "DELETE ALL DATA";

// Lowering the Privacy Audit History limit deletes the oldest runs. When more
// than this many runs would be removed, confirm with the user first so a misclick
// doesn't silently wipe a lot of history.
const PRIVACY_HISTORY_TRIM_CONFIRM_THRESHOLD = 20;

// Human-readable byte size for disk-space warnings (e.g. "1.5 GB").
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function SettingsPage() {
  const { settings, fieldVisibility, cancelConfirmThreshold, privacyHistoryLimit, disableOrphanCheck, fundTrailTxLimit, sourceOfFundsTxLimit, intermediaryAddressCap, hoverTooltipPrefs, isLoading: settingsLoading } = useSettings();
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
  const [pendingHistoryTrim, setPendingHistoryTrim] = useState<
    { limit: number; removeCount: number } | null
  >(null);
  // Two-stage restore for v3 backups: "configure" (pick file/password/mode) then
  // "confirm" (review which portable preferences the backup will carry over,
  // before the destructive restore runs). `prefPreview` is computed without
  // touching the vault.
  const [searchFadeIntensity, setSearchFadeIntensity] = useState<SearchFadeOption>(getSearchFadePreference);
  const [, setIsStripRunning] = useState(false);
  const { monitorEnabled, setMonitorEnabled } = useActivityBus();


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
      setOverridesOnlyChanged(false);
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
    setOverridesOnlyChanged(false);
    setEntityImportWarnings([]);
  };
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
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Could not write the entity list — please try again.",
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
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <Label className="text-base">Intermediary addresses in exports</Label>
                <p className="text-sm text-muted-foreground">
                  How many intermediary addresses a CSV or PDF export lists for each chain before summarizing the rest as "(+N more)". A higher cap is more complete but less scannable.
                </p>
              </div>
              <Select
                value={String(intermediaryAddressCap)}
                onValueChange={async (val) => {
                  try {
                    await updateIntermediaryAddressCap(Number(val));
                  } catch {
                    toast({
                      title: "Error",
                      description: "Failed to update intermediary-address cap",
                      variant: "destructive",
                    });
                  }
                }}
                disabled={settingsLoading}
              >
                <SelectTrigger className="w-[180px]" data-testid="select-intermediary-address-cap">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5" data-testid="option-intermediary-cap-5">5</SelectItem>
                  <SelectItem value="10" data-testid="option-intermediary-cap-10">10 (default)</SelectItem>
                  <SelectItem value="25" data-testid="option-intermediary-cap-25">25</SelectItem>
                  <SelectItem value="50" data-testid="option-intermediary-cap-50">50</SelectItem>
                  <SelectItem value="100" data-testid="option-intermediary-cap-100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Source of Funds Report
            </CardTitle>
            <CardDescription>
              Control how many funding transactions the Source of Funds Report processes per run
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <Label className="text-base">Transactions per report</Label>
                <p className="text-sm text-muted-foreground">
                  On busy addresses only the most important funding transactions are processed. A higher limit is more complete but slower.
                </p>
              </div>
              <Select
                value={String(sourceOfFundsTxLimit)}
                onValueChange={async (val) => {
                  try {
                    await updateSourceOfFundsTxLimit(Number(val));
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
                <SelectTrigger className="w-[180px]" data-testid="select-source-of-funds-tx-limit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="500" data-testid="option-sof-limit-500">500</SelectItem>
                  <SelectItem value="1000" data-testid="option-sof-limit-1000">1,000</SelectItem>
                  <SelectItem value="2000" data-testid="option-sof-limit-2000">2,000 (default)</SelectItem>
                  <SelectItem value="5000" data-testid="option-sof-limit-5000">5,000</SelectItem>
                  <SelectItem value="10000" data-testid="option-sof-limit-10000">10,000</SelectItem>
                  <SelectItem value="25000" data-testid="option-sof-limit-25000">25,000</SelectItem>
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Address &amp; Transaction Hover
            </CardTitle>
            <CardDescription>
              Choose which metadata fields appear when hovering an address or transaction ID.
              Only non-blank fields are shown. System tags (e.g.{" "}
              <code className="text-xs">quantum:*</code>) can be included or excluded separately.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(
              [
                { key: "showLabel", label: "Label" },
                { key: "showWalletName", label: "Wallet Name" },
                { key: "showOwner", label: "Owner" },
                { key: "showSeedName", label: "Seed Name" },
                { key: "showSoftware", label: "Software" },
                { key: "showCategory", label: "Category" },
                { key: "showTags", label: "Tags" },
                { key: "showPrivateKeyStatus", label: "Private Key Status" },
                { key: "showNotes", label: "Notes" },
              ] as Array<{ key: keyof typeof hoverTooltipPrefs; label: string }>
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between gap-4">
                <Label htmlFor={`hover-toggle-${key}`} className="text-sm cursor-pointer">
                  {label}
                </Label>
                <Switch
                  id={`hover-toggle-${key}`}
                  checked={hoverTooltipPrefs[key]}
                  onCheckedChange={async (checked) => {
                    try {
                      await updateHoverTooltipPrefs({ [key]: checked });
                    } catch {
                      toast({ title: "Error", description: "Failed to update hover setting", variant: "destructive" });
                    }
                  }}
                  disabled={settingsLoading}
                  data-testid={`switch-hover-${key}`}
                />
              </div>
            ))}
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="hover-toggle-systemtags" className="text-sm cursor-pointer">
                  Include system tags
                </Label>
                <p className="text-xs text-muted-foreground">
                  Show namespace-prefixed tags such as{" "}
                  <code className="text-xs">quantum:critical</code> in the hover tooltip and
                  count them toward the metadata indicator.
                </p>
              </div>
              <Switch
                id="hover-toggle-systemtags"
                checked={hoverTooltipPrefs.includeSystemTags}
                onCheckedChange={async (checked) => {
                  try {
                    await updateHoverTooltipPrefs({ includeSystemTags: checked });
                  } catch {
                    toast({ title: "Error", description: "Failed to update hover setting", variant: "destructive" });
                  }
                }}
                disabled={settingsLoading}
                data-testid="switch-hover-includeSystemTags"
              />
            </div>
          </CardContent>
        </Card>

        <EntityImportDialog
          entityPreview={entityPreview}
          entityPreviewSource={entityPreviewSource}
          entityImportWarnings={entityImportWarnings}
          showEntityDiff={showEntityDiff}
          setShowEntityDiff={setShowEntityDiff}
          overridesOnlyChanged={overridesOnlyChanged}
          setOverridesOnlyChanged={setOverridesOnlyChanged}
          entityDiffSearch={entityDiffSearch}
          setEntityDiffSearch={setEntityDiffSearch}
          entityDiffCategory={entityDiffCategory}
          setEntityDiffCategory={setEntityDiffCategory}
          isApplyingEntities={isApplyingEntities}
          onConfirm={handleConfirmEntityImport}
          onCancel={handleCancelEntityImport}
        />

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

        <NeedsReviewPanel />

        <LegacyRecoveryPanel />

        <StripMarkersPanel
          onRunningChange={setIsStripRunning}
        />

        <MigrationAuditPanel />


        <SecurityAttachmentSection />
        <DataManagementSection />
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

    </div>
  );
}
