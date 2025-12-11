import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { 
  seedTestData, 
  clearTestData, 
  getTestDataSummary 
} from "@/lib/testSeedData";
import { 
  Database, 
  Trash2, 
  Play, 
  RefreshCw, 
  AlertTriangle,
  CheckCircle,
  Info,
  GitBranch,
  ClipboardList,
  Network
} from "lucide-react";

interface DataSummary {
  records: number;
  transactions: number;
  participants: number;
  lineage: number;
  segments: number;
}

export default function DevTestData() {
  const { toast } = useToast();
  const [isSeeding, setIsSeeding] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearExisting, setClearExisting] = useState(false);
  const [dataSummary, setDataSummary] = useState<DataSummary | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const refreshSummary = async () => {
    const summary = await getTestDataSummary();
    setDataSummary(summary);
  };

  const handleSeedData = async () => {
    setIsSeeding(true);
    try {
      const result = await seedTestData({ clearExisting });
      await refreshSummary();
      setLastAction(`Seeded ${result.recordCount} records, ${result.transactionCount} transactions, ${result.lineageCount} lineage links`);
      toast({
        title: "Test Data Seeded",
        description: `Created ${result.recordCount} records with transaction history and lineage tracking.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to seed test data",
        variant: "destructive",
      });
    } finally {
      setIsSeeding(false);
    }
  };

  const handleClearData = async () => {
    setIsClearing(true);
    try {
      await clearTestData();
      await refreshSummary();
      setLastAction("All test data cleared");
      toast({
        title: "Data Cleared",
        description: "All records, transactions, and lineage data have been removed.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to clear data",
        variant: "destructive",
      });
    } finally {
      setIsClearing(false);
    }
  };

  // Load summary on mount
  useState(() => {
    refreshSummary();
  });

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">Dev Tools</Badge>
            <h1 className="text-3xl font-bold" data-testid="text-page-title">Test Data Seeder</h1>
          </div>
          <p className="text-muted-foreground">
            Generate sample Bitcoin addresses with transaction history to test KYUTXO features.
          </p>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Demo Data</AlertTitle>
          <AlertDescription>
            This seeds the database with publicly known Bitcoin addresses and mock transaction relationships. 
            Use this to explore the Provenance, Flow Visualizer, and Reports features.
          </AlertDescription>
        </Alert>

        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Current Data
              </CardTitle>
              <CardDescription>Summary of data currently in your database</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={refreshSummary}
                data-testid="button-refresh-summary"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              
              {dataSummary ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-muted/50 rounded-md">
                    <div className="text-2xl font-bold" data-testid="text-record-count">{dataSummary.records}</div>
                    <div className="text-sm text-muted-foreground">Records</div>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md">
                    <div className="text-2xl font-bold" data-testid="text-transaction-count">{dataSummary.transactions}</div>
                    <div className="text-sm text-muted-foreground">Transactions</div>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md">
                    <div className="text-2xl font-bold" data-testid="text-lineage-count">{dataSummary.lineage}</div>
                    <div className="text-sm text-muted-foreground">Lineage Links</div>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md">
                    <div className="text-2xl font-bold" data-testid="text-segment-count">{dataSummary.segments}</div>
                    <div className="text-sm text-muted-foreground">Custody Segments</div>
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">Click refresh to load summary</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Play className="h-5 w-5" />
                Seed Actions
              </CardTitle>
              <CardDescription>Generate or clear test data</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Switch 
                  id="clear-existing"
                  checked={clearExisting}
                  onCheckedChange={setClearExisting}
                  data-testid="switch-clear-existing"
                />
                <Label htmlFor="clear-existing" className="cursor-pointer">
                  Clear existing data before seeding
                </Label>
              </div>
              
              <div className="flex flex-col gap-2">
                <Button 
                  onClick={handleSeedData}
                  disabled={isSeeding}
                  data-testid="button-seed-data"
                >
                  {isSeeding ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Seeding...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Seed Test Data
                    </>
                  )}
                </Button>
                
                <Button 
                  variant="destructive"
                  onClick={handleClearData}
                  disabled={isClearing}
                  data-testid="button-clear-data"
                >
                  {isClearing ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Clearing...
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Clear All Data
                    </>
                  )}
                </Button>
              </div>

              {lastAction && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground p-2 bg-muted/30 rounded">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  {lastAction}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle>What Gets Created</CardTitle>
            <CardDescription>The test data includes everything needed to demonstrate the origin tracking features</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <h4 className="font-medium flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  Records
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>5 Bitcoin addresses</li>
                  <li>2 owners (Demo User, Business Account)</li>
                  <li>3 wallets with seed names</li>
                  <li>Tags and categories</li>
                </ul>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  Transactions
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>4 blockchain transactions</li>
                  <li>Linked inputs and outputs</li>
                  <li>Change detection</li>
                  <li>Fee and block data</li>
                </ul>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium flex items-center gap-2">
                  <GitBranch className="h-4 w-4" />
                  Lineage
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>UTXO flow relationships</li>
                  <li>Custody segments with narratives</li>
                  <li>Ownership tracking</li>
                  <li>Evidence txid chains</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        <Alert variant="default">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Where to See the Features</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>After seeding data, navigate to these pages to see the origin tracking in action:</p>
            <ul className="list-disc list-inside space-y-1 mt-2">
              <li><strong>Analysis → Provenance</strong> - View the Continuity Proof timeline</li>
              <li><strong>Analysis → Reports</strong> - Export Continuity Certificates with selective disclosure</li>
              <li><strong>Dev Tools → Flow Visualizations</strong> - See Sankey diagrams with ownership highlighting</li>
              <li><strong>Overview → Records</strong> - Browse the seeded addresses and their metadata</li>
            </ul>
          </AlertDescription>
        </Alert>
      </div>
    </ScrollArea>
  );
}
