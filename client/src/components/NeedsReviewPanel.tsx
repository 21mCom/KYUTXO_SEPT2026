import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckSquare,
  FileWarning,
  FolderOpen,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { useToast } from "@/hooks/use-toast";
import { isElectron, getElectronAPI, type NeedsReviewFile } from "@/lib/electron";
import { formatFileSize, uploadAttachment } from "@/lib/attachments";
import { searchRecordsForPicker } from "@/lib/data/record-crud";
import type { Record as KyRecord } from "@/lib/db-types";

// A persistent, in-app review surface for orphaned attachment files — those
// whose owning record was absent in a restored backup and so were routed to the
// Needs Review folder on disk. Restore surfaces them via a transient toast that
// is easy to miss; this panel keeps them visible until the user re-attaches each
// file to a record or deletes it, so evidence is never silently lost.
//
// Desktop only: the Needs Review folder is a real filesystem directory. The web
// build has no such folder, so the panel renders nothing there (no broken UI).
export default function NeedsReviewPanel() {
  const { toast } = useToast();
  const [files, setFiles] = useState<NeedsReviewFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Multi-select state.
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());

  // Re-attach dialog state (single or bulk).
  const [reattachTarget, setReattachTarget] = useState<NeedsReviewFile | null>(null);
  // When bulk re-attaching, holds the full set of files to attach.
  const [bulkReattachFiles, setBulkReattachFiles] = useState<NeedsReviewFile[]>([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<KyRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [reattaching, setReattaching] = useState(false);
  const [reattachProgress, setReattachProgress] = useState<{ done: number; total: number } | null>(null);

  // Delete confirmation state.
  const [deleteTarget, setDeleteTarget] = useState<NeedsReviewFile | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk delete state.
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const searchSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    setSelectedNames(new Set());
    try {
      const result = await getElectronAPI().listNeedsReview();
      if (!result.success) {
        throw new Error(result.error ?? "Could not read the Needs Review folder");
      }
      setFiles(result.files ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not read the Needs Review folder");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Debounced record search for the re-attach picker.
  useEffect(() => {
    const hasTarget = reattachTarget !== null || bulkReattachFiles.length > 0;
    if (!hasTarget) return;
    const q = search.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeqRef.current;
    const handle = setTimeout(async () => {
      try {
        const found = await searchRecordsForPicker(q, 25);
        if (seq === searchSeqRef.current) setResults(found);
      } catch {
        if (seq === searchSeqRef.current) setResults([]);
      } finally {
        if (seq === searchSeqRef.current) setSearching(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [search, reattachTarget, bulkReattachFiles]);

  // ---- selection helpers ----

  const toggleSelect = (name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const allSelected = (files?.length ?? 0) > 0 && selectedNames.size === (files?.length ?? 0);
  const someSelected = selectedNames.size > 0;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedNames(new Set());
    } else {
      setSelectedNames(new Set(files?.map((f) => f.name) ?? []));
    }
  };

  // ---- single re-attach ----

  const openReattach = (file: NeedsReviewFile) => {
    setReattachTarget(file);
    setBulkReattachFiles([]);
    setSearch("");
    setResults([]);
  };

  const closeReattach = () => {
    if (reattaching) return;
    setReattachTarget(null);
    setBulkReattachFiles([]);
    setSearch("");
    setResults([]);
    setReattachProgress(null);
  };

  const handleReattach = async (record: KyRecord) => {
    const targets = bulkReattachFiles.length > 0 ? bulkReattachFiles : reattachTarget ? [reattachTarget] : [];
    if (targets.length === 0 || record.id === undefined) return;
    setReattaching(true);
    setReattachProgress({ done: 0, total: targets.length });

    const api = getElectronAPI();
    let attached = 0;
    let deleteFailedCount = 0;
    const errors: string[] = [];

    for (const target of targets) {
      try {
        const read = await api.readNeedsReview(target.name);
        if (!read.success || !read.data) {
          throw new Error(read.error ?? "Could not read the file from disk");
        }
        const file = new File([read.data], target.name);
        await uploadAttachment(record.id, file, record.inputString);
        attached++;

        // Best-effort delete of the on-disk orphan after upload.
        const del = await api.deleteNeedsReview(target.name);
        if (!del.success) {
          deleteFailedCount++;
        }
      } catch (err) {
        errors.push(target.name + (err instanceof Error ? `: ${err.message}` : ""));
      }
      setReattachProgress((prev) => prev ? { done: prev.done + 1, total: prev.total } : null);
    }

    setReattaching(false);
    setReattachProgress(null);
    setReattachTarget(null);
    setBulkReattachFiles([]);
    setSearch("");
    setResults([]);
    setSelectedNames(new Set());

    if (attached > 0 && errors.length === 0 && deleteFailedCount === 0) {
      // Complete success.
      toast({
        title: targets.length === 1 ? "Re-attached" : `Re-attached ${attached} file${attached !== 1 ? "s" : ""}`,
        description:
          targets.length === 1
            ? `"${targets[0].name}" is now attached to ${recordTitle(record)}.`
            : `${attached} file${attached !== 1 ? "s" : ""} attached to ${recordTitle(record)}.`,
      });
    } else if (attached > 0 && deleteFailedCount > 0 && errors.length === 0) {
      // Files were attached but the originals couldn't be removed from Needs Review.
      // Show a success-with-warning rather than an error, so the user knows the
      // attachment succeeded and doesn't double-attach. They can clean up the
      // stale Needs Review entry manually.
      toast({
        title: `File${attached !== 1 ? "s" : ""} attached — original${deleteFailedCount !== 1 ? "s" : ""} still on disk`,
        description:
          `${attached} file${attached !== 1 ? "s were" : " was"} successfully attached to ${recordTitle(record)}, but ${deleteFailedCount} original${deleteFailedCount !== 1 ? " files" : " file"} in the Needs Review folder couldn't be removed. ` +
          `Use the Delete button to remove the stale ${deleteFailedCount !== 1 ? "entries" : "entry"} manually.`,
        variant: "destructive",
      });
    } else if (attached > 0 && errors.length > 0) {
      toast({
        title: `Partial re-attach (${attached} of ${targets.length})`,
        description: `${attached} file${attached !== 1 ? "s" : ""} attached. ${errors.length} failed: ${errors.slice(0, 2).join("; ")}${errors.length > 2 ? "…" : ""}`,
        variant: "destructive",
      });
    } else if (attached === 0) {
      toast({
        title: "Couldn't re-attach file",
        description: errors[0] ?? "Unknown error",
        variant: "destructive",
      });
    }

    await refresh();
  };

  // ---- bulk re-attach ----

  const openBulkReattach = () => {
    const targets = files?.filter((f) => selectedNames.has(f.name)) ?? [];
    if (targets.length === 0) return;
    setBulkReattachFiles(targets);
    setReattachTarget(null);
    setSearch("");
    setResults([]);
  };

  // ---- single delete ----

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await getElectronAPI().deleteNeedsReview(deleteTarget.name);
      if (!result.success) {
        throw new Error(result.error ?? "Delete failed");
      }
      toast({
        title: "File deleted",
        description: `"${deleteTarget.name}" was removed from the Needs Review folder.`,
      });
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      toast({
        title: "Couldn't delete file",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  // ---- bulk delete ----

  const handleBulkDelete = async () => {
    const targets = files?.filter((f) => selectedNames.has(f.name)) ?? [];
    if (targets.length === 0) return;
    setBulkDeleting(true);
    let deleted = 0;
    const failed: string[] = [];
    const api = getElectronAPI();
    for (const target of targets) {
      try {
        const result = await api.deleteNeedsReview(target.name);
        if (result.success) deleted++;
        else failed.push(target.name);
      } catch {
        failed.push(target.name);
      }
    }
    setBulkDeleting(false);
    setBulkDeleteConfirmOpen(false);
    setSelectedNames(new Set());
    if (deleted > 0 && failed.length === 0) {
      toast({
        title: `${deleted} file${deleted !== 1 ? "s" : ""} deleted`,
        description: `Removed ${deleted} file${deleted !== 1 ? "s" : ""} from the Needs Review folder.`,
      });
    } else if (deleted > 0) {
      toast({
        title: `Partial delete (${deleted} of ${targets.length})`,
        description: `${deleted} deleted, ${failed.length} could not be removed.`,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Couldn't delete files",
        description: `None of the ${targets.length} selected files could be removed.`,
        variant: "destructive",
      });
    }
    await refresh();
  };

  // Web build: no Needs Review folder exists. Render nothing rather than an
  // empty or broken card.
  if (!isElectron()) return null;

  // Nothing to review and no error: hide the section entirely (success state).
  if (!loading && !loadError && (files?.length ?? 0) === 0) return null;

  const selectedFiles = files?.filter((f) => selectedNames.has(f.name)) ?? [];
  const reattachDialogOpen = reattachTarget !== null || bulkReattachFiles.length > 0;
  const reattachDescription =
    bulkReattachFiles.length > 1
      ? `Search for the record that these ${bulkReattachFiles.length} files belong to, then choose it to attach all of them.`
      : reattachTarget
        ? undefined
        : undefined;

  return (
    <>
      <Card data-testid="card-needs-review">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileWarning className="h-5 w-5" />
            Needs Review
            {files && files.length > 0 && (
              <span
                className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-medium text-destructive-foreground"
                data-testid="badge-needs-review-count"
              >
                {files.length}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            Attachment files from a restored backup whose owning record was missing. Re-attach each
            one to the correct record, or delete it if it's no longer needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="status-needs-review-loading">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking for files…
            </div>
          ) : loadError ? (
            <div
              className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2"
              data-testid="status-needs-review-error"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{loadError}</span>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between flex-wrap gap-2">
                {/* Select-all checkbox */}
                {(files?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover-elevate active-elevate-2 rounded px-1 py-0.5"
                    data-testid="button-needs-review-select-all"
                    aria-label={allSelected ? "Deselect all" : "Select all"}
                  >
                    {allSelected ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                    <span>{allSelected ? "Deselect all" : "Select all"}</span>
                  </button>
                )}
                <div className="flex items-center gap-2 ml-auto">
                  {/* Bulk actions — only when files are selected */}
                  {someSelected && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openBulkReattach}
                        data-testid="button-bulk-reattach"
                      >
                        <Paperclip className="h-4 w-4" />
                        Re-attach {selectedNames.size}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setBulkDeleteConfirmOpen(true)}
                        data-testid="button-bulk-delete"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete {selectedNames.size}
                      </Button>
                    </>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refresh()}
                    data-testid="button-refresh-needs-review"
                    aria-label="Refresh"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => getElectronAPI().openNeedsReviewFolder()}
                    data-testid="button-open-needs-review-folder"
                  >
                    <FolderOpen className="h-4 w-4" />
                    Open folder
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                {files?.map((file) => {
                  const isSelected = selectedNames.has(file.name);
                  return (
                    <div
                      key={file.name}
                      className={`flex items-center gap-3 flex-wrap rounded-md border bg-background p-3 ${isSelected ? "border-primary/50 bg-primary/5" : ""}`}
                      data-testid={`row-needs-review-${file.name}`}
                    >
                      {/* Checkbox */}
                      <button
                        type="button"
                        onClick={() => toggleSelect(file.name)}
                        className="shrink-0 text-muted-foreground hover-elevate active-elevate-2 rounded"
                        data-testid={`checkbox-needs-review-${file.name}`}
                        aria-label={isSelected ? `Deselect ${file.name}` : `Select ${file.name}`}
                      >
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                      <div className="min-w-0 flex items-start gap-2 flex-1">
                        <Paperclip className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium break-all" data-testid={`text-needs-review-name-${file.name}`}>
                            {file.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)} · routed {new Date(file.routedAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openReattach(file)}
                          data-testid={`button-reattach-${file.name}`}
                        >
                          <Paperclip className="h-4 w-4" />
                          Re-attach
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDeleteTarget(file)}
                          data-testid={`button-delete-needs-review-${file.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Re-attach dialog (single or bulk) */}
      <Dialog open={reattachDialogOpen} onOpenChange={(open) => { if (!open) closeReattach(); }}>
        <DialogContent data-testid="dialog-reattach">
          <DialogHeader>
            <DialogTitle>
              {bulkReattachFiles.length > 1 ? `Re-attach ${bulkReattachFiles.length} files` : "Re-attach file"}
            </DialogTitle>
            <DialogDescription>
              {bulkReattachFiles.length > 1
                ? reattachDescription
                : (
                  <>
                    Search for the record that{" "}
                    <span className="font-medium break-all">{reattachTarget?.name}</span> belongs to, then
                    choose it to attach the file.
                  </>
                )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by address, transaction ID, or label"
                className="pl-8"
                disabled={reattaching}
                data-testid="input-reattach-search"
              />
            </div>
            {reattachProgress && (
              <p className="text-sm text-muted-foreground">
                Attaching {reattachProgress.done} of {reattachProgress.total}…
              </p>
            )}
            <div className="max-h-72 overflow-y-auto space-y-1" data-testid="list-reattach-results">
              {searching ? (
                <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Searching…
                </div>
              ) : search.trim() && results.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground" data-testid="text-reattach-no-results">
                  No matching records found.
                </p>
              ) : (
                results.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    onClick={() => handleReattach(record)}
                    disabled={reattaching}
                    className="w-full rounded-md border bg-background p-2 text-left hover-elevate active-elevate-2 disabled:opacity-60"
                    data-testid={`button-pick-record-${record.id}`}
                  >
                    <p className="text-sm font-medium truncate">{record.label || "(no label)"}</p>
                    <p className="text-xs text-muted-foreground break-all">{record.inputString}</p>
                  </button>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeReattach} disabled={reattaching} data-testid="button-cancel-reattach">
              Cancel
            </Button>
            {reattaching && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Attaching…
              </span>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Single-file delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent data-testid="dialog-delete-needs-review">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium break-all">{deleteTarget?.name}</span> will be permanently
              removed from the Needs Review folder. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} data-testid="button-cancel-delete-needs-review">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleDelete(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive"
              data-testid="button-confirm-delete-needs-review"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirmation */}
      <AlertDialog open={bulkDeleteConfirmOpen} onOpenChange={(open) => { if (!open && !bulkDeleting) setBulkDeleteConfirmOpen(false); }}>
        <AlertDialogContent data-testid="dialog-bulk-delete-needs-review">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedNames.size} file{selectedNames.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedNames.size} file{selectedNames.size !== 1 ? "s" : ""} will be permanently removed from the
              Needs Review folder. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting} data-testid="button-cancel-bulk-delete">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleBulkDelete(); }}
              disabled={bulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive"
              data-testid="button-confirm-bulk-delete"
            >
              {bulkDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete {selectedNames.size}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function recordTitle(record: KyRecord): string {
  if (record.label) return record.label;
  const s = record.inputString;
  return s.length > 16 ? `${s.slice(0, 12)}…` : s;
}
