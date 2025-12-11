import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, GitBranch, Search, Shield } from "lucide-react";
import { SourceOfFundsReport } from "@/components/reports/SourceOfFundsReport";
import { HopPointReport } from "@/components/reports/HopPointReport";
import { ContinuityCertificateReport } from "@/components/reports/ContinuityCertificateReport";

export default function Reports() {
  const [activeTab, setActiveTab] = useState("source-of-funds");

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-reports-title">Reports</h1>
          <p className="text-muted-foreground">
            Generate compliance and analysis reports from your Bitcoin data
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-3 max-w-xl">
            <TabsTrigger value="source-of-funds" className="flex items-center gap-2" data-testid="tab-source-of-funds">
              <FileText className="h-4 w-4" />
              Source of Funds
            </TabsTrigger>
            <TabsTrigger value="hop-points" className="flex items-center gap-2" data-testid="tab-hop-points">
              <GitBranch className="h-4 w-4" />
              Hop Points
            </TabsTrigger>
            <TabsTrigger value="continuity" className="flex items-center gap-2" data-testid="tab-continuity">
              <Shield className="h-4 w-4" />
              Continuity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="source-of-funds" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Source of Funds Declaration
                </CardTitle>
                <CardDescription>
                  Prove acquisition cost and current value for addresses. Internal transfers between your own wallets are flagged as non-taxable events.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SourceOfFundsReport />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="hop-points" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Search className="h-5 w-5" />
                  Hop Point Detection
                </CardTitle>
                <CardDescription>
                  Identify unclassified addresses that act as intermediaries between your known addresses. These may represent consolidation transactions, change addresses, or unknown third parties.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HopPointReport />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="continuity" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5" />
                  Continuity Certificates
                </CardTitle>
                <CardDescription>
                  Generate proof-of-ownership certificates showing continuous custody of your Bitcoin through address changes and transactions. Export evidence bundles for compliance or audits.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ContinuityCertificateReport />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
