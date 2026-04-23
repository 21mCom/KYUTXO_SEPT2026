import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { db, type Record as DbRecord, type ChainType, type AddressImportance, type VaultMetadata, type FlowType, type AcquisitionMethod, type DispositionType, type CounterpartyType } from "@/lib/database";
import { RecordDetailPanel } from "./RecordDetailPanel";

interface ClickableAddressProps {
  address: string;
  className?: string;
}

interface ConvertedRecord {
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
  privateKeyStatus?: string;
  source?: string;
  derivationPath?: string;
  chainType?: ChainType;
  vault?: VaultMetadata;
  addressImportance?: AddressImportance;
  customFields?: { [key: string]: string };
  syncDepth?: number;
  maxSyncedDepth?: number;
  discoveredInTxid?: string;
  discoveredFromRecordId?: number;
  flowType?: FlowType;
  acquisitionMethod?: AcquisitionMethod;
  dispositionType?: DispositionType;
  costBasisUsd?: number;
  counterpartyType?: CounterpartyType;
}

export function ClickableAddress({ 
  address, 
  className = "",
}: ClickableAddressProps) {
  const [, navigate] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [record, setRecord] = useState<ConvertedRecord | null>(null);
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
        const converted: ConvertedRecord = {
          id: String(dbRecord.id),
          type: dbRecord.type as "address" | "transaction" | "other",
          inputString: dbRecord.inputString,
          label: dbRecord.label || "",
          notes: dbRecord.notes,
          tags: dbRecord.tags || [],
          categories: dbRecord.categories || [],
          seedName: dbRecord.seedName,
          walletSoftware: dbRecord.walletSoftware,
          owner: dbRecord.owner,
          walletName: dbRecord.walletName,
          privateKeyStatus: dbRecord.privateKeyStatus,
          source: dbRecord.source,
          derivationPath: dbRecord.derivationPath,
          chainType: dbRecord.chainType as ChainType | undefined,
          vault: dbRecord.vault as VaultMetadata | undefined,
          addressImportance: dbRecord.addressImportance as AddressImportance | undefined,
          customFields: dbRecord.customFields as { [key: string]: string } | undefined,
          syncDepth: dbRecord.syncDepth,
          maxSyncedDepth: dbRecord.maxSyncedDepth,
          discoveredInTxid: dbRecord.discoveredInTxid,
          discoveredFromRecordId: dbRecord.discoveredFromRecordId,
          flowType: dbRecord.flowType as FlowType | undefined,
          acquisitionMethod: dbRecord.acquisitionMethod as AcquisitionMethod | undefined,
          dispositionType: dbRecord.dispositionType as DispositionType | undefined,
          costBasisUsd: dbRecord.costBasisUsd,
          counterpartyType: dbRecord.counterpartyType as CounterpartyType | undefined,
        };
        setRecord(converted);
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
