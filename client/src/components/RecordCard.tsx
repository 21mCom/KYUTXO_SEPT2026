import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoreVertical, Paperclip } from "lucide-react";
import { BitcoinAddressDisplay } from "./BitcoinAddressDisplay";
import { RecordTypeBadge } from "./RecordTypeBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { classifyBehavior, BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";

interface RecordCardProps {
  id: string;
  type: "address" | "transaction" | "other";
  inputString: string;
  label: string;
  amount?: number;
  date?: string;
  tags: string[];
  attachmentCount?: number;
  onEdit?: () => void;
  onDelete?: () => void;
  onClick?: () => void;
  // Cached address stats for behavior badge
  cachedBalanceSats?: number;
  cachedTxCount?: number;
  cachedLastActivityTime?: number;
  cachedUtxoCount?: number;
  statsComputedAt?: number;
}

export function RecordCard({
  id,
  type,
  inputString,
  label,
  amount,
  date,
  tags,
  attachmentCount = 0,
  onEdit,
  onDelete,
  onClick,
  cachedBalanceSats,
  cachedTxCount,
  cachedLastActivityTime,
  cachedUtxoCount,
  statsComputedAt,
}: RecordCardProps) {
  const behaviorProfile = type === 'address' ? classifyBehavior({
    synced: statsComputedAt != null,
    balanceSats: cachedBalanceSats ?? 0,
    txCount: cachedTxCount ?? 0,
    utxoCount: cachedUtxoCount ?? 0,
    lastActivityTime: cachedLastActivityTime ?? 0,
  }) : null;

  return (
    <Card className="hover-elevate cursor-pointer" onClick={onClick} data-testid={`card-record-${id}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <RecordTypeBadge type={type} />
            {attachmentCount > 0 && (
              <Badge variant="outline" className="text-xs">
                <Paperclip className="h-3 w-3 mr-1" />
                {attachmentCount}
              </Badge>
            )}
            {behaviorProfile && (
              <Badge
                variant={behaviorProfile.label === 'not-enough-data' ? 'outline' : 'secondary'}
                className="text-xs"
                title={behaviorProfile.summarySentence}
                data-testid={`badge-behavior-${id}`}
              >
                {BEHAVIOR_LABEL_DISPLAY[behaviorProfile.label]}
              </Badge>
            )}
          </div>
          <h3 className="font-semibold text-base truncate" data-testid={`text-label-${id}`}>{label}</h3>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button size="icon" variant="ghost" data-testid={`button-menu-${id}`}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit?.(); }} data-testid="button-edit">
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete?.(); }} className="text-destructive" data-testid="button-delete">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="space-y-3">
        <BitcoinAddressDisplay address={inputString} />
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {amount !== undefined && (
            <span className="font-mono font-medium text-foreground" data-testid={`text-amount-${id}`}>
              {amount} BTC
            </span>
          )}
          {date && <span data-testid={`text-date-${id}`}>{date}</span>}
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs" data-testid={`badge-tag-${tag}`}>
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
