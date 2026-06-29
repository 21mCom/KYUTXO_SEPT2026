import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { db } from "@/lib/database";
import { type PanelRecord, toPanelRecord } from "@/lib/recordToPanel";
import { RecordDetailPanel } from "./RecordDetailPanel";

interface ClickableAddressProps {
  address: string;
  className?: string;
}

export function ClickableAddress({ 
  address, 
  className = "",
}: ClickableAddressProps) {
  const [, navigate] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [record, setRecord] = useState<PanelRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMetadata, setHasMetadata] = useState(false);

  useEffect(() => {
    if (!address) return;
    
    const checkMetadata = async () => {
      try {
        const dbRecord = await db.records
          .where('inputString')
          .equals(address)
          .first();
        
        if (dbRecord) {
          const hasLabel = Boolean(dbRecord.label && dbRecord.label.length > 0);
          const hasNotes = Boolean(dbRecord.notes && dbRecord.notes.length > 0);
          const hasTags = Boolean(dbRecord.tags && dbRecord.tags.length > 0);
          const hasCategories = Boolean(dbRecord.categories && dbRecord.categories.length > 0);
          const hasOwner = Boolean(dbRecord.owner && dbRecord.owner.length > 0);
          const hasWalletName = Boolean(dbRecord.walletName && dbRecord.walletName.length > 0);
          
          setHasMetadata(hasLabel || hasNotes || hasTags || hasCategories || hasOwner || hasWalletName);
        } else {
          setHasMetadata(false);
        }
      } catch {
        setHasMetadata(false);
      }
    };
    
    checkMetadata();
  }, [address]);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!address) return;
    
    setIsLoading(true);
    
    try {
      const dbRecord = await db.records
        .where('inputString')
        .equals(address)
        .first();
      
      if (dbRecord) {
        setRecord(toPanelRecord(dbRecord));
        setIsOpen(true);
      } else {
        navigate(`/records?search=${encodeURIComponent(address)}`);
      }
    } catch (error) {
      console.error('[ClickableAddress] Error loading record:', error);
      navigate(`/records?search=${encodeURIComponent(address)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEdit = () => {
    if (record) {
      setIsOpen(false);
      navigate(`/records?id=${record.id}`);
    }
  };

  return (
    <>
      <span
        onClick={handleClick}
        className={`font-mono text-sm text-left inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap ${hasMetadata ? 'font-bold' : ''} ${className}`}
        data-testid={`clickable-address-${address.slice(0, 8)}`}
      >
        {isLoading ? "..." : address}
      </span>
      
      <RecordDetailPanel
        open={isOpen}
        record={record || undefined}
        onClose={() => setIsOpen(false)}
        onEdit={handleEdit}
      />
    </>
  );
}
