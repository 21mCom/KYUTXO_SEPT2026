import { useState } from "react";
import { Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { uploadAttachment } from "@/lib/attachments";

interface AttachmentUploadProps {
  recordId: number;
  identifier: string;
  onUploadComplete?: () => void;
}

export function AttachmentUpload({ recordId, identifier, onUploadComplete }: AttachmentUploadProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const { toast } = useToast();

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    setFiles((prev) => [...prev, ...selectedFiles]);
  };

  const handleRemoveFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    setUploading(true);
    setUploadProgress(0);

    try {
      const totalFiles = files.length;
      
      for (let i = 0; i < files.length; i++) {
        await uploadAttachment(recordId, files[i], identifier);
        setUploadProgress(((i + 1) / totalFiles) * 100);
      }

      toast({
        title: "Upload Complete",
        description: `${totalFiles} file(s) uploaded successfully`,
      });

      setFiles([]);
      onUploadComplete?.();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload files",
      });
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="flex-1">
          <input
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
            id="file-upload"
            data-testid="input-file-upload"
            disabled={uploading}
          />
          <label
            htmlFor="file-upload"
            className="flex items-center justify-center gap-2 border-2 border-dashed rounded-md p-6 cursor-pointer hover-elevate"
          >
            <Upload className="h-5 w-5" />
            <span>Click to select files or drag and drop</span>
          </label>
        </div>
      </div>

      {files.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold">Selected Files ({files.length})</h4>
              <Button
                size="sm"
                onClick={handleUpload}
                disabled={uploading}
                data-testid="button-upload-files"
              >
                {uploading ? "Uploading..." : "Upload All"}
              </Button>
            </div>

            {uploading && (
              <Progress value={uploadProgress} className="mb-2" />
            )}

            <div className="space-y-2">
              {files.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-2 bg-muted rounded-md"
                  data-testid={`file-item-${index}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {(file.size / 1024).toFixed(2)} KB
                    </p>
                  </div>
                  {!uploading && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleRemoveFile(index)}
                      data-testid={`button-remove-file-${index}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
