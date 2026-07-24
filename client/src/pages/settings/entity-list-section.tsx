import { useState, useRef } from "react";
import { Shield, Upload, Download, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { useSettings } from "@/hooks/use-settings";
import {
  prepareEntitySnapshot,
  applyEntitySnapshot,
  resetEntitySnapshot,
  serializeActiveEntityList,
  type EntitySnapshotError,
  type EntitySnapshotWarning,
  type EntitySnapshotPreview,
  type EntityListMode,
} from "@/lib/data/entity-list-store";
import { getBundledEntityCount, type EntityCategory } from "@/lib/privacy-entity-list";
import { EntityImportDialog } from "./entity-import-dialog";
import { EntityErrorList } from "./entity-errors";

export function EntityListSection() {
  const { settings } = useSettings();
  const { toast } = useToast();

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

  return (
    <>
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
    </>
  );
}
