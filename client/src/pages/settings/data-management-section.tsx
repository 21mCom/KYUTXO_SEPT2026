import { RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { MaintenanceToolsSection } from "./maintenance-tools-section";
import { RestoreBackupFlow } from "./restore-backup-flow";
import { ClearDatabaseFlow } from "./clear-database-flow";

// Thin composition root for the Data Management card. Each flow lives in its
// own file so future changes stay reviewable:
//  - maintenance-tools-section.tsx: recompute stats, rebuild missing
//    transactions, startup missing-data reminder, resolve input addresses
//  - restore-backup-flow.tsx: two-stage restore (v3 streaming + legacy JSON)
//  - clear-database-flow.tsx: password + phrase confirmed full wipe
export function DataManagementSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5" />
          Data Management
        </CardTitle>
        <CardDescription>
          Clear or restore your database
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MaintenanceToolsSection />

        <Separator />

        <RestoreBackupFlow />

        <Separator />

        <ClearDatabaseFlow />
      </CardContent>
    </Card>
  );
}
