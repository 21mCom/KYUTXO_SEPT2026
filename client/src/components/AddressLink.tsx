import { useState, useCallback } from "react";
import { Copy, Check, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getRecordsByInputString } from "@/lib/data/record-crud";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";

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

export function AddressLink({ 
  address, 
  label,
  recordId,
  hasMetadata,
  truncate = true, 
  showCopy = true,
  showMetadataIndicator = true,
  className = "",
  onNavigate
}: AddressLinkProps) {
  const { openRecordPreview, openRecordPreviewByAddress } = useRecordPreview();
  const [copied, setCopied] = useState(false);
  const [resolvedRecordId, setResolvedRecordId] = useState<number | null>(recordId ?? null);
  const [resolvedHasMetadata, setResolvedHasMetadata] = useState<boolean>(hasMetadata ?? false);
  const [isResolving, setIsResolving] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [address]);

  const resolveRecord = useCallback(async (): Promise<{ recordId: number | null; hasMetadata: boolean }> => {
    if (resolvedRecordId !== null) {
      return { recordId: resolvedRecordId, hasMetadata: resolvedHasMetadata };
    }
    
    if (isResolving) {
      return { recordId: null, hasMetadata: false };
    }
    
    setIsResolving(true);
    try {
      const rawRecords = await getRecordsByInputString(address);
      if (rawRecords.length > 0) {
        const record = rawRecords[0];
        const foundRecordId = record.id!;
        
        const hasMeta = !!(
          record.label ||
          record.notes ||
          (record.tags && record.tags.length > 0) ||
          (record.categories && record.categories.length > 0) ||
          record.owner !== 'Pending Review'
        );
        
        setResolvedRecordId(foundRecordId);
        setResolvedHasMetadata(hasMeta);
        
        return { recordId: foundRecordId, hasMetadata: hasMeta };
      }
      return { recordId: null, hasMetadata: false };
    } catch (error) {
      console.error('[AddressLink] Failed to resolve record:', error);
      return { recordId: null, hasMetadata: false };
    } finally {
      setIsResolving(false);
    }
  }, [address, resolvedRecordId, resolvedHasMetadata, isResolving]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const { recordId: foundRecordId } = await resolveRecord();
    
    if (foundRecordId) {
      if (onNavigate) {
        onNavigate(foundRecordId);
      } else {
        await openRecordPreview(foundRecordId);
      }
    } else {
      await openRecordPreviewByAddress(address);
    }
  }, [address, onNavigate, resolveRecord, openRecordPreview, openRecordPreviewByAddress]);

  const displayAddress = truncate && address.length > 16
    ? `${address.slice(0, 8)}...${address.slice(-6)}`
    : address;

  const showIndicator = showMetadataIndicator && (hasMetadata || resolvedHasMetadata);

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Tooltip>
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
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1">
            <p className="font-mono text-xs break-all">{address}</p>
            {label && <p className="text-xs text-muted-foreground">Label: {label}</p>}
            {showIndicator && (
              <p className="text-xs text-orange-500 flex items-center gap-1">
                <FileText className="h-3 w-3" />
                Has metadata - click to view/edit
              </p>
            )}
            {!showIndicator && (
              <p className="text-xs text-muted-foreground">Click to view/add metadata</p>
            )}
          </div>
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
            <p>{copied ? 'Copied!' : 'Copy address'}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
