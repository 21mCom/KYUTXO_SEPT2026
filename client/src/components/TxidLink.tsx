import { useState, useCallback } from "react";
import { Copy, Check, FileText, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getRecordsByInputString } from "@/lib/data/record-crud";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import { useToast } from "@/hooks/use-toast";

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
  onNavigate
}: TxidLinkProps) {
  const { openRecordPreview, openRecordPreviewByAddress } = useRecordPreview();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [resolvedRecordId, setResolvedRecordId] = useState<number | null>(recordId ?? null);
  const [resolvedHasMetadata, setResolvedHasMetadata] = useState<boolean>(hasMetadata ?? false);
  const [isResolving, setIsResolving] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const notifyFailure = () => {
      toast({
        title: "Copy failed",
        description: "Could not copy the transaction ID to your clipboard.",
        variant: "destructive",
      });
    };
    try {
      navigator.clipboard.writeText(txid)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          toast({ description: "Transaction ID copied" });
        })
        .catch(notifyFailure);
    } catch {
      notifyFailure();
    }
  }, [txid, toast]);

  const resolveRecord = useCallback(async (): Promise<{ recordId: number | null; hasMetadata: boolean }> => {
    if (resolvedRecordId !== null) {
      return { recordId: resolvedRecordId, hasMetadata: resolvedHasMetadata };
    }
    
    if (isResolving) {
      return { recordId: null, hasMetadata: false };
    }
    
    setIsResolving(true);
    try {
      const rawRecords = await getRecordsByInputString(txid);
      if (rawRecords.length > 0) {
        const record = rawRecords[0];
        const foundRecordId = record.id!;
        
        const hasMeta = !!(
          record.label ||
          record.notes ||
          (record.tags && record.tags.length > 0) ||
          (record.categories && record.categories.length > 0)
        );
        
        setResolvedRecordId(foundRecordId);
        setResolvedHasMetadata(hasMeta);
        
        return { recordId: foundRecordId, hasMetadata: hasMeta };
      }
      return { recordId: null, hasMetadata: false };
    } catch (error) {
      console.error('[TxidLink] Failed to resolve record:', error);
      return { recordId: null, hasMetadata: false };
    } finally {
      setIsResolving(false);
    }
  }, [txid, resolvedRecordId, resolvedHasMetadata, isResolving]);

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
      await openRecordPreviewByAddress(txid);
    }
  }, [txid, onNavigate, resolveRecord, openRecordPreview, openRecordPreviewByAddress]);

  const handleExternalLink = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(`https://mempool.space/tx/${txid}`, '_blank');
  }, [txid]);

  const displayTxid = truncate && txid.length > 16
    ? `${txid.slice(0, 8)}...${txid.slice(-6)}`
    : txid;

  const showIndicator = showMetadataIndicator && (hasMetadata || resolvedHasMetadata);

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Tooltip>
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
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1">
            <p className="font-mono text-xs break-all">{txid}</p>
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
            <p>{copied ? 'Copied!' : 'Copy transaction ID'}</p>
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
