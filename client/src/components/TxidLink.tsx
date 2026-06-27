import { useState, useCallback, useRef } from "react";
import { Copy, Check, FileText, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { useToast } from "@/hooks/use-toast";
import { useSettings } from "@/hooks/use-settings";
import {
  resolveIdentifier,
  getCachedRecord,
  getHoverMetadataFields,
  hasHoverMetadata,
  type HoverMetadataField,
} from "@/lib/metadata-hover";
import { type Record as DbRecord } from "@/lib/database";

interface TxidLinkProps {
  txid: string;
  label?: string | null;
  recordId?: number | null;
  hasMetadata?: boolean;
  truncate?: boolean;
  showCopy?: boolean;
  showMetadataIndicator?: boolean;
  showExternalLink?: boolean;
  className?: string;
  onNavigate?: (recordId: number) => void;
}

function MetadataTooltipBody({
  identifier,
  fields,
  isLoading,
}: {
  identifier: string;
  fields: HoverMetadataField[];
  isLoading: boolean;
}) {
  return (
    <div className="space-y-1 max-w-[280px]">
      <p className="font-mono text-xs break-all text-muted-foreground">{identifier}</p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground italic">Loading\u2026</p>
      ) : fields.length > 0 ? (
        <div className="space-y-0.5 pt-0.5">
          {fields.map((f) => (
            <div key={f.label} className="flex gap-1.5 text-xs">
              <span className="text-muted-foreground shrink-0 w-20 text-right">{f.label}</span>
              <span className="break-all">{f.value}</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground pt-0.5">Click to view / edit</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Click to view / add metadata</p>
      )}
    </div>
  );
}

export function TxidLink({
  txid,
  label,
  recordId,
  hasMetadata,
  truncate = true,
  showCopy = true,
  showMetadataIndicator = true,
  showExternalLink = false,
  className = "",
  onNavigate,
}: TxidLinkProps) {
  const { openRecordPreview, openRecordPreviewByAddress } = useRecordPreview();
  const { toast } = useToast();
  const { hoverTooltipPrefs } = useSettings();
  const [copied, setCopied] = useState(false);

  const resolvedRef = useRef<DbRecord | null | undefined>(
    recordId != null ? undefined : getCachedRecord(txid)
  );
  const [tooltipRecord, setTooltipRecord] = useState<DbRecord | null | undefined>(
    resolvedRef.current
  );
  const [isResolving, setIsResolving] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const computedFields =
    tooltipRecord != null
      ? getHoverMetadataFields(tooltipRecord, hoverTooltipPrefs)
      : [];

  const recordHasMeta =
    tooltipRecord != null
      ? hasHoverMetadata(tooltipRecord, hoverTooltipPrefs)
      : (hasMetadata ?? false);

  const showIndicator = showMetadataIndicator && recordHasMeta;

  const handleTooltipOpen = useCallback(
    async (open: boolean) => {
      setTooltipOpen(open);
      if (!open) return;

      const cached = getCachedRecord(txid);
      if (cached !== undefined) {
        setTooltipRecord(cached);
        resolvedRef.current = cached;
        return;
      }

      setIsResolving(true);
      try {
        const record = await resolveIdentifier(txid);
        resolvedRef.current = record;
        setTooltipRecord(record);
      } finally {
        setIsResolving(false);
      }
    },
    [txid]
  );

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const notifyFailure = () => {
        toast({
          title: "Copy failed",
          description: "Could not copy the transaction ID to your clipboard.",
          variant: "destructive",
        });
      };
      try {
        navigator.clipboard
          .writeText(txid)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            toast({ description: "Transaction ID copied" });
          })
          .catch(notifyFailure);
      } catch {
        notifyFailure();
      }
    },
    [txid, toast]
  );

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      let foundRecordId: number | null = recordId ?? null;
      if (foundRecordId == null) {
        const record = tooltipRecord ?? (await resolveIdentifier(txid));
        foundRecordId = record?.id ?? null;
      }

      if (foundRecordId) {
        if (onNavigate) {
          onNavigate(foundRecordId);
        } else {
          await openRecordPreview(foundRecordId);
        }
      } else {
        await openRecordPreviewByAddress(txid);
      }
    },
    [txid, recordId, tooltipRecord, onNavigate, openRecordPreview, openRecordPreviewByAddress]
  );

  const handleExternalLink = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      window.open(`https://mempool.space/tx/${txid}`, "_blank");
    },
    [txid]
  );

  const displayTxid =
    truncate && txid.length > 16
      ? `${txid.slice(0, 8)}\u2026${txid.slice(-6)}`
      : txid;

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpen} delayDuration={400}>
        <TooltipTrigger asChild>
          <button
            onClick={handleClick}
            className="inline-flex items-center gap-1 font-mono text-xs bg-muted/50 px-1.5 py-0.5 rounded cursor-pointer hover:bg-muted hover:underline transition-colors"
            data-testid={`link-txid-${txid.slice(0, 8)}`}
          >
            {label ? (
              <span className="font-sans font-medium">{label}</span>
            ) : (
              <span>{displayTxid}</span>
            )}
            {showIndicator && (
              <FileText className="h-3 w-3 text-orange-500 shrink-0" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <MetadataTooltipBody
            identifier={txid}
            fields={computedFields}
            isLoading={isResolving}
          />
        </TooltipContent>
      </Tooltip>

      {showCopy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              onClick={handleCopy}
              data-testid={`button-copy-txid-${txid.slice(0, 8)}`}
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{copied ? "Copied!" : "Copy transaction ID"}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {showExternalLink && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              onClick={handleExternalLink}
              data-testid={`button-external-txid-${txid.slice(0, 8)}`}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>View on mempool.space</p>
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
