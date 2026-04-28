import { useState } from "react";
import { Plus, Pencil, Trash2, Loader2, Tag, FolderOpen, Wallet, Key, User, Monitor, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { Separator } from "@/components/ui/separator";

import { useTags, createTag, updateTag, deleteTag, getTagUsageCount } from "@/hooks/use-tags";
import { useCategories, createCategory, updateCategory, deleteCategory, getCategoryUsageCount } from "@/hooks/use-categories";
import { useWalletNames, createWalletName, updateWalletName, deleteWalletName, getWalletNameUsageCount } from "@/hooks/use-wallet-names";
import { useSeedNames, createSeedName, updateSeedName, deleteSeedName, getSeedNameUsageCount, SEED_NAME_MAX_LENGTH } from "@/hooks/use-seed-names";
import { useOwners, createOwner, updateOwner, deleteOwner, getOwnerUsageCount } from "@/hooks/use-owners";
import { useWalletSoftware, createWalletSoftware, updateWalletSoftware, deleteWalletSoftware, getWalletSoftwareUsageCount } from "@/hooks/use-wallet-software";
import { db } from "@/lib/database";
import { bulkUpdateRecords } from "@/lib/dataFacade";

interface VocabItem {
  id?: number;
  name: string;
}

interface VocabSectionConfig {
  key: string;
  label: string;
  icon: typeof Tag;
  items: VocabItem[];
  isLoading: boolean;
  onCreate: (name: string) => Promise<any>;
  onUpdate: (id: number, data: { name: string }) => Promise<any>;
  onDelete: (id: number) => Promise<any>;
  getUsageCount: (name: string) => Promise<number>;
  propagateRename: (oldName: string, newName: string) => Promise<number>;
  maxLength?: number;
  maxLengthMessage?: string;
  deleteRemovesFromRecords?: boolean;
}

async function propagateTagRename(oldName: string, newName: string): Promise<number> {
  const records = await db.records.filter(r => r.tags.includes(oldName)).toArray();
  if (records.length === 0) return 0;
  await bulkUpdateRecords(
    records.map(record => ({
      id: record.id!,
      changes: { tags: record.tags.map(t => t === oldName ? newName : t) },
    }))
  );
  return records.length;
}

async function propagateCategoryRename(oldName: string, newName: string): Promise<number> {
  const records = await db.records.filter(r => r.categories.includes(oldName)).toArray();
  if (records.length === 0) return 0;
  await bulkUpdateRecords(
    records.map(record => ({
      id: record.id!,
      changes: { categories: record.categories.map(c => c === oldName ? newName : c) },
    }))
  );
  return records.length;
}

async function propagateStringFieldRename(field: string, oldName: string, newName: string): Promise<number> {
  const records = await db.records.where(field).equals(oldName).toArray();
  if (records.length === 0) return 0;
  await bulkUpdateRecords(
    records.map(record => ({
      id: record.id!,
      changes: { [field]: newName },
    }))
  );
  return records.length;
}

function VocabSection({ config }: { config: VocabSectionConfig }) {
  const { toast } = useToast();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingItem, setEditingItem] = useState<{ id: number; name: string; originalName: string } | null>(null);
  const [deletingItem, setDeletingItem] = useState<{ id: number; name: string; usageCount: number } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;

    if (config.maxLength && trimmed.length > config.maxLength) {
      toast({ title: "Error", description: config.maxLengthMessage || `Maximum ${config.maxLength} characters`, variant: "destructive" });
      return;
    }

    setIsProcessing(true);
    try {
      await config.onCreate(trimmed);
      setNewName("");
      setIsAdding(false);
      toast({ title: "Created", description: `"${trimmed}" has been added` });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to create", variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingItem) return;
    const trimmed = editingItem.name.trim();
    if (!trimmed) return;

    if (config.maxLength && trimmed.length > config.maxLength) {
      toast({ title: "Error", description: config.maxLengthMessage || `Maximum ${config.maxLength} characters`, variant: "destructive" });
      return;
    }

    if (trimmed === editingItem.originalName) {
      setEditingItem(null);
      return;
    }

    const duplicate = config.items.find(
      item => item.id !== editingItem.id && item.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      toast({ title: "Error", description: `"${trimmed}" already exists`, variant: "destructive" });
      return;
    }

    setIsProcessing(true);
    try {
      await config.onUpdate(editingItem.id, { name: trimmed });
      const updatedCount = await config.propagateRename(editingItem.originalName, trimmed);
      setEditingItem(null);
      const msg = updatedCount > 0
        ? `Renamed to "${trimmed}" and updated ${updatedCount} record${updatedCount !== 1 ? 's' : ''}`
        : `Renamed to "${trimmed}"`;
      toast({ title: "Updated", description: msg });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to update", variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingItem) return;

    setIsProcessing(true);
    try {
      await config.onDelete(deletingItem.id);
      setDeletingItem(null);
      toast({ title: "Deleted", description: `"${deletingItem.name}" has been removed` });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to delete", variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteClick = async (item: VocabItem) => {
    if (!item.id) return;
    const count = await config.getUsageCount(item.name);
    setDeletingItem({ id: item.id, name: item.name, usageCount: count });
  };

  const Icon = config.icon;

  return (
    <>
      <div className="space-y-2">
        <div
          className="flex items-center justify-between cursor-pointer py-1"
          onClick={() => setIsExpanded(!isExpanded)}
          data-testid={`vocab-section-toggle-${config.key}`}
        >
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{config.label}</span>
            <Badge variant="secondary" className="text-xs">{config.items.length}</Badge>
          </div>
          {isExpanded && (
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setIsAdding(true);
                setNewName("");
              }}
              data-testid={`button-add-${config.key}`}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          )}
        </div>

        {isExpanded && (
          <div className="ml-6 space-y-1">
            {config.isLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : config.items.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No {config.label.toLowerCase()} defined yet.
              </p>
            ) : (
              config.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between py-1.5 px-3 rounded-md bg-muted/50 group"
                  data-testid={`vocab-item-${config.key}-${item.id}`}
                >
                  <span className="text-sm truncate flex-1 mr-2">{item.name}</span>
                  <div className="flex items-center gap-1 invisible group-hover:visible">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEditingItem({ id: item.id!, name: item.name, originalName: item.name })}
                      data-testid={`button-edit-${config.key}-${item.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDeleteClick(item)}
                      data-testid={`button-delete-${config.key}-${item.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <Dialog open={isAdding} onOpenChange={(open) => !open && setIsAdding(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add {config.label.replace(/s$/, '')}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor={`add-${config.key}`}>Name</Label>
            <Input
              id={`add-${config.key}`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={`Enter ${config.label.toLowerCase().replace(/s$/, '')} name`}
              className="mt-2"
              maxLength={config.maxLength}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              data-testid={`input-add-${config.key}`}
            />
            {config.maxLength && (
              <p className="text-xs text-muted-foreground mt-1">
                {newName.length}/{config.maxLength} characters
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAdding(false)} disabled={isProcessing}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isProcessing || !newName.trim()} data-testid={`button-confirm-add-${config.key}`}>
              {isProcessing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editingItem !== null} onOpenChange={(open) => !open && setEditingItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {config.label.replace(/s$/, '')}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor={`edit-${config.key}`}>Name</Label>
            <Input
              id={`edit-${config.key}`}
              value={editingItem?.name || ""}
              onChange={(e) => setEditingItem(prev => prev ? { ...prev, name: e.target.value } : null)}
              placeholder={`Enter ${config.label.toLowerCase().replace(/s$/, '')} name`}
              className="mt-2"
              maxLength={config.maxLength}
              onKeyDown={(e) => { if (e.key === 'Enter') handleUpdate(); }}
              data-testid={`input-edit-${config.key}`}
            />
            {config.maxLength && editingItem && (
              <p className="text-xs text-muted-foreground mt-1">
                {editingItem.name.length}/{config.maxLength} characters
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingItem(null)} disabled={isProcessing}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={isProcessing || !editingItem?.name.trim()} data-testid={`button-confirm-edit-${config.key}`}>
              {isProcessing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deletingItem !== null} onOpenChange={(open) => !open && setDeletingItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {config.label.replace(/s$/, '')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingItem && deletingItem.usageCount > 0 ? (
                config.deleteRemovesFromRecords ? (
                  <>Are you sure you want to delete "{deletingItem.name}"? It is currently used by {deletingItem.usageCount} record{deletingItem.usageCount !== 1 ? 's' : ''} and will be removed from those records.</>
                ) : (
                  <>Are you sure you want to delete "{deletingItem.name}"? It is currently used by {deletingItem.usageCount} record{deletingItem.usageCount !== 1 ? 's' : ''}. The value will remain on those records but will no longer appear as a selectable option.</>
                )
              ) : (
                <>Are you sure you want to delete "{deletingItem?.name}"? This action cannot be undone.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} disabled={isProcessing} data-testid={`button-confirm-delete-${config.key}`}>
              {isProcessing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function VocabularyManager() {
  const { tags, isLoading: tagsLoading } = useTags();
  const { categories, isLoading: categoriesLoading } = useCategories();
  const { walletNames, isLoading: walletNamesLoading } = useWalletNames();
  const { seedNames, isLoading: seedNamesLoading } = useSeedNames();
  const { owners, isLoading: ownersLoading } = useOwners();
  const { walletSoftware, isLoading: walletSoftwareLoading } = useWalletSoftware();

  const sections: VocabSectionConfig[] = [
    {
      key: "tags",
      label: "Tags",
      icon: Tag,
      items: tags,
      isLoading: tagsLoading,
      onCreate: createTag,
      onUpdate: (id, data) => updateTag(id, data),
      onDelete: deleteTag,
      getUsageCount: getTagUsageCount,
      propagateRename: propagateTagRename,
      deleteRemovesFromRecords: true,
    },
    {
      key: "categories",
      label: "Categories",
      icon: FolderOpen,
      items: categories,
      isLoading: categoriesLoading,
      onCreate: createCategory,
      onUpdate: (id, data) => updateCategory(id, data),
      onDelete: deleteCategory,
      getUsageCount: getCategoryUsageCount,
      propagateRename: propagateCategoryRename,
      deleteRemovesFromRecords: true,
    },
    {
      key: "owners",
      label: "Owners",
      icon: User,
      items: owners,
      isLoading: ownersLoading,
      onCreate: createOwner,
      onUpdate: (id, data) => updateOwner(id, data),
      onDelete: deleteOwner,
      getUsageCount: getOwnerUsageCount,
      propagateRename: (oldName, newName) => propagateStringFieldRename('owner', oldName, newName),
    },
    {
      key: "wallet-names",
      label: "Wallet Names",
      icon: Wallet,
      items: walletNames,
      isLoading: walletNamesLoading,
      onCreate: createWalletName,
      onUpdate: (id, data) => updateWalletName(id, data),
      onDelete: deleteWalletName,
      getUsageCount: getWalletNameUsageCount,
      propagateRename: (oldName, newName) => propagateStringFieldRename('walletName', oldName, newName),
    },
    {
      key: "seed-names",
      label: "Seed Names",
      icon: Key,
      items: seedNames,
      isLoading: seedNamesLoading,
      onCreate: createSeedName,
      onUpdate: (id, data) => updateSeedName(id, data),
      onDelete: deleteSeedName,
      getUsageCount: getSeedNameUsageCount,
      propagateRename: (oldName, newName) => propagateStringFieldRename('seedName', oldName, newName),
      maxLength: SEED_NAME_MAX_LENGTH,
      maxLengthMessage: `Seed names are limited to ${SEED_NAME_MAX_LENGTH} characters to prevent accidental seed phrase entry`,
    },
    {
      key: "wallet-software",
      label: "Wallet Software",
      icon: Monitor,
      items: walletSoftware,
      isLoading: walletSoftwareLoading,
      onCreate: createWalletSoftware,
      onUpdate: (id, data) => updateWalletSoftware(id, data),
      onDelete: deleteWalletSoftware,
      getUsageCount: getWalletSoftwareUsageCount,
      propagateRename: (oldName, newName) => propagateStringFieldRename('walletSoftware', oldName, newName),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="h-5 w-5" />
          Vocabulary Management
        </CardTitle>
        <CardDescription>
          Manage your tags, categories, wallet names, and other vocabulary items. Renaming an item will update all records that use it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {sections.map((section, i) => (
          <div key={section.key}>
            <VocabSection config={section} />
            {i < sections.length - 1 && <Separator className="my-2" />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
