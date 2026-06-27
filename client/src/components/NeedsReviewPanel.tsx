import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  FileWarning,
  FolderOpen,
  Loader2,
  Paperclip,
  Search,
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

  // Re-attach dialog state.
  const [reattachTarget, setReattachTarget] = useState<NeedsReviewFile | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<KyRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [reattaching, setReattaching] = useState(false);

  // Delete confirmation state.
  const [deleteTarget, setDeleteTarget] = useState<NeedsReviewFile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const searchSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
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
    if (!reattachTarget) return;
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
  }, [search, reattachTarget]);

  const openReattach = (file: NeedsReviewFile) => {
    setReattachTarget(file);
    setSearch("");
    setResults([]);
  };

  const closeReattach = () => {
    if (reattaching) return;
    setReattachTarget(null);
    setSearch("");
    setResults([]);
  };

  const handleReattach = async (record: KyRecord) => {
    if (!reattachTarget || record.id === undefined) return;
    setReattaching(true);
    try {
      const api = getElectronAPI();
      const read = await api.readNeedsReview(reattachTarget.name);
      if (!read.success || !read.data) {
        throw new Error(read.error ?? "Could not read the file from disk");
      }
      const file = new File([read.data], reattachTarget.name);
      await uploadAttachment(record.id, file, record.inputString);
      // Only remove the on-disk orphan after the attachment is safely stored.
      const del = await api.deleteNeedsReview(reattachTarget.name);
      if (!del.success) {
        throw new Error(del.error ?? "Attached, but the original file could not be removed");
      }
      toast({
        title: "Re-attached",
        description: `"${reattachTarget.name}" is now attached to ${recordTitle(record)}.`,
      });
      setReattachTarget(null);
      setSearch("");
      setResults([]);
      await refresh();
    } catch (error) {
      toast({
        title: "Couldn't re-attach file",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setReattaching(false);
    }
  };

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

  // Web build: no Needs Review folder exists. Render nothing rather than an
  // empty or broken card.
  if (!isElectron()) return null;

  // Nothing to review and no error: hide the section entirely (success state).
  if (!loading && !loadError && (files?.length ?? 0) === 0) return null;

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
              <div className="flex items-center justify-end">
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
              <div className="space-y-2">
                {files?.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center justify-between gap-3 flex-wrap rounded-md border bg-background p-3"
                    data-testid={`row-needs-review-${file.name}`}
                  >
                    <div className="min-w-0 flex items-start gap-2">
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
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={reattachTarget !== null} onOpenChange={(open) => { if (!open) closeReattach(); }}>
        <DialogContent data-testid="dialog-reattach">
          <DialogHeader>
            <DialogTitle>Re-attach file</DialogTitle>
            <DialogDescription>
              Search for the record that{" "}
              <span className="font-medium break-all">{reattachTarget?.name}</span> belongs to, then
              choose it to attach the file.
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
    </>
  );
}

function recordTitle(record: KyRecord): string {
  if (record.label) return record.label;
  const s = record.inputString;
  return s.length > 16 ? `${s.slice(0, 12)}…` : s;
}
