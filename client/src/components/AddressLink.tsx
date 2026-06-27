import { useState, useCallback, useRef, useEffect } from "react";
import { Copy, Check, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useSettings } from "@/hooks/use-settings";
import {
  resolveIdentifier,
  getCachedRecord,
  subscribeCacheEntry,
  getHoverMetadataFields,
  getHoverLabel,
  hasHoverMetadata,
  type HoverMetadataField,
} from "@/lib/metadata-hover";
import { type Record as DbRecord } from "@/lib/database";

interface AddressLinkProps {
  address: string;
  label?: string | null;
  recordId?: number | null;
  hasMetadata?: boolean;
  truncate?: boolean;
  showCopy?: boolean;
  showMetadataIndicator?: boolean;
  className?: string;
  onNavigate?: (recordId: number) => void;
}

function MetadataTooltipBody({
  identifier,
  hoverLabel,
  fields,
  isLoading,
}: {
  identifier: string;
  hoverLabel: string | null;
  fields: HoverMetadataField[];
  isLoading: boolean;
}) {
  return (
    <div className="space-y-1 max-w-[280px]">
      {hoverLabel && (
        <p className="text-xs font-medium break-words" data-testid="text-hover-label">
          {hoverLabel}
        </p>
      )}
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
        <p className="text-xs text-muted-foreground">
          {hoverLabel ? "Click to view / edit" : "Click to view / add metadata"}
        </p>
      )}
    </div>
  );
}

export function AddressLink({
  address,
  label,
  recordId,
  hasMetadata,
  truncate = true,
  showCopy = true,
  showMetadataIndicator = true,
  className = "",
  onNavigate,
}: AddressLinkProps) {
  const { openRecordPreview, openRecordPreviewByAddress } = useRecordPreview();
  const { copy, isCopied } = useCopyToClipboard();
  const { hoverTooltipPrefs } = useSettings();
  const copied = isCopied(address);

  const resolvedRef = useRef<DbRecord | null | undefined>(
    recordId != null ? undefined : getCachedRecord(address)
  );
  const [tooltipRecord, setTooltipRecord] = useState<DbRecord | null | undefined>(
    resolvedRef.current
  );
  const [isResolving, setIsResolving] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  useEffect(() => {
    const cached = getCachedRecord(address);
    if (cached !== undefined) {
      resolvedRef.current = cached;
      setTooltipRecord(cached);
    }
    // Stay subscribed for the component's lifetime so the indicator/tooltip
    // react not just to the initial preload/resolve but also to later cache
    // invalidations (a record edit/delete re-resolves and notifies here),
    // keeping the orange FileText icon in sync without waiting on a hover.
    return subscribeCacheEntry(address, (record) => {
      resolvedRef.current = record;
      setTooltipRecord(record);
    });
  }, [address]);

  const computedFields =
    tooltipRecord != null
      ? getHoverMetadataFields(tooltipRecord, hoverTooltipPrefs)
      : [];

  const hoverLabel =
    tooltipRecord != null
      ? getHoverLabel(tooltipRecord, hoverTooltipPrefs)
      : null;

  const recordHasMeta =
    tooltipRecord != null
      ? hasHoverMetadata(tooltipRecord, hoverTooltipPrefs)
      : (hasMetadata ?? false);

  const showIndicator = showMetadataIndicator && recordHasMeta;

  const handleTooltipOpen = useCallback(
    async (open: boolean) => {
      setTooltipOpen(open);
      if (!open) return;

      const cached = getCachedRecord(address);
      if (cached !== undefined) {
        setTooltipRecord(cached);
        resolvedRef.current = cached;
        return;
      }

      setIsResolving(true);
      try {
        const record = await resolveIdentifier(address);
        resolvedRef.current = record;
        setTooltipRecord(record);
      } finally {
        setIsResolving(false);
      }
    },
    [address]
  );

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      copy(address, { label: "Address" });
    },
    [address, copy]
  );

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      let foundRecordId: number | null = recordId ?? null;
      if (foundRecordId == null) {
        const record = tooltipRecord ?? (await resolveIdentifier(address));
        foundRecordId = record?.id ?? null;
      }

      if (foundRecordId) {
        if (onNavigate) {
          onNavigate(foundRecordId);
        } else {
          await openRecordPreview(foundRecordId);
        }
      } else {
        await openRecordPreviewByAddress(address);
      }
    },
    [address, recordId, tooltipRecord, onNavigate, openRecordPreview, openRecordPreviewByAddress]
  );

  const displayAddress =
    truncate && address.length > 16
      ? `${address.slice(0, 8)}\u2026${address.slice(-6)}`
      : address;

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpen} delayDuration={400}>
        <TooltipTrigger asChild>
          <button
            onClick={handleClick}
            className="inline-flex items-center gap-1 font-mono text-xs bg-muted/50 px-1.5 py-0.5 rounded cursor-pointer hover:bg-muted hover:underline transition-colors"
            data-testid={`link-address-${address.slice(0, 8)}`}
          >
            {label ? (
              <span className="font-sans font-medium">{label}</span>
            ) : (
              <span>{displayAddress}</span>
            )}
            {showIndicator && (
              <FileText className="h-3 w-3 text-orange-500 shrink-0" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <MetadataTooltipBody
            identifier={address}
            hoverLabel={hoverLabel}
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
              data-testid={`button-copy-address-${address.slice(0, 8)}`}
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{copied ? "Copied!" : "Copy address"}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
