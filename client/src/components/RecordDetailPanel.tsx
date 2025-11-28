import { Edit, Paperclip, Wallet as WalletIcon, User, Upload, QrCode } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BitcoinAddressDisplay } from "./BitcoinAddressDisplay";
import { RecordTypeBadge } from "./RecordTypeBadge";
import { AttachmentList } from "./AttachmentList";
import { AttachmentUpload } from "./AttachmentUpload";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Attachment } from "@/lib/database";
import QRCode from "qrcode";

interface RecordDetailPanelProps {
  open: boolean;
  onClose: () => void;
  onEdit?: () => void;
  record?: {
    id: string;
    type: "address" | "transaction" | "other";
    inputString: string;
    label: string;
    notes?: string;
    tags: string[];
    categories: string[];
    seedName?: string;
    walletSoftware?: string;
    owner?: string;
    walletName?: string;
  };
  attachments?: Attachment[];
  onAttachmentsChange?: () => void;
}

export function RecordDetailPanel({ open, onClose, onEdit, record, attachments = [], onAttachmentsChange }: RecordDetailPanelProps) {
  const [showUpload, setShowUpload] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (qrDialogOpen && record?.inputString) {
      QRCode.toDataURL(record.inputString, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      })
        .then((url) => setQrCodeDataUrl(url))
        .catch((err) => console.error('Error generating QR code:', err));
    }
  }, [qrDialogOpen, record?.inputString]);

  if (!record) return null;

  const handleUploadComplete = () => {
    setShowUpload(false);
    onAttachmentsChange?.();
  };

  const handleOpenQrDialog = () => {
    setQrCodeDataUrl(null);
    setQrDialogOpen(true);
  };

  return (
    <>
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-md overflow-hidden flex flex-col p-0">
        <SheetHeader className="p-6 pb-4 space-y-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-xl mb-2">{record.label}</SheetTitle>
              <RecordTypeBadge type={record.type} />
            </div>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" onClick={onEdit} data-testid="button-edit-panel">
                <Edit className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-6">
          <div className="space-y-6 pb-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium">
                  {record.type === "address" ? "Bitcoin Address" : record.type === "transaction" ? "Transaction ID" : "Identifier"}
                </h4>
                {(record.type === "address" || record.type === "transaction") && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleOpenQrDialog}
                    data-testid="button-show-qr"
                  >
                    <QrCode className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <BitcoinAddressDisplay address={record.inputString} truncate={false} />
            </div>

            {record.notes && (
              <div>
                <h4 className="text-sm font-medium mb-2">Notes</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-notes-detail">
                  {record.notes}
                </p>
              </div>
            )}

            <Separator />

            {record.seedName && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <WalletIcon className="h-4 w-4" />
                  Seed Name
                </h4>
                <p className="text-sm" data-testid="text-seed-detail">{record.seedName}</p>
              </div>
            )}

            {record.walletSoftware && (
              <div>
                <h4 className="text-sm font-medium mb-2">Wallet Software</h4>
                <p className="text-sm" data-testid="text-wallet-detail">{record.walletSoftware}</p>
              </div>
            )}

            {record.owner && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Owner
                </h4>
                <p className="text-sm" data-testid="text-owner-detail">{record.owner}</p>
              </div>
            )}

            {record.walletName && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <WalletIcon className="h-4 w-4" />
                  Wallet Name
                </h4>
                <p className="text-sm" data-testid="text-walletname-detail">{record.walletName}</p>
              </div>
            )}

            {record.tags.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Tags</h4>
                <div className="flex flex-wrap gap-2">
                  {record.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {record.categories.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Categories</h4>
                <div className="flex flex-wrap gap-2">
                  {record.categories.map((category) => (
                    <Badge key={category} variant="outline">
                      {category}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <Separator />

            <div>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <Paperclip className="h-4 w-4" />
                  Attachments ({attachments.length})
                </h4>
                {!showUpload && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowUpload(true)}
                    data-testid="button-show-upload"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Upload
                  </Button>
                )}
              </div>

              {showUpload && (
                <div className="mb-4">
                  <AttachmentUpload
                    recordId={Number(record.id)}
                    identifier={record.inputString}
                    onUploadComplete={handleUploadComplete}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowUpload(false)}
                    className="mt-2"
                    data-testid="button-cancel-upload"
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <AttachmentList
                attachments={attachments}
                onDelete={onAttachmentsChange}
              />
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>

    <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
      <DialogContent className="sm:max-w-[320px]">
        <DialogHeader>
          <DialogTitle className="text-center">
            {record.type === "address" ? "Address QR Code" : "Transaction ID QR Code"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          {qrCodeDataUrl ? (
            <img
              src={qrCodeDataUrl}
              alt="QR Code"
              className="w-64 h-64"
              data-testid="img-qr-code"
            />
          ) : (
            <div className="w-64 h-64 flex items-center justify-center bg-muted rounded">
              <span className="text-muted-foreground">Generating...</span>
            </div>
          )}
          <p className="text-xs text-muted-foreground text-center break-all px-4" data-testid="text-qr-value">
            {record.inputString}
          </p>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
