import { Switch, Route, Router } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";
import { LoginScreen } from "@/components/LoginScreen";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { useAdaptiveLocation } from "@/lib/hashLocation";
import Dashboard from "@/pages/Dashboard";
import ValueUpdaterPage from "@/pages/ValueUpdaterPage";
import BulkImport from "@/pages/BulkImport";
import WalletImport from "@/pages/WalletImport";
import MobileWalletImport from "@/pages/MobileWalletImport";
import DescriptorImport from "@/pages/DescriptorImport";
import BIP329Import from "@/pages/BIP329Import";
import PriceImport from "@/pages/PriceImport";
import TransactionSync from "@/pages/TransactionSync";
import Transactions from "@/pages/Transactions";
import Provenance from "@/pages/Provenance";
import AddressReuse from "@/pages/AddressReuse";
import DataStats from "@/pages/DataStats";
import Records from "@/pages/Records";
import QRScanner from "@/pages/QRScanner";
import ExportPage from "@/pages/ExportPage";
import SettingsPage from "@/pages/SettingsPage";
import NodeSettings from "@/pages/NodeSettings";
import Reports from "@/pages/Reports";
import LightningSpeculator from "@/pages/LightningSpeculator";
import UTXOs from "@/pages/UTXOs";
import Nudgie from "@/pages/Nudgie";
import BitcoinFlowVisualizer from "@/pages/BitcoinFlowVisualizer";
import BulkEditor from "@/pages/BulkEditor";
import QuickTagger from "@/pages/QuickTagger";
import { lazy, Suspense, useState, useEffect } from "react";
import { ActivityBusProvider } from "@/lib/activity-bus";
import { ActivityPulseDot } from "@/components/ActivityPulseDot";

const UIAssets = lazy(() => import("@/pages/UIAssets"));
const IconsReference = lazy(() => import("@/pages/IconsReference"));
const NavigationPatterns = lazy(() => import("@/pages/NavigationPatterns"));
const GroupedSidebarPreview = lazy(() => import("@/pages/GroupedSidebarPreview"));
const FlowVisualizations = lazy(() => import("@/pages/FlowVisualizations"));
const DevTestData = lazy(() => import("@/pages/DevTestData"));
import ConflictResolution from "@/pages/ConflictResolution";
import EvidencePage from "@/pages/Evidence";
import VaultManagement from "@/pages/VaultManagement";
import WalletOverview from "@/pages/WalletOverview";
import Cleanup from "@/pages/Cleanup";
import StatementReport from "@/pages/StatementReport";
import QuantumRiskScanner from "@/pages/QuantumRiskScanner";
import PrivacyAudit from "@/pages/PrivacyAudit";
import BalanceOverview from "@/pages/BalanceOverview";
import NetworkAnalysis from "@/pages/NetworkAnalysis";
import EngineDiagnostics from "@/pages/EngineDiagnostics";
import NotFound from "@/pages/not-found";

function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/value-updater" component={ValueUpdaterPage} />
      <Route path="/import" component={BulkImport} />
      <Route path="/wallet-import" component={WalletImport} />
      <Route path="/mobile-wallet-import" component={MobileWalletImport} />
      <Route path="/descriptor-import" component={DescriptorImport} />
      <Route path="/bip329-import" component={BIP329Import} />
      <Route path="/price-import" component={PriceImport} />
      <Route path="/transaction-sync" component={TransactionSync} />
      <Route path="/transactions" component={Transactions} />
      <Route path="/utxos" component={UTXOs} />
      <Route path="/nudgie" component={Nudgie} />
      <Route path="/lightning-speculator" component={LightningSpeculator} />
      <Route path="/provenance" component={Provenance} />
      <Route path="/address-reuse" component={AddressReuse} />
      <Route path="/data-stats" component={DataStats} />
      <Route path="/records" component={Records} />
      <Route path="/scanner" component={QRScanner} />
      <Route path="/export" component={ExportPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/node-settings" component={NodeSettings} />
      <Route path="/reports" component={Reports} />
      {import.meta.env.DEV && (
        <>
          <Route path="/dev/ui-assets">{() => <Suspense fallback={<div />}><UIAssets /></Suspense>}</Route>
          <Route path="/dev/icons">{() => <Suspense fallback={<div />}><IconsReference /></Suspense>}</Route>
          <Route path="/dev/nav-patterns">{() => <Suspense fallback={<div />}><NavigationPatterns /></Suspense>}</Route>
          <Route path="/dev/grouped-sidebar">{() => <Suspense fallback={<div />}><GroupedSidebarPreview /></Suspense>}</Route>
          <Route path="/dev/flow-viz">{() => <Suspense fallback={<div />}><FlowVisualizations /></Suspense>}</Route>
          <Route path="/dev/test-data">{() => <Suspense fallback={<div />}><DevTestData /></Suspense>}</Route>
        </>
      )}
      <Route path="/flow-visualizer" component={BitcoinFlowVisualizer} />
      <Route path="/bulk-editor" component={BulkEditor} />
      <Route path="/quick-tagger" component={QuickTagger} />
      <Route path="/conflict-resolution" component={ConflictResolution} />
      <Route path="/evidence" component={EvidencePage} />
      <Route path="/vaults" component={VaultManagement} />
      <Route path="/wallet-overview" component={WalletOverview} />
      <Route path="/cleanup" component={Cleanup} />
      <Route path="/statement" component={StatementReport} />
      <Route path="/quantum-risk" component={QuantumRiskScanner} />
      <Route path="/privacy-audit" component={PrivacyAudit} />
      <Route path="/balance" component={BalanceOverview} />
      <Route path="/network-analysis" component={NetworkAnalysis} />
      <Route path="/engine-diagnostics" component={EngineDiagnostics} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  const { logout } = useAuth();
  
  const style = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <Router hook={useAdaptiveLocation}>
      <RecordPreviewProvider>
        <SidebarProvider style={style as React.CSSProperties}>
          <div className="flex h-screen w-full">
            <AppSidebar />
            <div className="flex flex-col flex-1 overflow-hidden">
              <header className="flex items-center justify-between p-4 border-b gap-2 relative">
                <div className="relative">
                  <SidebarTrigger data-testid="button-sidebar-toggle" />
                  <ActivityPulseDot />
                </div>
                <div className="flex items-center gap-2">
                  <KeyboardShortcutsDialog />
                  <ThemeToggle />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={logout}
                    title="Lock Vault"
                    data-testid="button-logout"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              </header>
              <main className="flex-1 flex flex-col overflow-hidden">
                <AppRoutes />
              </main>
            </div>
          </div>
        </SidebarProvider>
      </RecordPreviewProvider>
    </Router>
  );
}

function LegacyMigrationOverlay() {
  const { legacyMigrationProgress, legacyMigrationResult, fileDecryptProgress } = useAuth();
  const [dismissedMigrationResult, setDismissedMigrationResult] = useState(false);

  if (dismissedMigrationResult) {
    return null;
  }

  if (!legacyMigrationProgress && !legacyMigrationResult && !fileDecryptProgress) {
    return null;
  }

  if (fileDecryptProgress) {
    const hasFileTotal = fileDecryptProgress.total > 0;
    const filePct = hasFileTotal
      ? Math.round((fileDecryptProgress.current / fileDecryptProgress.total) * 100)
      : 0;

    return (
      <div className="fixed inset-0 z-[9999] bg-background/95 flex items-center justify-center" data-testid="file-decrypt-overlay">
        <div className="text-center max-w-md space-y-4 p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <div className="text-2xl font-semibold text-foreground">Decrypting Attachment Files</div>
          <p className="text-muted-foreground">
            Restoring encrypted files to their original format.
          </p>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className={`bg-primary h-2 rounded-full transition-all duration-200 ${hasFileTotal ? '' : 'w-full animate-pulse'}`}
              style={hasFileTotal ? { width: `${filePct}%` } : undefined}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {hasFileTotal
              ? `${fileDecryptProgress.current} / ${fileDecryptProgress.total} files (${filePct}%)`
              : (fileDecryptProgress.phase || 'Preparing')}
          </p>
          {fileDecryptProgress.decrypted > 0 && (
            <p className="text-xs text-muted-foreground">
              {fileDecryptProgress.decrypted} decrypted, {fileDecryptProgress.skipped} already plain
              {fileDecryptProgress.failed > 0 && `, ${fileDecryptProgress.failed} failed`}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Please do not close the application.
          </p>
        </div>
      </div>
    );
  }

  if (legacyMigrationResult) {
    return (
      <div className="fixed inset-0 z-[9999] bg-background/95 flex items-center justify-center" data-testid="legacy-migration-overlay">
        <div className="text-center max-w-md space-y-4 p-6">
          <div className="text-2xl font-semibold text-foreground">Data Migration Complete</div>
          {legacyMigrationResult.unexpectedError ? (
            <p className="text-destructive">
              Migration encountered an unexpected error. Your data is safe — it will be retried on your next login.
            </p>
          ) : (
            <>
              {legacyMigrationResult.totalDecrypted > 0 && (
                <p className="text-muted-foreground">
                  Successfully restored {legacyMigrationResult.totalDecrypted} records.
                </p>
              )}
              {legacyMigrationResult.totalFailed > 0 && (
                <p className="text-destructive">
                  {legacyMigrationResult.totalFailed} records could not be decrypted and were left unchanged.
                  They will be retried on your next login.
                </p>
              )}
              {legacyMigrationResult.totalFailed === 0 && legacyMigrationResult.totalDecrypted > 0 && (
                <p className="text-muted-foreground">
                  All records were successfully migrated.
                </p>
              )}
            </>
          )}
          <button
            onClick={() => setDismissedMigrationResult(true)}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md"
            data-testid="button-dismiss-migration"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  const progress = legacyMigrationProgress!;
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[9999] bg-background/95 flex items-center justify-center" data-testid="legacy-migration-overlay">
      <div className="text-center max-w-md space-y-4 p-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
        <div className="text-2xl font-semibold text-foreground">Migrating Encrypted Data</div>
        {progress.tableIndex > 0 && progress.tableName === 'Preparing' && (
          <p className="text-sm text-muted-foreground">
            Resuming from previous session ({progress.tableIndex} of {progress.tableCount} tables already done)
          </p>
        )}
        <p className="text-muted-foreground">
          Restoring plaintext for: {progress.tableName}
        </p>
        <div className="w-full bg-muted rounded-full h-2">
          <div
            className={`bg-primary h-2 rounded-full transition-all duration-200 ${progress.total > 0 ? '' : 'w-full animate-pulse'}`}
            style={progress.total > 0 ? { width: `${pct}%` } : undefined}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {progress.total > 0
            ? `${progress.current} / ${progress.total} records (${pct}%)`
            : `${progress.current} records processed`}
          {progress.failed > 0 && ` — ${progress.failed} failed`}
        </p>
        <p className="text-xs text-muted-foreground">
          Table {progress.tableIndex + 1} of {progress.tableCount}
        </p>
        <p className="text-xs text-muted-foreground">
          Please do not close the application.
        </p>
      </div>
    </div>
  );
}

function AppContent() {
  const {
    isAuthenticated,
    isInitialized,
    isLoading,
    isMigrating,
    legacyMigrationProgress,
    fileDecryptProgress,
  } = useAuth();

  if (isInitialized === null || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="mt-4 text-muted-foreground">Loading vault...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // While startup migrations are running, do not mount the authenticated app.
  // Its data queries (Dashboard, Records) would otherwise compete with the
  // migration for IndexedDB transactions and fail. The overlay covers the
  // screen when progress is available; the fallback below covers the brief
  // window before the first progress event is emitted.
  const migrationActive =
    isMigrating || legacyMigrationProgress !== null || fileDecryptProgress !== null;

  return (
    <>
      <LegacyMigrationOverlay />
      {migrationActive ? (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
            <p className="mt-4 text-muted-foreground">Preparing your vault...</p>
          </div>
        </div>
      ) : (
        <AuthenticatedApp />
      )}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActivityBusProvider>
          <AuthProvider>
            <AppContent />
            <Toaster />
          </AuthProvider>
        </ActivityBusProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
