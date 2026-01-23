import { useState } from "react";
import { Paperclip, Download, Trash2, FileText, Image, Video, FileArchive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { formatFileSize, downloadAttachmentById, deleteAttachment } from "@/lib/attachments";
import type { Attachment } from "@/lib/database";
import { useToast } from "@/hooks/use-toast";

interface AttachmentListProps {
  attachments: Attachment[];
  onDelete?: (id: number) => void;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <Image className="h-5 w-5" />;
  if (mimeType.startsWith('video/')) return <Video className="h-5 w-5" />;
  if (mimeType === 'application/pdf') return <FileText className="h-5 w-5" />;
  if (mimeType.includes('zip') || mimeType.includes('archive')) return <FileArchive className="h-5 w-5" />;
  return <Paperclip className="h-5 w-5" />;
}

export function AttachmentList({ attachments, onDelete }: AttachmentListProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Attachment | null>(null);
  const { toast } = useToast();

  const handleDownload = async (attachment: Attachment) => {
    try {
      const result = await downloadAttachmentById(attachment.id!);
      const url = URL.createObjectURL(result.blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "Download Started",
        description: `Downloading ${result.filename}`,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Download Failed",
        description: error instanceof Error ? error.message : "Failed to download attachment",
      });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;

    try {
      await deleteAttachment(deleteTarget.id!);
      toast({
        title: "Attachment Deleted",
        description: `${deleteTarget.filename} has been deleted`,
      });
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      onDelete?.(deleteTarget.id!);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error instanceof Error ? error.message : "Failed to delete attachment",
      });
    }
  };

  if (attachments.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No attachments yet
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {attachments.map((attachment) => (
          <Card key={attachment.id} className="hover-elevate" data-testid={`attachment-${attachment.id}`}>
            <CardContent className="flex items-center justify-between p-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="text-muted-foreground">
                  {getFileIcon(attachment.mimeType)}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-medium truncate" data-testid={`text-filename-${attachment.id}`}>
                    {attachment.filename}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {formatFileSize(attachment.size)}
                  </p>
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => handleDownload(attachment)}
                  data-testid={`button-download-${attachment.id}`}
                >
                  <Download className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    setDeleteTarget(attachment);
                    setDeleteDialogOpen(true);
                  }}
                  data-testid={`button-delete-attachment-${attachment.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Attachment?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.filename}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
