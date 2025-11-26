import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { X, Upload, File as FileIcon, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatFileSize } from "@/lib/attachments";

interface RecordFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: any, files: File[]) => Promise<void>;
  initialData?: any;
  isSubmitting?: boolean;
  uploadProgress?: { current: number; total: number } | null;
}

export function RecordFormDialog({ 
  open, 
  onClose, 
  onSave, 
  initialData,
  isSubmitting = false,
  uploadProgress = null,
}: RecordFormDialogProps) {
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
    privateKeyStatus: "",
  });

  const [newTag, setNewTag] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave(formData, selectedFiles);
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(prev => [...prev, ...files]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setSelectedFiles([]);
      setFormData(initialData || {
        inputString: "",
        label: "",
        type: "address",
        notes: "",
        tags: [],
        categories: [],
        seedName: "",
        walletSoftware: "",
        counterparty: "",
        privateKeyStatus: "",
      });
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialData ? "Edit Record" : "Create New Record"}</DialogTitle>
          <DialogDescription>
            {initialData ? "Update record details below." : "Fill in the details to create a new Bitcoin record."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select
                value={formData.type}
                onValueChange={(value) => setFormData({ ...formData, type: value })}
                disabled={isSubmitting}
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
                disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
                disabled={isSubmitting}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                data-testid="input-new-tag"
              />
              <Button type="button" onClick={addTag} disabled={isSubmitting} data-testid="button-add-tag">
                Add
              </Button>
            </div>
            {formData.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {formData.tags.map((tag: string) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    {!isSubmitting && (
                      <X className="h-3 w-3 cursor-pointer" onClick={() => removeTag(tag)} />
                    )}
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
                disabled={isSubmitting}
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
                disabled={isSubmitting}
                data-testid="input-wallet"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="counterparty">Counterparty</Label>
              <Input
                id="counterparty"
                value={formData.counterparty}
                onChange={(e) => setFormData({ ...formData, counterparty: e.target.value })}
                placeholder="Coinbase"
                disabled={isSubmitting}
                data-testid="input-counterparty"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="privateKeyStatus">Private Key Available</Label>
              <Select
                value={formData.privateKeyStatus || ""}
                onValueChange={(value) => setFormData({ ...formData, privateKeyStatus: value })}
                disabled={isSubmitting}
              >
                <SelectTrigger id="privateKeyStatus" data-testid="select-private-key">
                  <SelectValue placeholder="Select status..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                  <SelectItem value="unsure">Unsure</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Attachments</Label>
            <input
              type="file"
              multiple
              ref={fileInputRef}
              onChange={handleFileSelect}
              className="hidden"
              id="file-select"
              disabled={isSubmitting}
              data-testid="input-file-select"
            />
            <label
              htmlFor="file-select"
              className={`flex items-center justify-center gap-2 border-2 border-dashed rounded-md p-4 cursor-pointer transition-colors ${
                isSubmitting ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/50"
              }`}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-muted-foreground">Click to select files</span>
            </label>

            {selectedFiles.length > 0 && (
              <div className="space-y-2 mt-2">
                {selectedFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between p-2 bg-muted rounded-md"
                    data-testid={`file-item-${index}`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                      </div>
                    </div>
                    {!isSubmitting && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeFile(index)}
                        data-testid={`button-remove-file-${index}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {uploadProgress && (
              <div className="space-y-1 mt-2">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Uploading files...</span>
                  <span>{uploadProgress.current} / {uploadProgress.total}</span>
                </div>
                <Progress value={(uploadProgress.current / uploadProgress.total) * 100} />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button 
              type="button" 
              variant="outline" 
              onClick={handleClose} 
              disabled={isSubmitting}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid="button-save">
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {uploadProgress ? "Uploading..." : "Saving..."}
                </>
              ) : (
                initialData ? "Save Changes" : "Create Record"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
