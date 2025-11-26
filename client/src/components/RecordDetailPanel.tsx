import { X, Edit, Paperclip, Calendar, Wallet as WalletIcon, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BitcoinAddressDisplay } from "./BitcoinAddressDisplay";
import { RecordTypeBadge } from "./RecordTypeBadge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface RecordDetailPanelProps {
  open: boolean;
  onClose: () => void;
  onEdit?: () => void;
  record?: {
    id: string;
    type: "address" | "transaction";
    inputString: string;
    label: string;
    notes?: string;
    amount?: number;
    date?: string;
    tags: string[];
    categories: string[];
    seedName?: string;
    walletSoftware?: string;
    counterparty?: string;
    attachments?: Array<{ id: string; filename: string; size: number }>;
  };
}

export function RecordDetailPanel({ open, onClose, onEdit, record }: RecordDetailPanelProps) {
  if (!record) return null;

  return (
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
              <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-panel">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-6">
          <div className="space-y-6 pb-6">
            <div>
              <h4 className="text-sm font-medium mb-2">
                {record.type === "address" ? "Bitcoin Address" : "Transaction ID"}
              </h4>
              <BitcoinAddressDisplay address={record.inputString} truncate={false} />
            </div>

            {record.amount !== undefined && (
              <div>
                <h4 className="text-sm font-medium mb-2">Amount</h4>
                <p className="text-2xl font-mono font-semibold" data-testid="text-amount-detail">
                  {record.amount} BTC
                </p>
              </div>
            )}

            {record.date && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Date
                </h4>
                <p className="text-sm" data-testid="text-date-detail">{record.date}</p>
              </div>
            )}

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

            {record.counterparty && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Counterparty
                </h4>
                <p className="text-sm" data-testid="text-counterparty-detail">{record.counterparty}</p>
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

            {record.attachments && record.attachments.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Paperclip className="h-4 w-4" />
                  Attachments ({record.attachments.length})
                </h4>
                <div className="space-y-2">
                  {record.attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="flex items-center justify-between p-2 border rounded hover-elevate"
                      data-testid={`attachment-${attachment.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{attachment.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {(attachment.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                      <Button size="sm" variant="ghost">
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
