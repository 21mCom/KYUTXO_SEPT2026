import { useState } from "react";
import { useLocation } from "wouter";
import { db, type Record as DbRecord, type ChainType, type AddressImportance, type VaultMetadata, type FlowType, type AcquisitionMethod, type DispositionType, type CounterpartyType } from "@/lib/database";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { RecordDetailPanel } from "./RecordDetailPanel";

interface ClickableAddressProps {
  address: string;
  truncate?: boolean;
  truncateLength?: number;
  className?: string;
  showFullOnHover?: boolean;
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
  truncate = true, 
  truncateLength = 20,
  className = "",
  showFullOnHover = false
}: ClickableAddressProps) {
  const [, navigate] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [record, setRecord] = useState<ConvertedRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const displayAddress = truncate && address.length > truncateLength
    ? `${address.slice(0, 10)}...${address.slice(-8)}`
    : address;

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
      
      if (dbRecord && isEncryptionReady()) {
        const decryptedRecords = await decryptRecords([dbRecord]);
        const decrypted = decryptedRecords[0];
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
      <button
        onClick={handleClick}
        className={`font-mono text-sm text-left hover:text-primary hover:underline transition-colors cursor-pointer ${className}`}
        title={showFullOnHover ? address : undefined}
        disabled={isLoading}
        data-testid={`clickable-address-${address.slice(0, 8)}`}
      >
        {isLoading ? "..." : displayAddress}
      </button>
      
      <RecordDetailPanel
        open={isOpen}
        record={record || undefined}
        onClose={() => setIsOpen(false)}
        onEdit={handleEdit}
      />
    </>
  );
}
