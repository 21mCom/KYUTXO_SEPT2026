import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search as SearchIcon } from "lucide-react";
import { db, type Record as DbRecord } from "@/lib/database";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";

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
}

export default function Records() {
  const [location, navigate] = useLocation();
  
  const [records, setRecords] = useState<ConvertedRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<ConvertedRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // Parse query parameters from location
  useEffect(() => {
    const url = new URL(location, window.location.origin);
    const id = url.searchParams.get("id");
    const search = url.searchParams.get("search");
    
    if (id) {
      setSelectedRecordId(id);
    }
    if (search) {
      setSearchQuery(search);
    }
  }, [location]);

  // Load records
  useEffect(() => {
    const loadRecords = async () => {
      setIsLoading(true);
      try {
        const rawRecords = await db.records.toArray();
        let decrypted: DbRecord[];
        
        if (isEncryptionReady()) {
          decrypted = await decryptRecords(rawRecords);
        } else {
          decrypted = rawRecords;
        }
        
        // Convert database records to component format (string IDs)
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
        }));
        
        setRecords(convertedRecords);
      } catch (error) {
        console.error('[Records] Failed to load records:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadRecords();
  }, []);

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

  const selectedRecord = selectedRecordId 
    ? records.find(r => r.id === selectedRecordId)
    : null;

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

        <div className="flex items-end gap-4">
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
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
