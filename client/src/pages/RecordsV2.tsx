import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  ArrowLeft, 
  Search as SearchIcon, 
  Hash, 
  ExternalLink
} from "lucide-react";
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { db, subscribeToDbChanges, type Record as DbRecord, type VaultMetadata, type AddressImportance, type ChainType, type CustomField, type BlockchainTransaction, type TransactionParticipant } from "@/lib/database";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { RecordTypeBadge } from "@/components/RecordTypeBadge";

import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const USER_CURATED_TIERS: AddressImportance[] = ['verified', 'manual', 'wallet-import', 'xpub-derived'];
const ALL_TIERS: AddressImportance[] = ['verified', 'manual', 'wallet-import', 'xpub-derived', 'blockchain-discovered', 'pending-review'];

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
  customFields?: { [key: string]: string };
  derivationPath?: string;
  chainType?: ChainType;
  vault?: VaultMetadata;
  addressImportance?: AddressImportance;
  syncDepth?: number;
  maxSyncedDepth?: number;
  discoveredInTxid?: string;
  discoveredFromRecordId?: number;
}

function formatAddressImportance(importance?: AddressImportance): string {
  if (!importance) return "Unknown";
  const map: Record<AddressImportance, string> = {
    'verified': 'Verified',
    'manual': 'Manual Entry',
    'wallet-import': 'Wallet Import',
    'xpub-derived': 'xPub Derived',
    'blockchain-discovered': 'Blockchain Discovered',
    'pending-review': 'Pending Review',
  };
  return map[importance] || importance;
}

function getImportanceBadgeVariant(importance?: AddressImportance): "default" | "secondary" | "outline" | "destructive" {
  switch (importance) {
    case 'verified': return 'default';
    case 'manual': return 'secondary';
    case 'wallet-import': return 'secondary';
    case 'xpub-derived': return 'secondary';
    case 'blockchain-discovered': return 'outline';
    case 'pending-review': return 'destructive';
    default: return 'outline';
  }
}

export default function RecordsV2() {
  const [location, navigate] = useLocation();
  
  const [records, setRecords] = useState<ConvertedRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<ConvertedRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [urlSearchQuery, setUrlSearchQuery] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomField[]>([]);
  
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);
  const [totalBlockchainDiscovered, setTotalBlockchainDiscovered] = useState(0);
  
  const [matchingTxids, setMatchingTxids] = useState<string[]>([]);
  const [txidSearchResults, setTxidSearchResults] = useState<{
    txid: string;
    blockHeight: number;
    blockTime: number;
    participantAddresses: string[];
  }[]>([]);
  
  const [selectedRecord, setSelectedRecord] = useState<ConvertedRecord | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  
  const changeVersionRef = useRef(0);
  const [dbChangeSignal, setDbChangeSignal] = useState(0);
  
  useEffect(() => {
    const unsubscribe = subscribeToDbChanges((tables) => {
      if (tables.includes('records') || tables.length === 0) {
        changeVersionRef.current += 1;
        setDbChangeSignal(changeVersionRef.current);
      }
    });
    
    return unsubscribe;
  }, []);

  useEffect(() => {
    try {
      const queryIndex = location.indexOf('?');
      const queryString = queryIndex >= 0 ? location.substring(queryIndex + 1) : '';
      const params = new URLSearchParams(queryString);
      
      const search = params.get("search");
      
      if (search) {
        const decodedSearch = decodeURIComponent(search);
        setUrlSearchQuery(decodedSearch);
      } else {
        setUrlSearchQuery(null);
      }
    } catch (error) {
      console.error('[RecordsV2] Failed to parse query params:', error);
    }
  }, [location]);

  useEffect(() => {
    if (urlSearchQuery !== null && records.length > 0 && !isLoading) {
      setSearchQuery(urlSearchQuery);
      setUrlSearchQuery(null);
    }
  }, [urlSearchQuery, records.length, isLoading]);

  useEffect(() => {
    const loadRecords = async () => {
      setIsLoading(true);
      try {
        const fields = await db.customFields.toArray();
        setCustomFieldDefs(fields);
        
        const blockchainCount = await db.records
          .where('addressImportance')
          .anyOf(['blockchain-discovered', 'pending-review'])
          .count();
        setTotalBlockchainDiscovered(blockchainCount);
        
        let rawRecords: DbRecord[];
        
        if (includeBlockchainDiscovered) {
          rawRecords = await db.records.toArray();
        } else {
          const curatedAddresses = await db.records
            .where('addressImportance')
            .anyOf(USER_CURATED_TIERS)
            .toArray();
          
          const legacyAddresses = await db.records
            .filter(r => r.type === 'address' && !r.addressImportance)
            .toArray();
          
          const transactions = await db.records
            .where('type')
            .equals('transaction')
            .toArray();
          
          const otherRecords = await db.records
            .where('type')
            .equals('other')
            .toArray();
          
          rawRecords = [...curatedAddresses, ...legacyAddresses, ...transactions, ...otherRecords];
        }
        
        let decrypted: DbRecord[];
        
        if (isEncryptionReady()) {
          decrypted = await decryptRecords(rawRecords);
        } else {
          decrypted = rawRecords;
        }
        
        const convertedRecords: ConvertedRecord[] = decrypted.map(r => ({
          id: String(r.id),
          type: r.type as "address" | "transaction" | "other",
          inputString: r.inputString,
          label: r.label,
          notes: r.notes,
          tags: r.tags || [],
          categories: r.categories || [],
          seedName: r.seedName,
          walletSoftware: r.walletSoftware,
          owner: r.owner,
          walletName: r.walletName,
          privateKeyStatus: r.privateKeyStatus,
          source: r.source,
          customFields: r.customFields,
          derivationPath: r.derivationPath,
          chainType: r.chainType,
          vault: r.vault,
          addressImportance: r.addressImportance,
          syncDepth: r.syncDepth,
          maxSyncedDepth: r.maxSyncedDepth,
          discoveredInTxid: r.discoveredInTxid,
          discoveredFromRecordId: r.discoveredFromRecordId,
        }));
        
        setRecords(convertedRecords);
      } catch (error) {
        console.error('[RecordsV2] Failed to load records:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadRecords();
  }, [includeBlockchainDiscovered, dbChangeSignal]);

  useEffect(() => {
    if (!searchQuery) {
      setFilteredRecords(records);
      setMatchingTxids([]);
      setTxidSearchResults([]);
      return;
    }

    const query = searchQuery.toLowerCase();
    
    const filtered = records.filter(record => 
      record.label?.toLowerCase().includes(query) ||
      record.inputString?.toLowerCase().includes(query) ||
      record.owner?.toLowerCase().includes(query) ||
      record.walletName?.toLowerCase().includes(query) ||
      record.notes?.toLowerCase().includes(query)
    );
    
    const isTxidSearch = /^[a-fA-F0-9]{8,64}$/.test(searchQuery.trim());
    
    if (isTxidSearch) {
      const searchBlockchainTxs = async () => {
        try {
          const txQuery = searchQuery.toLowerCase().trim();
          
          const matchingTxs = await db.blockchainTransactions
            .filter(tx => tx.txid.toLowerCase().startsWith(txQuery) || tx.txid.toLowerCase().includes(txQuery))
            .toArray();
          
          if (matchingTxs.length > 0) {
            const txids = matchingTxs.map(tx => tx.txid);
            setMatchingTxids(txids);
            
            const participants = await db.transactionParticipants
              .where('txid')
              .anyOf(txids)
              .toArray();
            
            const txResults = matchingTxs.map(tx => ({
              txid: tx.txid,
              blockHeight: tx.blockHeight,
              blockTime: tx.blockTime,
              participantAddresses: participants
                .filter(p => p.txid === tx.txid)
                .map(p => p.address),
            }));
            
            setTxidSearchResults(txResults);
            
            const participantAddresses = new Set(participants.map(p => p.address));
            
            const allRelatedRawRecords = await db.records
              .where('inputString')
              .anyOf(Array.from(participantAddresses))
              .toArray();
            
            let relatedRecords: DbRecord[];
            if (isEncryptionReady()) {
              relatedRecords = await decryptRecords(allRelatedRawRecords);
            } else {
              relatedRecords = allRelatedRawRecords;
            }
            
            const convertedRelated: ConvertedRecord[] = relatedRecords.map(r => ({
              id: String(r.id),
              type: r.type as "address" | "transaction" | "other",
              inputString: r.inputString,
              label: r.label,
              notes: r.notes,
              tags: r.tags || [],
              categories: r.categories || [],
              seedName: r.seedName,
              walletSoftware: r.walletSoftware,
              owner: r.owner,
              walletName: r.walletName,
              privateKeyStatus: r.privateKeyStatus,
              source: r.source,
              customFields: r.customFields,
              derivationPath: r.derivationPath,
              chainType: r.chainType,
              vault: r.vault,
              addressImportance: r.addressImportance,
              syncDepth: r.syncDepth,
              maxSyncedDepth: r.maxSyncedDepth,
              discoveredInTxid: r.discoveredInTxid,
              discoveredFromRecordId: r.discoveredFromRecordId,
            }));
            
            const existingIds = new Set(convertedRelated.map(r => r.id));
            const additionalFromFilter = filtered.filter(r => !existingIds.has(r.id));
            
            setFilteredRecords([...convertedRelated, ...additionalFromFilter]);
          } else {
            setMatchingTxids([]);
            setTxidSearchResults([]);
            setFilteredRecords(filtered);
          }
        } catch (error) {
          console.error('[RecordsV2] Error searching blockchain transactions:', error);
          setMatchingTxids([]);
          setTxidSearchResults([]);
          setFilteredRecords(filtered);
        }
      };
      
      searchBlockchainTxs();
    } else {
      setMatchingTxids([]);
      setTxidSearchResults([]);
      setFilteredRecords(filtered);
    }
  }, [records, searchQuery]);

  const handleViewDetails = (record: ConvertedRecord) => {
    setSelectedRecord(record);
    setSheetOpen(true);
  };

  const handleEditRecord = (record: ConvertedRecord) => {
    navigate(`/records?id=${record.id}`);
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => navigate("/")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold" data-testid="text-page-title">
                Records
              </h1>
              <Badge variant="outline" className="text-xs">V2 Quick Actions</Badge>
            </div>
            <p className="text-muted-foreground">
              Click any row to view full details
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label htmlFor="search" className="text-sm font-medium">
                Search Records
              </label>
              <div className="mt-2 relative">
                <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Search by label, address, txid, owner, wallet, or notes..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
            </div>
            <div className="pt-6">
              <BlockchainToggle
                checked={includeBlockchainDiscovered}
                onCheckedChange={setIncludeBlockchainDiscovered}
                hiddenCount={totalBlockchainDiscovered}
              />
            </div>
          </div>
        </div>

        {txidSearchResults.length > 0 && (
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Hash className="h-4 w-4" />
                Blockchain Transactions Found ({txidSearchResults.length})
              </CardTitle>
              <CardDescription>
                Synced transactions matching your search. Click to view on Transactions page.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {txidSearchResults.map((tx) => (
                <div 
                  key={tx.txid}
                  className="p-3 rounded-lg bg-background border hover-elevate cursor-pointer"
                  onClick={() => navigate(`/transactions?search=${tx.txid}`)}
                  data-testid={`tx-result-${tx.txid.slice(0, 8)}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <code className="text-sm font-mono truncate flex-1">
                      {tx.txid.slice(0, 16)}...{tx.txid.slice(-16)}
                    </code>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        Block {tx.blockHeight.toLocaleString()}
                      </Badge>
                      <a
                        href={`https://mempool.space/tx/${tx.txid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-primary"
                        data-testid={`tx-explorer-${tx.txid.slice(0, 8)}`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(tx.blockTime * 1000).toLocaleDateString()} - {tx.participantAddresses.length} addresses involved
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>
              {searchQuery 
                ? txidSearchResults.length > 0 
                  ? `Related Address Records (${filteredRecords.length})`
                  : `Search Results (${filteredRecords.length})` 
                : `All Records (${filteredRecords.length})`}
            </CardTitle>
            <CardDescription>
              {txidSearchResults.length > 0 
                ? "Addresses involved in the matching transactions"
                : "Hover over addresses for quick preview, click row for details"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                Loading records...
              </div>
            ) : filteredRecords.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {searchQuery 
                  ? txidSearchResults.length > 0
                    ? "No address records found for this transaction. Addresses may not have been synced yet."
                    : "No records match your search"
                  : "No records found"}
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">Type</TableHead>
                      <TableHead>Label</TableHead>
                      <TableHead>Address / TxID</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Tags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRecords.map((record) => (
                      <TableRow 
                        key={record.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => handleViewDetails(record)}
                        data-testid={`row-record-${record.id}`}
                      >
                        <TableCell>
                          <RecordTypeBadge type={record.type} />
                        </TableCell>
                        <TableCell className="font-medium">
                          {record.label || "-"}
                        </TableCell>
                        <TableCell>
                          <span
                            className="font-mono text-sm"
                            data-testid={`address-${record.id}`}
                          >
                            {record.inputString.length > 20 
                              ? `${record.inputString.slice(0, 10)}...${record.inputString.slice(-8)}`
                              : record.inputString}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{record.owner || "-"}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 flex-wrap max-w-[150px]">
                            {record.tags.slice(0, 2).map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                            ))}
                            {record.tags.length > 2 && (
                              <Badge variant="outline" className="text-xs">+{record.tags.length - 2}</Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <RecordDetailPanel
        open={sheetOpen}
        record={selectedRecord || undefined}
        onClose={() => setSheetOpen(false)}
        onEdit={() => {
          if (selectedRecord) {
            setSheetOpen(false);
            handleEditRecord(selectedRecord);
          }
        }}
      />
    </div>
  );
}
