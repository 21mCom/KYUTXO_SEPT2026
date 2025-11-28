import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { 
  ArrowLeft,
  Search,
  ArrowRight,
  Link2,
  Loader2,
  Info,
  CheckCircle2,
  AlertCircle,
  GitBranch
} from "lucide-react";
import { 
  findLabeledConnections, 
  findPathBetweenAddresses,
  getProvenanceChain,
  getProvenanceStats,
  type ConnectionResult,
  type AddressNode,
  type FlowPath
} from "@/lib/provenance";
import { db, type Record as DbRecord } from "@/lib/database";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { formatDistanceToNow, format } from "date-fns";

export default function Provenance() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  
  const [stats, setStats] = useState<{
    labeledAddresses: number;
    syncedAddresses: number;
    transactionsStored: number;
    potentialConnections: number;
  } | null>(null);
  
  const [isSearching, setIsSearching] = useState(false);
  const [connections, setConnections] = useState<ConnectionResult[]>([]);
  const [searchDepth, setSearchDepth] = useState<number>(3);
  
  const [sourceAddress, setSourceAddress] = useState("");
  const [targetAddress, setTargetAddress] = useState("");
  const [pathResult, setPathResult] = useState<FlowPath | null | "not_found">(null);
  const [isPathSearching, setIsPathSearching] = useState(false);
  
  const [provenanceAddress, setProvenanceAddress] = useState("");
  const [provenanceChain, setProvenanceChain] = useState<AddressNode[]>([]);
  const [isProvenanceSearching, setIsProvenanceSearching] = useState(false);

  const [labeledAddresses, setLabeledAddresses] = useState<DbRecord[]>([]);

  const loadStats = useCallback(async () => {
    const s = await getProvenanceStats();
    setStats(s);
    
    // Load labeled addresses for selectors
    const allRawRecords = await db.records.toArray();
    let allRecords: DbRecord[];
    if (isEncryptionReady()) {
      allRecords = await decryptRecords(allRawRecords);
    } else {
      allRecords = allRawRecords;
    }
    const labeled = allRecords.filter(r => 
      r.type === 'address' && 
      r.label && 
      r.label !== '' && 
      r.owner !== 'Pending Review'
    );
    setLabeledAddresses(labeled);
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleFindConnections = async () => {
    setIsSearching(true);
    setConnections([]);
    
    try {
      const results = await findLabeledConnections(searchDepth);
      setConnections(results);
      
      if (results.length === 0) {
        toast({
          title: "No Connections Found",
          description: "No paths found between labeled addresses. Try syncing more transactions.",
        });
      } else {
        toast({
          title: "Connections Found",
          description: `Found ${results.length} connection(s) between labeled addresses.`,
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Search Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsSearching(false);
    }
  };

  const handlePathSearch = async () => {
    if (!sourceAddress || !targetAddress) {
      toast({
        variant: "destructive",
        title: "Missing Input",
        description: "Please select both source and target addresses",
      });
      return;
    }

    setIsPathSearching(true);
    setPathResult(null);
    
    try {
      const path = await findPathBetweenAddresses(sourceAddress, targetAddress, searchDepth);
      setPathResult(path || "not_found");
      
      if (!path) {
        toast({
          title: "No Path Found",
          description: "No connection found between these addresses within the search depth.",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Search Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsPathSearching(false);
    }
  };

  const handleProvenanceSearch = async () => {
    if (!provenanceAddress) {
      toast({
        variant: "destructive",
        title: "Missing Input",
        description: "Please select an address to trace",
      });
      return;
    }

    setIsProvenanceSearching(true);
    setProvenanceChain([]);
    
    try {
      const chain = await getProvenanceChain(provenanceAddress, searchDepth);
      setProvenanceChain(chain);
      
      if (chain.length === 0) {
        toast({
          title: "No Origins Found",
          description: "No incoming transactions found. Address may not have received any funds yet.",
        });
      } else {
        const labeledCount = chain.filter(n => n.isLabeled).length;
        toast({
          title: "Provenance Traced",
          description: `Found ${chain.length} source address(es), ${labeledCount} are labeled.`,
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Search Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsProvenanceSearching(false);
    }
  };

  const formatSats = (sats: number) => {
    if (sats >= 100000000) {
      return `${(sats / 100000000).toFixed(8)} BTC`;
    }
    return `${sats.toLocaleString()} sats`;
  };

  const truncateAddress = (addr: string) => {
    return `${addr.substring(0, 8)}...${addr.substring(addr.length - 6)}`;
  };

  const getLabelForAddress = (address: string) => {
    const record = labeledAddresses.find(r => r.inputString === address);
    return record?.label || null;
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Provenance Tracking</h1>
            <p className="text-muted-foreground">Trace the origins and connections of your Bitcoin addresses</p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>How It Works</AlertTitle>
          <AlertDescription>
            This tool analyzes transaction data you've synced to find connections between your labeled addresses.
            Sync more transactions at deeper levels to discover additional relationships.
          </AlertDescription>
        </Alert>

        {/* Stats Overview */}
        <div className="grid gap-4 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Labeled Addresses</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-labeled-count">
                {stats?.labeledAddresses ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Synced Addresses</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-synced-count">
                {stats?.syncedAddresses ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Transactions</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-tx-count">
                {stats?.transactionsStored ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Possible Pairs</CardDescription>
              <CardTitle className="text-2xl" data-testid="text-pairs-count">
                {stats?.potentialConnections ?? '-'}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        {/* Find All Connections */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Find All Connections
            </CardTitle>
            <CardDescription>
              Discover all paths between your labeled addresses
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-4">
              <div className="space-y-2 flex-1">
                <Label htmlFor="search-depth">Search Depth</Label>
                <Select
                  value={searchDepth.toString()}
                  onValueChange={(v) => setSearchDepth(parseInt(v))}
                  disabled={isSearching}
                >
                  <SelectTrigger id="search-depth" data-testid="select-search-depth">
                    <SelectValue placeholder="Select depth" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">2 hops</SelectItem>
                    <SelectItem value="3">3 hops</SelectItem>
                    <SelectItem value="4">4 hops</SelectItem>
                    <SelectItem value="5">5 hops</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button 
                onClick={handleFindConnections}
                disabled={isSearching || (stats?.labeledAddresses ?? 0) < 2}
                data-testid="button-find-connections"
              >
                {isSearching ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    Find Connections
                  </>
                )}
              </Button>
            </div>

            {connections.length > 0 && (
              <ScrollArea className="h-64 border rounded-md p-4">
                <div className="space-y-3">
                  {connections.map((conn, idx) => (
                    <div 
                      key={idx} 
                      className="flex items-center gap-2 p-2 rounded-md bg-muted/50"
                    >
                      <Badge variant="default" className="text-xs shrink-0">
                        {getLabelForAddress(conn.sourceAddress) || truncateAddress(conn.sourceAddress)}
                      </Badge>
                      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      <Badge variant="default" className="text-xs shrink-0">
                        {getLabelForAddress(conn.targetAddress) || truncateAddress(conn.targetAddress)}
                      </Badge>
                      <div className="ml-auto flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {conn.shortestPath} hop{conn.shortestPath !== 1 ? 's' : ''}
                        </Badge>
                        {conn.directConnection && (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}

            {(stats?.labeledAddresses ?? 0) < 2 && (
              <p className="text-sm text-muted-foreground">
                Label at least 2 addresses to search for connections between them.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Path Between Two Addresses */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5" />
              Trace Path Between Addresses
            </CardTitle>
            <CardDescription>
              Find the path between two specific addresses
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="source-address">Source Address</Label>
                <Select
                  value={sourceAddress}
                  onValueChange={setSourceAddress}
                  disabled={isPathSearching}
                >
                  <SelectTrigger id="source-address" data-testid="select-source-address">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {labeledAddresses.map((record) => (
                      <SelectItem key={record.id} value={record.inputString}>
                        {record.label} ({truncateAddress(record.inputString)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="target-address">Target Address</Label>
                <Select
                  value={targetAddress}
                  onValueChange={setTargetAddress}
                  disabled={isPathSearching}
                >
                  <SelectTrigger id="target-address" data-testid="select-target-address">
                    <SelectValue placeholder="Select target" />
                  </SelectTrigger>
                  <SelectContent>
                    {labeledAddresses.map((record) => (
                      <SelectItem key={record.id} value={record.inputString}>
                        {record.label} ({truncateAddress(record.inputString)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button 
              onClick={handlePathSearch}
              disabled={isPathSearching || !sourceAddress || !targetAddress}
              className="w-full sm:w-auto"
              data-testid="button-trace-path"
            >
              {isPathSearching ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Tracing...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Trace Path
                </>
              )}
            </Button>

            {pathResult === "not_found" && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>No Path Found</AlertTitle>
                <AlertDescription>
                  No connection found between these addresses within {searchDepth} hops.
                  Try syncing more transactions or increasing the search depth.
                </AlertDescription>
              </Alert>
            )}

            {pathResult && pathResult !== "not_found" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="default">Path Found</Badge>
                  <span className="text-sm text-muted-foreground">
                    {pathResult.totalSteps} transaction{pathResult.totalSteps !== 1 ? 's' : ''}
                  </span>
                </div>
                <ScrollArea className="h-48 border rounded-md p-4">
                  <div className="space-y-2">
                    {pathResult.hops.map((hop, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-sm">
                        <Badge variant="outline" className="shrink-0">
                          {idx + 1}
                        </Badge>
                        <span className="font-mono text-xs">
                          {getLabelForAddress(hop.fromAddress) || truncateAddress(hop.fromAddress)}
                        </span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span className="font-mono text-xs">
                          {getLabelForAddress(hop.toAddress) || truncateAddress(hop.toAddress)}
                        </span>
                        <span className="ml-auto text-muted-foreground text-xs">
                          {formatSats(hop.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Provenance Chain */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 rotate-180" />
              Trace Origins
            </CardTitle>
            <CardDescription>
              Find where the funds in an address originally came from
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="provenance-address">Address to Trace</Label>
              <Select
                value={provenanceAddress}
                onValueChange={setProvenanceAddress}
                disabled={isProvenanceSearching}
              >
                <SelectTrigger id="provenance-address" data-testid="select-provenance-address">
                  <SelectValue placeholder="Select address" />
                </SelectTrigger>
                <SelectContent>
                  {labeledAddresses.map((record) => (
                    <SelectItem key={record.id} value={record.inputString}>
                      {record.label} ({truncateAddress(record.inputString)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button 
              onClick={handleProvenanceSearch}
              disabled={isProvenanceSearching || !provenanceAddress}
              data-testid="button-trace-origins"
            >
              {isProvenanceSearching ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Tracing...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Trace Origins
                </>
              )}
            </Button>

            {provenanceChain.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="default">Origins Found</Badge>
                  <span className="text-sm text-muted-foreground">
                    {provenanceChain.length} source address{provenanceChain.length !== 1 ? 'es' : ''}
                  </span>
                </div>
                <ScrollArea className="h-48 border rounded-md p-4">
                  <div className="space-y-2">
                    {provenanceChain.map((node, idx) => (
                      <div 
                        key={idx} 
                        className="flex items-center gap-2 p-2 rounded-md bg-muted/50"
                      >
                        <span className="font-mono text-xs">
                          {truncateAddress(node.address)}
                        </span>
                        {node.isLabeled ? (
                          <Badge variant="default" className="text-xs">
                            {node.label}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            {node.owner || 'Unknown'}
                          </Badge>
                        )}
                        {node.syncDepth !== undefined && (
                          <Badge variant="outline" className="text-xs ml-auto">
                            D{node.syncDepth}
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
