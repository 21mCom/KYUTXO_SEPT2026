import { useState, useEffect, useMemo } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PAGE_DEBOUNCE } from "@/config/debounce";
import { useLocation } from "wouter";
import { AlertCircle, Check, ChevronRight, Filter, Loader2, Search, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { type Record as DBRecord, type RecordOrigin } from "@/lib/database";
import { getRecordOrigins, updateRecord, getRecordsByIds } from "@/lib/dataFacade";
import { getAllRecordOrigins } from "@/lib/data/record-origins-crud";
import { 
  SINGULAR_FIELDS, 
  detectSingularFieldConflicts, 
  type FieldConflict,
  type FieldConfig 
} from "@/lib/conflict-detection";
import { searchPendingClass } from "@/lib/search-pending-class";

interface RecordWithConflicts {
  record: DBRecord;
  origins: RecordOrigin[];
  conflicts: FieldConflict[];
}

export default function ConflictResolution() {
  const [, navigate] = useLocation();
  const [location] = useLocation();
  const { toast } = useToast();
  
  const [isLoading, setIsLoading] = useState(true);
  const [recordsWithConflicts, setRecordsWithConflicts] = useState<RecordWithConflicts[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, isSearchPending] = useDebouncedValue(searchQuery, PAGE_DEBOUNCE.ConflictResolution);
  const [fieldFilter, setFieldFilter] = useState<string>("all");
  const [selectedRecord, setSelectedRecord] = useState<RecordWithConflicts | null>(null);
  const [selectedConflict, setSelectedConflict] = useState<FieldConflict | null>(null);
  const [selectedValue, setSelectedValue] = useState<string>("");
  const [customValue, setCustomValue] = useState<string>("");
  const [useCustom, setUseCustom] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);

  const urlParams = new URLSearchParams(location.split('?')[1] || '');
  const filterRecordId = urlParams.get('recordId');

  useEffect(() => {
    loadRecordsWithConflicts();
  }, []);

  async function loadRecordsWithConflicts() {
    setIsLoading(true);
    try {
      const allOrigins = await getAllRecordOrigins();
      const originCountByRecordId = new Map<number, number>();
      allOrigins.forEach(o => {
        originCountByRecordId.set(o.recordId, (originCountByRecordId.get(o.recordId) || 0) + 1);
      });
      
      const multiOriginIds = Array.from(originCountByRecordId.entries())
        .filter(([, count]) => count >= 2)
        .map(([id]) => id);
      
      if (multiOriginIds.length === 0) {
        setRecordsWithConflicts([]);
        setIsLoading(false);
        return;
      }
      
      const records = await getRecordsByIds(multiOriginIds);
      
      const recordsWithConflictData: RecordWithConflicts[] = [];
      
      for (const record of records) {
        if (!record.id) continue;
        
        const origins = await getRecordOrigins(record.id);
        if (origins.length < 2) continue;
        
        const conflicts = detectSingularFieldConflicts(record, origins);
        if (conflicts.length > 0) {
          recordsWithConflictData.push({ record, origins, conflicts });
        }
      }
      
      setRecordsWithConflicts(recordsWithConflictData);
    } catch (error) {
      console.error("Failed to load records with conflicts:", error);
      toast({
        title: "Error",
        description: "Failed to load conflict data",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }

  const filteredRecords = useMemo(() => {
    let filtered = recordsWithConflicts;
    
    if (filterRecordId) {
      filtered = filtered.filter(r => String(r.record.id) === filterRecordId);
    }
    
    if (debouncedSearchQuery) {
      const query = debouncedSearchQuery.toLowerCase();
      filtered = filtered.filter(r => 
        r.record.inputString.toLowerCase().includes(query) ||
        r.record.label?.toLowerCase().includes(query) ||
        r.record.owner?.toLowerCase().includes(query)
      );
    }
    
    if (fieldFilter !== "all") {
      filtered = filtered.filter(r => 
        r.conflicts.some(c => c.field.key === fieldFilter)
      );
    }
    
    return filtered;
  }, [recordsWithConflicts, debouncedSearchQuery, fieldFilter, filterRecordId]);

  const totalConflicts = useMemo(() => {
    return filteredRecords.reduce((sum, r) => sum + r.conflicts.length, 0);
  }, [filteredRecords]);

  function openResolveDialog(recordData: RecordWithConflicts, conflict: FieldConflict) {
    setSelectedRecord(recordData);
    setSelectedConflict(conflict);
    
    const activeNormalized = conflict.activeValue?.trim() || "";
    const matchingOrigin = conflict.originValues.find(ov => ov.value === activeNormalized);
    const initialValue = matchingOrigin ? matchingOrigin.value : (conflict.originValues[0]?.value || "");
    
    setSelectedValue(initialValue);
    setCustomValue(activeNormalized);
    setUseCustom(false);
    setResolveDialogOpen(true);
  }

  async function handleResolve() {
    if (!selectedRecord || !selectedConflict) return;
    
    const valueToApply = useCustom ? customValue.trim() : selectedValue;
    if (!valueToApply && !useCustom) {
      toast({
        title: "No value selected",
        description: "Please select a value from the list or enter a custom value",
        variant: "destructive",
      });
      return;
    }
    
    setIsResolving(true);
    try {
      const fieldKey = selectedConflict.field.recordKey;
      if (!fieldKey) throw new Error("Invalid field key");
      
      const recordId = typeof selectedRecord.record.id === 'string' 
        ? parseInt(selectedRecord.record.id, 10) 
        : selectedRecord.record.id;
      
      if (!recordId || isNaN(recordId)) {
        throw new Error("Invalid record ID");
      }
      
      await updateRecord(recordId, { [fieldKey]: valueToApply || "" });
      
      toast({
        title: "Conflict resolved",
        description: `${selectedConflict.field.label} updated successfully`,
      });
      
      setResolveDialogOpen(false);
      await loadRecordsWithConflicts();
    } catch (error) {
      console.error("Failed to resolve conflict:", error);
      toast({
        title: "Error",
        description: "Failed to apply the selected value",
        variant: "destructive",
      });
    } finally {
      setIsResolving(false);
    }
  }

  function getOriginTypeLabel(originType: string): string {
    const labels: Record<string, string> = {
      'manual': 'Manual',
      'xpub-derived': 'xPub Import',
      'wallet-sync': 'Wallet Sync',
      'bulk-import': 'Bulk Import',
      'blockchain-sync': 'Blockchain',
    };
    return labels[originType] || originType;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">Conflict Resolution</h1>
          <p className="text-muted-foreground mt-1">
            Resolve metadata conflicts where multiple import sources have different values
          </p>
        </div>
        {filterRecordId && (
          <Button 
            variant="outline" 
            onClick={() => navigate("/conflict-resolution")}
            data-testid="button-clear-filter"
          >
            <X className="h-4 w-4 mr-2" />
            Clear Filter
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 flex-1">
              <div className="relative flex-1 max-w-sm">
                {isSearchPending ? (
                  <Loader2 className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-search-pending" />
                ) : (
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                )}
                <Input
                  placeholder="Search addresses or labels..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
              <Select value={fieldFilter} onValueChange={setFieldFilter}>
                <SelectTrigger className="w-[180px]" data-testid="select-field-filter">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Filter by field" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Fields</SelectItem>
                  {SINGULAR_FIELDS.map(field => (
                    <SelectItem key={field.key} value={field.key}>
                      {field.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1">
                <AlertCircle className="h-3 w-3" />
                {totalConflicts} conflicts in {filteredRecords.length} records
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className={`${searchPendingClass(isSearchPending, 'ConflictResolution')}`}>
          {filteredRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {recordsWithConflicts.length === 0 ? (
                <>
                  <Check className="h-12 w-12 mx-auto mb-4 text-green-500" />
                  <p className="text-lg font-medium text-foreground">No conflicts found</p>
                  <p>All your records have consistent metadata across import sources.</p>
                </>
              ) : (
                <>
                  <Search className="h-12 w-12 mx-auto mb-4" />
                  <p>No records match your search criteria</p>
                </>
              )}
            </div>
          ) : (
            <ScrollArea className="h-[600px]">
              <div className="space-y-4">
                {filteredRecords.map((recordData) => (
                  <Card key={recordData.record.id} className="border-l-4 border-l-orange-500">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-sm font-mono truncate" data-testid={`text-address-${recordData.record.id}`}>
                            {recordData.record.inputString}
                          </CardTitle>
                          {recordData.record.label && (
                            <CardDescription className="truncate">
                              {recordData.record.label}
                            </CardDescription>
                          )}
                        </div>
                        <Badge variant="outline" className="shrink-0 gap-1 text-orange-600 border-orange-300">
                          <AlertCircle className="h-3 w-3" />
                          {recordData.conflicts.length} conflicts
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="space-y-2">
                        {recordData.conflicts.map((conflict) => (
                          <div 
                            key={conflict.field.key}
                            className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover-elevate cursor-pointer"
                            onClick={() => openResolveDialog(recordData, conflict)}
                            data-testid={`button-resolve-${recordData.record.id}-${conflict.field.key}`}
                          >
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm">{conflict.field.label}</span>
                                <Badge variant="secondary" className="text-xs">
                                  {conflict.originValues.length} values
                                </Badge>
                              </div>
                              <div className="text-xs text-muted-foreground mt-1">
                                Active: <span className="font-medium text-foreground">{conflict.activeValue || "(empty)"}</span>
                              </div>
                            </div>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Dialog open={resolveDialogOpen} onOpenChange={setResolveDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Resolve {selectedConflict?.field.label} Conflict</DialogTitle>
            <DialogDescription>
              Choose which value should be the active value for this field, or enter a custom value.
            </DialogDescription>
          </DialogHeader>
          
          {selectedConflict && (
            <div className="space-y-4">
              <div className="text-sm">
                <span className="text-muted-foreground">Address: </span>
                <span className="font-mono text-xs">{selectedRecord?.record.inputString}</span>
              </div>
              
              <Separator />
              
              <div className="space-y-3">
                <Label>Select a value from import sources:</Label>
                <RadioGroup 
                  value={useCustom ? "" : selectedValue} 
                  onValueChange={(v) => { setSelectedValue(v); setUseCustom(false); }}
                >
                  {selectedConflict.originValues.map((ov, idx) => (
                    <div 
                      key={idx} 
                      className={`flex items-center space-x-3 p-3 rounded-lg border ${
                        !useCustom && selectedValue === ov.value 
                          ? "border-primary bg-primary/5" 
                          : "border-border"
                      }`}
                    >
                      <RadioGroupItem value={ov.value} id={`origin-${idx}`} />
                      <Label htmlFor={`origin-${idx}`} className="flex-1 cursor-pointer">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{ov.value}</span>
                          <Badge variant="outline" className="text-xs">
                            {getOriginTypeLabel(ov.originType)}
                          </Badge>
                        </div>
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
              
              <Separator />
              
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="use-custom"
                    checked={useCustom}
                    onChange={(e) => setUseCustom(e.target.checked)}
                    className="rounded border-border"
                  />
                  <Label htmlFor="use-custom">Use custom value instead</Label>
                </div>
                {useCustom && (
                  <Input
                    value={customValue}
                    onChange={(e) => setCustomValue(e.target.value)}
                    placeholder="Enter custom value..."
                    data-testid="input-custom-value"
                  />
                )}
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleResolve} disabled={isResolving}>
              {isResolving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Applying...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Apply Value
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
