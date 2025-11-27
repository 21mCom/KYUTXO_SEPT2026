import { useState, useEffect, useMemo } from "react";
import { Edit, Tag, FolderOpen, Wallet, Sprout, Users, FileText, Plus, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEncryptedRecords, useEncryptedTags, useEncryptedCategories } from "@/hooks/use-encrypted-records";
import { 
  updateRecord, 
  decryptRecords, 
  createTag, 
  updateTag, 
  deleteTag, 
  createCategory, 
  updateCategory, 
  deleteCategory 
} from "@/lib/encryptionFacade";
import { useToast } from "@/hooks/use-toast";
import { db, type Record } from "@/lib/database";
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

type FieldType = 'tags' | 'categories' | 'walletSoftware' | 'seedName' | 'counterparty' | 'source';

interface UniqueValue {
  value: string;
  count: number;
}

interface FieldConfig {
  key: FieldType;
  label: string;
  icon: typeof Tag;
  description: string;
  isArray: boolean;
  hasMasterList: boolean;
}

const FIELD_CONFIGS: FieldConfig[] = [
  { 
    key: 'tags', 
    label: 'Tags', 
    icon: Tag, 
    description: 'Labels for organizing records',
    isArray: true,
    hasMasterList: true,
  },
  { 
    key: 'categories', 
    label: 'Categories', 
    icon: FolderOpen, 
    description: 'Group records into categories',
    isArray: true,
    hasMasterList: true,
  },
  { 
    key: 'walletSoftware', 
    label: 'Wallet Software', 
    icon: Wallet, 
    description: 'Wallet applications used',
    isArray: false,
    hasMasterList: false,
  },
  { 
    key: 'seedName', 
    label: 'Seed Name', 
    icon: Sprout, 
    description: 'Named seed phrases',
    isArray: false,
    hasMasterList: false,
  },
  { 
    key: 'counterparty', 
    label: 'Counterparty', 
    icon: Users, 
    description: 'Other parties in transactions',
    isArray: false,
    hasMasterList: false,
  },
  { 
    key: 'source', 
    label: 'Source', 
    icon: FileText, 
    description: 'Origin of the record',
    isArray: false,
    hasMasterList: false,
  },
];

export default function ValueUpdaterPage() {
  const { records, isLoading: recordsLoading } = useEncryptedRecords();
  const { tags, isLoading: tagsLoading } = useEncryptedTags();
  const { categories, isLoading: categoriesLoading } = useEncryptedCategories();
  const { toast } = useToast();
  
  const [editingField, setEditingField] = useState<FieldType | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [newValue, setNewValue] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ field: FieldType; value: string; count: number } | null>(null);
  const [newItemField, setNewItemField] = useState<FieldType | null>(null);
  const [newItemValue, setNewItemValue] = useState("");

  const extractUniqueValues = (field: FieldType): UniqueValue[] => {
    const valueCounts = new Map<string, number>();
    
    for (const record of records) {
      if (FIELD_CONFIGS.find(f => f.key === field)?.isArray) {
        const values = record[field] as string[] | undefined;
        if (values && Array.isArray(values)) {
          for (const v of values) {
            if (v && typeof v === 'string' && v.trim()) {
              const normalized = v.trim();
              valueCounts.set(normalized, (valueCounts.get(normalized) || 0) + 1);
            }
          }
        }
      } else {
        const value = record[field] as string | undefined;
        if (value && typeof value === 'string' && value.trim()) {
          const normalized = value.trim();
          valueCounts.set(normalized, (valueCounts.get(normalized) || 0) + 1);
        }
      }
    }
    
    return Array.from(valueCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value));
  };

  const getUnusedMasterItems = (field: 'tags' | 'categories'): string[] => {
    const usedValues = new Set(extractUniqueValues(field).map(v => v.value.toLowerCase()));
    
    if (field === 'tags') {
      return tags
        .filter(t => !usedValues.has(t.name.toLowerCase()))
        .map(t => t.name);
    } else {
      return categories
        .filter(c => !usedValues.has(c.name.toLowerCase()))
        .map(c => c.name);
    }
  };

  const handleUpdateValue = async (field: FieldType, oldValue: string, newValueInput: string) => {
    if (!newValueInput.trim() || newValueInput.trim() === oldValue) {
      setEditingField(null);
      setEditingValue("");
      setNewValue("");
      return;
    }

    setIsUpdating(true);
    const trimmedNewValue = newValueInput.trim();
    
    try {
      let updateCount = 0;
      const config = FIELD_CONFIGS.find(f => f.key === field)!;
      
      for (const record of records) {
        let needsUpdate = false;
        let updatedData: Partial<Record> = {};
        
        if (config.isArray) {
          const currentValues = (record[field] as string[] | undefined) || [];
          if (currentValues.includes(oldValue)) {
            const newValues = currentValues.map(v => v === oldValue ? trimmedNewValue : v);
            const uniqueValues = Array.from(new Set(newValues));
            updatedData[field] = uniqueValues as any;
            needsUpdate = true;
          }
        } else {
          if (record[field] === oldValue) {
            updatedData[field] = trimmedNewValue as any;
            needsUpdate = true;
          }
        }
        
        if (needsUpdate && record.id) {
          await updateRecord(record.id, updatedData);
          updateCount++;
        }
      }

      if (config.hasMasterList) {
        if (field === 'tags') {
          const tag = tags.find(t => t.name === oldValue);
          if (tag?.id) {
            await updateTag(tag.id, { name: trimmedNewValue });
          }
        } else if (field === 'categories') {
          const category = categories.find(c => c.name === oldValue);
          if (category?.id) {
            await updateCategory(category.id, { name: trimmedNewValue });
          }
        }
      }

      toast({
        title: "Value Updated",
        description: `"${oldValue}" renamed to "${trimmedNewValue}" across ${updateCount} record${updateCount !== 1 ? 's' : ''}`,
      });
      
      setEditingField(null);
      setEditingValue("");
      setNewValue("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error instanceof Error ? error.message : "Failed to update value",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteValue = async () => {
    if (!deleteTarget) return;
    
    setIsUpdating(true);
    const { field, value, count } = deleteTarget;
    
    try {
      let updateCount = 0;
      const config = FIELD_CONFIGS.find(f => f.key === field)!;
      
      for (const record of records) {
        let needsUpdate = false;
        let updatedData: Partial<Record> = {};
        
        if (config.isArray) {
          const currentValues = (record[field] as string[] | undefined) || [];
          if (currentValues.includes(value)) {
            updatedData[field] = currentValues.filter(v => v !== value) as any;
            needsUpdate = true;
          }
        } else {
          if (record[field] === value) {
            updatedData[field] = undefined as any;
            needsUpdate = true;
          }
        }
        
        if (needsUpdate && record.id) {
          await updateRecord(record.id, updatedData);
          updateCount++;
        }
      }

      if (config.hasMasterList) {
        if (field === 'tags') {
          const tag = tags.find(t => t.name === value);
          if (tag?.id) {
            await deleteTag(tag.id);
          }
        } else if (field === 'categories') {
          const category = categories.find(c => c.name === value);
          if (category?.id) {
            await deleteCategory(category.id);
          }
        }
      }

      toast({
        title: "Value Removed",
        description: `"${value}" removed from ${updateCount} record${updateCount !== 1 ? 's' : ''}`,
      });
      
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error instanceof Error ? error.message : "Failed to delete value",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAddItem = async (field: 'tags' | 'categories') => {
    if (!newItemValue.trim()) return;
    
    try {
      if (field === 'tags') {
        await createTag(newItemValue.trim());
      } else {
        await createCategory(newItemValue.trim());
      }
      
      toast({
        title: `${field === 'tags' ? 'Tag' : 'Category'} Created`,
        description: `"${newItemValue}" has been created`,
      });
      
      setNewItemField(null);
      setNewItemValue("");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: error instanceof Error ? error.message : "Failed to create item",
      });
    }
  };

  const handleDeleteUnused = async (field: 'tags' | 'categories', name: string) => {
    try {
      if (field === 'tags') {
        const tag = tags.find(t => t.name === name);
        if (tag?.id) {
          await deleteTag(tag.id);
        }
      } else {
        const category = categories.find(c => c.name === name);
        if (category?.id) {
          await deleteCategory(category.id);
        }
      }
      
      toast({
        title: `${field === 'tags' ? 'Tag' : 'Category'} Deleted`,
        description: `"${name}" has been removed`,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error instanceof Error ? error.message : "Failed to delete item",
      });
    }
  };

  const isLoading = recordsLoading || tagsLoading || categoriesLoading;

  const renderFieldSection = (config: FieldConfig) => {
    const values = extractUniqueValues(config.key);
    const Icon = config.icon;
    const unusedItems = config.hasMasterList 
      ? getUnusedMasterItems(config.key as 'tags' | 'categories')
      : [];

    return (
      <Card key={config.key}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon className="h-5 w-5 text-muted-foreground" />
              <CardTitle>{config.label}</CardTitle>
            </div>
            {config.hasMasterList && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setNewItemField(config.key as 'tags' | 'categories');
                  setNewItemValue("");
                }}
                data-testid={`button-add-${config.key}`}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add New
              </Button>
            )}
          </div>
          <CardDescription>{config.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {newItemField === config.key && (
            <div className="flex gap-2 mb-4 p-3 bg-muted/50 rounded-md">
              <Input
                value={newItemValue}
                onChange={(e) => setNewItemValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddItem(config.key as 'tags' | 'categories');
                  } else if (e.key === 'Escape') {
                    setNewItemField(null);
                    setNewItemValue("");
                  }
                }}
                placeholder={`New ${config.label.toLowerCase().slice(0, -1)} name`}
                autoFocus
                data-testid={`input-new-${config.key}`}
              />
              <Button
                size="sm"
                onClick={() => handleAddItem(config.key as 'tags' | 'categories')}
                data-testid={`button-save-new-${config.key}`}
              >
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setNewItemField(null);
                  setNewItemValue("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}
          
          {values.length === 0 && unusedItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No {config.label.toLowerCase()} found in records
            </p>
          ) : (
            <div className="space-y-2">
              {values.map(({ value, count }) => (
                <div 
                  key={value} 
                  className="flex items-center justify-between p-3 rounded-md bg-muted/30 hover-elevate"
                  data-testid={`row-${config.key}-${value}`}
                >
                  {editingField === config.key && editingValue === value ? (
                    <div className="flex gap-2 flex-1">
                      <Input
                        value={newValue}
                        onChange={(e) => setNewValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleUpdateValue(config.key, value, newValue);
                          } else if (e.key === 'Escape') {
                            setEditingField(null);
                            setEditingValue("");
                            setNewValue("");
                          }
                        }}
                        autoFocus
                        disabled={isUpdating}
                        data-testid={`input-edit-${config.key}-${value}`}
                      />
                      <Button
                        size="sm"
                        onClick={() => handleUpdateValue(config.key, value, newValue)}
                        disabled={isUpdating}
                        data-testid={`button-save-${config.key}-${value}`}
                      >
                        {isUpdating ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingField(null);
                          setEditingValue("");
                          setNewValue("");
                        }}
                        disabled={isUpdating}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{value}</span>
                        <Badge variant="secondary" className="text-xs">
                          {count} record{count !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setEditingField(config.key);
                            setEditingValue(value);
                            setNewValue(value);
                          }}
                          data-testid={`button-edit-${config.key}-${value}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setDeleteTarget({ field: config.key, value, count });
                            setDeleteDialogOpen(true);
                          }}
                          data-testid={`button-delete-${config.key}-${value}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {unusedItems.length > 0 && (
                <>
                  <div className="pt-2 mt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-2">
                      Unused (not in any records):
                    </p>
                    {unusedItems.map((name) => (
                      <div 
                        key={name}
                        className="flex items-center justify-between p-2 rounded-md bg-muted/20"
                        data-testid={`row-unused-${config.key}-${name}`}
                      >
                        <span className="text-sm text-muted-foreground">{name}</span>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDeleteUnused(config.key as 'tags' | 'categories', name)}
                          data-testid={`button-delete-unused-${config.key}-${name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center py-8 text-muted-foreground">
            Loading values...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2" data-testid="text-page-title">Value Updater</h1>
          <p className="text-muted-foreground">
            Edit values across all records at once. Changes apply everywhere that value is used.
          </p>
        </div>

        <Tabs defaultValue="tags">
          <TabsList className="flex-wrap h-auto gap-1">
            {FIELD_CONFIGS.map((config) => {
              const Icon = config.icon;
              return (
                <TabsTrigger 
                  key={config.key} 
                  value={config.key}
                  className="gap-1"
                  data-testid={`tab-${config.key}`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{config.label}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {FIELD_CONFIGS.map((config) => (
            <TabsContent key={config.key} value={config.key} className="mt-4">
              {renderFieldSection(config)}
            </TabsContent>
          ))}
        </Tabs>

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this value?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove "{deleteTarget?.value}" from {deleteTarget?.count} record{deleteTarget?.count !== 1 ? 's' : ''}.
                {deleteTarget?.field === 'tags' || deleteTarget?.field === 'categories' 
                  ? ` The ${deleteTarget?.field === 'tags' ? 'tag' : 'category'} will also be deleted from the master list.`
                  : ''
                }
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isUpdating}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDeleteValue} disabled={isUpdating}>
                {isUpdating ? "Removing..." : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
