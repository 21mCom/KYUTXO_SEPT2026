import { useState } from "react";
import { Eye, Plus, Trash2, Pencil } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  useSettings,
  useCustomFields,
  toggleFieldVisibility,
  addCustomField,
  toggleCustomField,
  deleteCustomField,
  updateCustomField,
} from "@/hooks/use-settings";
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

export function FieldVisibilitySection() {
  const { fieldVisibility, isLoading: settingsLoading } = useSettings();
  const { customFields, isLoading: customFieldsLoading } = useCustomFields();
  const { toast } = useToast();

  const [newFieldName, setNewFieldName] = useState("");
  const [isAddingField, setIsAddingField] = useState(false);
  const [editingField, setEditingField] = useState<{ id: number; name: string } | null>(null);
  const [deletingFieldId, setDeletingFieldId] = useState<number | null>(null);

  const isLoading = settingsLoading || customFieldsLoading;

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

  return (
    <>
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
    </>
  );
}
