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
        const decrypted = dbRecord;
        if (decrypted) {
          const converted: ConvertedRecord = {
            id: String(decrypted.id),
            type: decrypted.type as "address" | "transaction" | "other",
            inputString: decrypted.inputString,
            label: decrypted.label || "",
            notes: decrypted.notes,
            tags: decrypted.tags || [],
            categories: decrypted.categories || [],
            seedName: decrypted.seedName,
            walletSoftware: decrypted.walletSoftware,
            owner: decrypted.owner,
            walletName: decrypted.walletName,
            privateKeyStatus: decrypted.privateKeyStatus,
            source: decrypted.source,
            derivationPath: decrypted.derivationPath,
            chainType: decrypted.chainType as ChainType | undefined,
            vault: decrypted.vault as VaultMetadata | undefined,
            addressImportance: decrypted.addressImportance as AddressImportance | undefined,
            customFields: decrypted.customFields as { [key: string]: string } | undefined,
            syncDepth: decrypted.syncDepth,
            maxSyncedDepth: decrypted.maxSyncedDepth,
            discoveredInTxid: decrypted.discoveredInTxid,
            discoveredFromRecordId: decrypted.discoveredFromRecordId,
            flowType: decrypted.flowType as FlowType | undefined,
            acquisitionMethod: decrypted.acquisitionMethod as AcquisitionMethod | undefined,
            dispositionType: decrypted.dispositionType as DispositionType | undefined,
            costBasisUsd: decrypted.costBasisUsd,
            counterpartyType: decrypted.counterpartyType as CounterpartyType | undefined,
          };
          setRecord(converted);
          setIsOpen(true);
        }
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
