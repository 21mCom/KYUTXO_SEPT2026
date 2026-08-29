import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Upload, AlertTriangle, Search, ChevronDown, ChevronRight } from "lucide-react";
import { AddressLink } from "@/components/AddressLink";
import {
  ENTITY_CATEGORY_LABELS,
  type EntityCategory,
} from "@/lib/privacy-entity-list";
import {
  type EntitySnapshotPreview,
  type EntitySnapshotWarning,
} from "@/lib/data/entity-list-store";
import { EntityDiffList, ChangedEntityList, EntityOverrideList } from "./entity-lists";

export interface EntityImportDialogProps {
  entityPreview: EntitySnapshotPreview | null;
  entityPreviewSource: string | undefined;
  entityImportWarnings: EntitySnapshotWarning[];
  showEntityDiff: boolean;
  setShowEntityDiff: React.Dispatch<React.SetStateAction<boolean>>;
  overridesOnlyChanged: boolean;
  setOverridesOnlyChanged: (v: boolean) => void;
  entityDiffSearch: string;
  setEntityDiffSearch: (v: string) => void;
  entityDiffCategory: EntityCategory | "all";
  setEntityDiffCategory: (v: EntityCategory | "all") => void;
  isApplyingEntities: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function EntityImportDialog({
  entityPreview,
  entityPreviewSource,
  entityImportWarnings,
  showEntityDiff,
  setShowEntityDiff,
  overridesOnlyChanged,
  setOverridesOnlyChanged,
  entityDiffSearch,
  setEntityDiffSearch,
  entityDiffCategory,
  setEntityDiffCategory,
  isApplyingEntities,
  onConfirm,
  onCancel,
}: EntityImportDialogProps) {
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
    () =>
      overridesOnlyChanged
        ? searchedOverrides.filter((o) => o.changed)
        : searchedOverrides,
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

  const entityDiffFiltering =
    entityDiffSearch.trim().length > 0 || entityDiffCategory !== "all";

  return (
    <Dialog
      open={!!entityPreview}
      onOpenChange={(open) => {
        if (!open && !isApplyingEntities) onCancel();
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
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
            onClick={onCancel}
            disabled={isApplyingEntities}
            data-testid="button-cancel-entity-import"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
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
  );
}
