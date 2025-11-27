import { useState, useEffect } from "react";
import { Plus, Tag, FolderOpen, Edit, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getTagUsageCount } from "@/hooks/use-tags";
import { getCategoryUsageCount } from "@/hooks/use-categories";
import { useEncryptedTags, useEncryptedCategories } from "@/hooks/use-encrypted-records";
import { createTag, updateTag, deleteTag, createCategory, updateCategory, deleteCategory } from "@/lib/encryptionFacade";
import { useToast } from "@/hooks/use-toast";
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

export default function TagsPage() {
  const [newTag, setNewTag] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'tag' | 'category'; id: number; name: string } | null>(null);
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({});
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});

  const { tags, isLoading: tagsLoading } = useEncryptedTags();
  const { categories, isLoading: categoriesLoading } = useEncryptedCategories();
  const { toast } = useToast();

  // Load usage counts
  useEffect(() => {
    const loadCounts = async () => {
      const newTagCounts: Record<string, number> = {};
      const newCategoryCounts: Record<string, number> = {};

      for (const tag of tags) {
        newTagCounts[tag.name] = await getTagUsageCount(tag.name);
      }

      for (const category of categories) {
        newCategoryCounts[category.name] = await getCategoryUsageCount(category.name);
      }

      setTagCounts(newTagCounts);
      setCategoryCounts(newCategoryCounts);
    };

    loadCounts();
  }, [tags, categories]);

  const handleAddTag = async () => {
    if (!newTag.trim()) return;

    try {
      await createTag(newTag.trim());
      toast({
        title: "Tag Created",
        description: `Tag "${newTag}" has been created`,
      });
      setNewTag("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create tag",
      });
    }
  };

  const handleAddCategory = async () => {
    if (!newCategory.trim()) return;

    try {
      await createCategory(newCategory.trim());
      toast({
        title: "Category Created",
        description: `Category "${newCategory}" has been created`,
      });
      setNewCategory("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create category",
      });
    }
  };

  const handleUpdateTag = async (id: number, newName: string) => {
    if (!newName.trim()) return;

    try {
      await updateTag(id, { name: newName.trim() });
      toast({
        title: "Tag Updated",
        description: `Tag has been renamed to "${newName}"`,
      });
      setEditingTagId(null);
      setEditingTagName("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update tag",
      });
    }
  };

  const handleUpdateCategory = async (id: number, newName: string) => {
    if (!newName.trim()) return;

    try {
      await updateCategory(id, { name: newName.trim() });
      toast({
        title: "Category Updated",
        description: `Category has been renamed to "${newName}"`,
      });
      setEditingCategoryId(null);
      setEditingCategoryName("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update category",
      });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;

    try {
      if (deleteTarget.type === 'tag') {
        await deleteTag(deleteTarget.id);
        toast({
          title: "Tag Deleted",
          description: `Tag "${deleteTarget.name}" has been deleted`,
        });
      } else {
        await deleteCategory(deleteTarget.id);
        toast({
          title: "Category Deleted",
          description: `Category "${deleteTarget.name}" has been deleted`,
        });
      }
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete",
      });
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Tags & Categories</h1>
          <p className="text-muted-foreground">
            Manage custom vocabularies for organizing your Bitcoin records
          </p>
        </div>

        <Tabs defaultValue="tags">
          <TabsList>
            <TabsTrigger value="tags" data-testid="tab-tags">
              <Tag className="h-4 w-4 mr-2" />
              Tags
            </TabsTrigger>
            <TabsTrigger value="categories" data-testid="tab-categories">
              <FolderOpen className="h-4 w-4 mr-2" />
              Categories
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tags" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Add New Tag</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                    placeholder="Tag name"
                    data-testid="input-new-tag"
                  />
                  <Button onClick={handleAddTag} data-testid="button-add-tag">
                    <Plus className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>

            {tagsLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading tags...</div>
            ) : tags.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No tags yet. Create your first tag above.
              </div>
            ) : (
              <div className="grid gap-4">
                {tags.map((tag) => (
                  <Card key={tag.id} className="hover-elevate" data-testid={`card-tag-${tag.id}`}>
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-3 flex-1">
                        <Tag className="h-5 w-5 text-muted-foreground" />
                        <div className="flex-1">
                          {editingTagId === tag.id ? (
                            <div className="flex gap-2">
                              <Input
                                value={editingTagName}
                                onChange={(e) => setEditingTagName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleUpdateTag(tag.id!, editingTagName);
                                  } else if (e.key === 'Escape') {
                                    setEditingTagId(null);
                                    setEditingTagName("");
                                  }
                                }}
                                autoFocus
                                data-testid={`input-edit-tag-${tag.id}`}
                              />
                              <Button
                                size="sm"
                                onClick={() => handleUpdateTag(tag.id!, editingTagName)}
                                data-testid={`button-save-tag-${tag.id}`}
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditingTagId(null);
                                  setEditingTagName("");
                                }}
                                data-testid={`button-cancel-tag-${tag.id}`}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <>
                              <h3 className="font-semibold">{tag.name}</h3>
                              <p className="text-sm text-muted-foreground">
                                Used in {tagCounts[tag.name] || 0} records
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                      {editingTagId !== tag.id && (
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              setEditingTagId(tag.id!);
                              setEditingTagName(tag.name);
                            }}
                            data-testid={`button-edit-${tag.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              setDeleteTarget({ type: 'tag', id: tag.id!, name: tag.name });
                              setDeleteDialogOpen(true);
                            }}
                            data-testid={`button-delete-${tag.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="categories" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Add New Category</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
                    placeholder="Category name"
                    data-testid="input-new-category"
                  />
                  <Button onClick={handleAddCategory} data-testid="button-add-category">
                    <Plus className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>

            {categoriesLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading categories...</div>
            ) : categories.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No categories yet. Create your first category above.
              </div>
            ) : (
              <div className="grid gap-4">
                {categories.map((category) => (
                  <Card key={category.id} className="hover-elevate" data-testid={`card-category-${category.id}`}>
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-3 flex-1">
                        <FolderOpen className="h-5 w-5 text-muted-foreground" />
                        <div className="flex-1">
                          {editingCategoryId === category.id ? (
                            <div className="flex gap-2">
                              <Input
                                value={editingCategoryName}
                                onChange={(e) => setEditingCategoryName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleUpdateCategory(category.id!, editingCategoryName);
                                  } else if (e.key === 'Escape') {
                                    setEditingCategoryId(null);
                                    setEditingCategoryName("");
                                  }
                                }}
                                autoFocus
                                data-testid={`input-edit-category-${category.id}`}
                              />
                              <Button
                                size="sm"
                                onClick={() => handleUpdateCategory(category.id!, editingCategoryName)}
                                data-testid={`button-save-category-${category.id}`}
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditingCategoryId(null);
                                  setEditingCategoryName("");
                                }}
                                data-testid={`button-cancel-category-${category.id}`}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <>
                              <h3 className="font-semibold">{category.name}</h3>
                              <p className="text-sm text-muted-foreground">
                                {categoryCounts[category.name] || 0} records
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                      {editingCategoryId !== category.id && (
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              setEditingCategoryId(category.id!);
                              setEditingCategoryName(category.name);
                            }}
                            data-testid={`button-edit-cat-${category.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              setDeleteTarget({ type: 'category', id: category.id!, name: category.name });
                              setDeleteDialogOpen(true);
                            }}
                            data-testid={`button-delete-cat-${category.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This will delete "{deleteTarget?.name}" and remove it from all records. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
