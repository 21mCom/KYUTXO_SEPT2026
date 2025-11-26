import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { X, Paperclip } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RecordFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: any) => void;
  initialData?: any;
}

export function RecordFormDialog({ open, onClose, onSave, initialData }: RecordFormDialogProps) {
  const [formData, setFormData] = useState(initialData || {
    inputString: "",
    label: "",
    type: "address",
    notes: "",
    tags: [],
    categories: [],
    seedName: "",
    walletSoftware: "",
    counterparty: "",
  });

  const [newTag, setNewTag] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
    onClose();
  };

  const addTag = () => {
    if (newTag && !formData.tags.includes(newTag)) {
      setFormData({ ...formData, tags: [...formData.tags, newTag] });
      setNewTag("");
    }
  };

  const removeTag = (tag: string) => {
    setFormData({ ...formData, tags: formData.tags.filter((t: string) => t !== tag) });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialData ? "Edit Record" : "Create New Record"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select
                value={formData.type}
                onValueChange={(value) => setFormData({ ...formData, type: value })}
              >
                <SelectTrigger id="type" data-testid="select-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="address">Address</SelectItem>
                  <SelectItem value="transaction">Transaction</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="label">Label *</Label>
              <Input
                id="label"
                value={formData.label}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                placeholder="My Wallet"
                required
                data-testid="input-label"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="inputString">
              {formData.type === "address" ? "Bitcoin Address" : "Transaction ID"} *
            </Label>
            <Input
              id="inputString"
              value={formData.inputString}
              onChange={(e) => setFormData({ ...formData, inputString: e.target.value })}
              placeholder={formData.type === "address" ? "bc1q..." : "Transaction hash"}
              required
              className="font-mono"
              data-testid="input-address"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Additional details..."
              rows={3}
              data-testid="input-notes"
            />
          </div>

          <div className="space-y-2">
            <Label>Tags</Label>
            <div className="flex gap-2">
              <Input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="Add tag"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                data-testid="input-new-tag"
              />
              <Button type="button" onClick={addTag} data-testid="button-add-tag">
                Add
              </Button>
            </div>
            {formData.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {formData.tags.map((tag: string) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <X className="h-3 w-3 cursor-pointer" onClick={() => removeTag(tag)} />
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="seedName">Seed Name</Label>
              <Input
                id="seedName"
                value={formData.seedName}
                onChange={(e) => setFormData({ ...formData, seedName: e.target.value })}
                placeholder="Seed #1"
                data-testid="input-seed"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="walletSoftware">Wallet Software</Label>
              <Input
                id="walletSoftware"
                value={formData.walletSoftware}
                onChange={(e) => setFormData({ ...formData, walletSoftware: e.target.value })}
                placeholder="Electrum"
                data-testid="input-wallet"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="counterparty">Counterparty</Label>
            <Input
              id="counterparty"
              value={formData.counterparty}
              onChange={(e) => setFormData({ ...formData, counterparty: e.target.value })}
              placeholder="Coinbase"
              data-testid="input-counterparty"
            />
          </div>

          <div className="flex items-center gap-2 p-3 bg-muted rounded-md text-sm text-muted-foreground">
            <Paperclip className="h-4 w-4 flex-shrink-0" />
            <span>Files can be attached after saving the record.</span>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel">
              Cancel
            </Button>
            <Button type="submit" data-testid="button-save">
              {initialData ? "Save Changes" : "Create Record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
