import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search as SearchIcon, Database } from "lucide-react";
import { BlockchainToggle } from "@/components/BlockchainToggle";
import { db, subscribeToDbChanges, type Record as DbRecord, type VaultMetadata, type AddressImportance, type ChainType, type CustomField } from "@/lib/database";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";

// User-curated importance tiers (exclude blockchain-discovered and pending-review by default)
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

export default function Records() {
  const [location, navigate] = useLocation();
  
  const [records, setRecords] = useState<ConvertedRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<ConvertedRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [urlSearchQuery, setUrlSearchQuery] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomField[]>([]);
  
  // Filter state: by default, only show user-curated records (not blockchain-discovered)
  const [includeBlockchainDiscovered, setIncludeBlockchainDiscovered] = useState(false);
  const [totalBlockchainDiscovered, setTotalBlockchainDiscovered] = useState(0);
  
  // Track database changes to trigger reloads
  const changeVersionRef = useRef(0);
  const [dbChangeSignal, setDbChangeSignal] = useState(0);
  
  useEffect(() => {
    // Subscribe to database changes
    const unsubscribe = subscribeToDbChanges((tables) => {
      // Check if any change affects the records table
      if (tables.includes('records') || tables.length === 0) {
        changeVersionRef.current += 1;
        setDbChangeSignal(changeVersionRef.current);
      }
    });
    
    return unsubscribe;
  }, []);

  // Parse query parameters from location - store them for later application
  useEffect(() => {
    try {
      const queryIndex = location.indexOf('?');
      const queryString = queryIndex >= 0 ? location.substring(queryIndex + 1) : '';
      const params = new URLSearchParams(queryString);
      
      const id = params.get("id");
      const search = params.get("search");
      
      if (id) {
        setSelectedRecordId(id);
        setUrlSearchQuery(null);
      } else if (search) {
        const decodedSearch = decodeURIComponent(search);
        setUrlSearchQuery(decodedSearch);
        setSelectedRecordId(null);
      } else {
        setUrlSearchQuery(null);
      }
    } catch (error) {
      console.error('[Records] Failed to parse query params:', error);
    }
  }, [location]);

  // Apply URL search query to input once records are loaded
  useEffect(() => {
    if (urlSearchQuery !== null && records.length > 0 && !isLoading) {
      setSearchQuery(urlSearchQuery);
      setUrlSearchQuery(null); // Clear after applying
    }
  }, [urlSearchQuery, records.length, isLoading]);

  // Load records and custom field definitions with smart filtering
  useEffect(() => {
    const loadRecords = async () => {
      setIsLoading(true);
      try {
        // Load custom field definitions
        const fields = await db.customFields.toArray();
        setCustomFieldDefs(fields);
        
        // Count blockchain-discovered records for the toggle label
        const blockchainCount = await db.records
          .where('addressImportance')
          .anyOf(['blockchain-discovered', 'pending-review'])
          .count();
        setTotalBlockchainDiscovered(blockchainCount);
        
        // Query only the relevant importance tiers based on filter setting
        // Use indexed queries for performance - avoid full table scans
        let rawRecords: DbRecord[];
        
        if (includeBlockchainDiscovered) {
          // Load all records
          rawRecords = await db.records.toArray();
        } else {
          // Strategy: Use indexed queries only to avoid full table scans
          // 1. Get address records with user-curated importance tiers (indexed)
          const curatedAddresses = await db.records
            .where('addressImportance')
            .anyOf(USER_CURATED_TIERS)
            .toArray();
          
          // 2. Get legacy address records with null/undefined addressImportance (treat as manual)
          const legacyAddresses = await db.records
            .filter(r => r.type === 'address' && !r.addressImportance)
            .toArray();
          
          // 3. Get all transaction records (indexed by type)
          const transactions = await db.records
            .where('type')
            .equals('transaction')
            .toArray();
          
          // 4. Get all "other" type records (indexed by type)
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
        console.error('[Records] Failed to load records:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadRecords();
  }, [includeBlockchainDiscovered, dbChangeSignal]);

  // Filter records based on search query
  useEffect(() => {
    if (!searchQuery) {
      setFilteredRecords(records);
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
    
    setFilteredRecords(filtered);
  }, [records, searchQuery]);

  // State for directly-loaded record (when accessed by URL but not in filtered view)
  const [directLoadedRecord, setDirectLoadedRecord] = useState<ConvertedRecord | null>(null);
  
  // Load specific record by ID if accessed via URL but not in filtered view
  useEffect(() => {
    if (!selectedRecordId || isLoading) return;
    
    // Check if record is already in the filtered list
    const existingRecord = records.find(r => r.id === selectedRecordId);
    if (existingRecord) {
      setDirectLoadedRecord(null);
      return;
    }
    
    // Record not in current view - load it directly
    const loadRecord = async () => {
      try {
        const record = await db.records.get(parseInt(selectedRecordId));
        if (!record) return;
        
        let decrypted: DbRecord[];
        if (isEncryptionReady()) {
          decrypted = await decryptRecords([record]);
        } else {
          decrypted = [record];
        }
        
        if (decrypted.length > 0) {
          const r = decrypted[0];
          setDirectLoadedRecord({
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
          });
        }
      } catch (error) {
        console.error('[Records] Failed to load specific record:', error);
      }
    };
    
    loadRecord();
  }, [selectedRecordId, records, isLoading]);
  
  const selectedRecord = selectedRecordId 
    ? (records.find(r => r.id === selectedRecordId) || directLoadedRecord)
    : null;

  // If viewing a specific record by ID, show detail-focused view
  if (selectedRecordId && selectedRecord && !searchQuery) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => navigate("/records")}
              data-testid="button-back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">
                Record Details
              </h1>
              <p className="text-muted-foreground">
                View and edit metadata
              </p>
            </div>
          </div>

          <RecordDetailPanel
            open={true}
            record={selectedRecord}
            onClose={() => navigate("/records")}
            customFieldDefs={customFieldDefs}
          />
        </div>
      </div>
    );
  }

  // Default view: all records with search
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
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              Records
            </h1>
            <p className="text-muted-foreground">
              View and manage your Bitcoin metadata records
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
                  placeholder="Search by label, address, owner, wallet, or notes..."
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

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Records List */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>
                  {searchQuery ? `Search Results (${filteredRecords.length})` : `All Records (${filteredRecords.length})`}
                </CardTitle>
                <CardDescription>
                  Click on a record to view or edit details
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Loading records...
                  </div>
                ) : filteredRecords.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    {searchQuery ? "No records match your search" : "No records found"}
                  </div>
                ) : (
                  <RecordTable 
                    records={filteredRecords}
                    onRowClick={setSelectedRecordId}
                  />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Detail Panel */}
          {selectedRecord && (
            <div className="lg:col-span-1">
              <RecordDetailPanel
                open={true}
                record={selectedRecord}
                onClose={() => setSelectedRecordId(null)}
                customFieldDefs={customFieldDefs}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
