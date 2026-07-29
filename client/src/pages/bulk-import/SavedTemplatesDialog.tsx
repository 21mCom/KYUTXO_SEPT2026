import { useEffect, useState } from "react";
import { Loader2, LibraryBig, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getAllDerivationTemplates,
  deleteDerivationTemplate,
} from "@/lib/data/derivation-templates-crud";
import type { DerivationTemplate } from "@/lib/database";

interface SavedTemplatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (template: DerivationTemplate) => void;
}

export default function SavedTemplatesDialog({
  open,
  onOpenChange,
  onApply,
}: SavedTemplatesDialogProps) {
  const [templates, setTemplates] = useState<DerivationTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await deleteDerivationTemplate(id);
      const rows = await getAllDerivationTemplates();
      setTemplates([...rows].sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Failed to delete template"
      );
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTemplates(null);
    setLoadError(null);
    setDeleteError(null);
    getAllDerivationTemplates()
      .then((rows) => {
        if (cancelled) return;
        // Newest first
        setTemplates([...rows].sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(
          error instanceof Error ? error.message : "Failed to load templates"
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-saved-templates">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LibraryBig className="h-5 w-5" />
            Saved Derivation Templates
          </DialogTitle>
          <DialogDescription>
            Pick a template saved during a previous import to re-derive
            addresses with the same key, script type, and gap limit.
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <p className="text-sm text-destructive" data-testid="text-templates-error">
            {loadError}
          </p>
        )}

        {deleteError && (
          <p className="text-sm text-destructive" data-testid="text-template-delete-error">
            {deleteError}
          </p>
        )}

        {!loadError && templates === null && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {templates !== null && templates.length === 0 && (
          <p
            className="text-sm text-muted-foreground py-4"
            data-testid="text-no-templates"
          >
            No saved templates yet. Turn on "Save template for future
            derivations" when importing an xpub to create one.
          </p>
        )}

        {templates !== null && templates.length > 0 && (
          <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
            {templates.map((t) => {
              const hasXpub = Boolean(t.xpub && t.xpub.trim());
              const title =
                t.walletName || t.seedName || `Fingerprint ${t.fingerprint}`;
              return (
                <div
                  key={t.id}
                  className="border rounded-md p-3 space-y-2"
                  data-testid={`template-row-${t.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{title}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {t.derivationPath}
                        {hasXpub ? ` · ${t.xpub!.substring(0, 16)}…` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        disabled={!hasXpub}
                        onClick={() => onApply(t)}
                        data-testid={`button-use-template-${t.id}`}
                      >
                        Use
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        disabled={deletingId !== null}
                        onClick={() => handleDelete(t.id!)}
                        aria-label="Delete template"
                        data-testid={`button-delete-template-${t.id}`}
                      >
                        {deletingId === t.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{t.scriptType}</Badge>
                    <Badge variant="outline">Gap limit {t.gapLimit}</Badge>
                    <Badge variant="outline">{t.network}</Badge>
                    {t.owner && <Badge variant="outline">{t.owner}</Badge>}
                    <Badge variant="outline">
                      Saved {new Date(t.createdAt).toLocaleDateString()}
                    </Badge>
                  </div>
                  {!hasXpub && (
                    <p className="text-xs text-muted-foreground">
                      This template has no stored key, so it can't be used to
                      re-derive addresses.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
