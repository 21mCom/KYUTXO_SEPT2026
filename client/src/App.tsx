import { Switch, Route, Router, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";
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
import { LegacyMigrationOverlay } from "@/components/LegacyMigrationOverlay";
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
import UtxoProvenance from "@/pages/UtxoProvenance";
import Nudgie from "@/pages/Nudgie";
import BitcoinFlowVisualizer from "@/pages/BitcoinFlowVisualizer";
import BulkEditor from "@/pages/BulkEditor";
import QuickTagger from "@/pages/QuickTagger";
import { lazy, Suspense, useState, useEffect } from "react";
import { OrphanedTxNotifier } from "@/components/OrphanedTxNotifier";
import { ActivityBusProvider } from "@/lib/activity-bus";
import { ActivityPulseDot } from "@/components/ActivityPulseDot";
import { EngineBootstrapper, EnginePreparingIndicator } from "@/components/EngineMaintenanceUI";
import { GlobalCommandPalette } from "@/components/GlobalCommandPalette";

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
import FundTrail from "@/pages/FundTrail";
import EngineDiagnostics from "@/pages/EngineDiagnostics";
import DatabaseDoctor from "@/pages/DatabaseDoctor";
import VaultHealth from "@/pages/VaultHealth";
import AnnualActivityReport from "@/pages/AnnualActivityReport";
import AddressChecker from "@/pages/AddressChecker";
import AddressDeriver from "@/pages/AddressDeriver";
import ProofOfFundsDeclaration from "@/pages/ProofOfFundsDeclaration";
import DustedPage from "@/pages/DustedPage";
import AddressPoisoning from "@/pages/AddressPoisoning";
import DormantCoins from "@/pages/DormantCoins";
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
      <Route path="/utxo-provenance" component={UtxoProvenance} />
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
      <Route path="/fund-trail" component={FundTrail} />
      <Route path="/engine-diagnostics" component={EngineDiagnostics} />
      <Route path="/database-doctor" component={DatabaseDoctor} />
      <Route path="/vault-health" component={VaultHealth} />
      <Route path="/annual-activity" component={AnnualActivityReport} />
      <Route path="/address-checker" component={AddressChecker} />
      <Route path="/address-deriver" component={AddressDeriver} />
      <Route path="/proof-of-funds" component={ProofOfFundsDeclaration} />
      <Route path="/dusted" component={DustedPage} />
      <Route path="/address-poisoning" component={AddressPoisoning} />
      <Route path="/dormant-coins" component={DormantCoins} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Loads any persisted offline entity-list snapshot into the active Privacy
// Audit list once at startup. Falls back silently to the bundled list. Shows
// a non-blocking warning toast when the snapshot was partially invalid and
// some entries were skipped (valid entries are still kept).
function EntityListLoader() {
  const { toast } = useToast();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { loadEntitySnapshotFromStorage } = await import("@/lib/data/entity-list-store");
        if (!cancelled) {
          const status = await loadEntitySnapshotFromStorage();
          if (!cancelled && status.partialWarning) {
            const { validCount, skippedCount } = status.partialWarning;
            toast({
              title: "Entity list: some entries skipped",
              description:
                `${skippedCount} invalid entr${skippedCount === 1 ? "y was" : "ies were"} ` +
                `skipped; ${validCount} valid entr${validCount === 1 ? "y was" : "ies were"} kept. ` +
                "Visit Settings › Privacy Audit Entity List to review or re-import.",
              variant: "destructive",
            });
          }
        }
      } catch {
        // Silent: loading the snapshot must never disrupt app startup.
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// Runs once at startup to self-heal addresses that completed a sync before the
// fix that widened the post-run stats recompute set. Those addresses have an
// addressSyncState entry but no statsComputedAt, so Records shows "Not Synced"
// even though they were genuinely synced. The backfill is lightweight (touches
// only the stuck subset), runs in the background, and never blocks the UI.
function SyncStatsBackfill() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { backfillMissingSyncStats } = await import("@/lib/data/address-stats");
        if (!cancelled) {
          await backfillMissingSyncStats();
        }
      } catch {
        // Silent: backfill must never disrupt app startup.
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
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
          <EngineBootstrapper />
          <OrphanedTxNotifier />
          <EntityListLoader />
          <SyncStatsBackfill />
          <GlobalCommandPalette />
          <div className="flex h-screen w-full">
            <AppSidebar />
            <div className="flex flex-col flex-1 overflow-hidden">
              <header className="flex items-center justify-between p-4 border-b gap-2 relative">
                <div className="relative">
                  <SidebarTrigger data-testid="button-sidebar-toggle" />
                  <ActivityPulseDot />
                </div>
                <div className="flex items-center gap-2">
                  <EnginePreparingIndicator />
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

function AppContent() {
  const {
    isAuthenticated,
    isInitialized,
    isLoading,
    isMigrating,
    dbUpgrade,
    migrationPhase,
    legacyMigrationProgress,
    fileDecryptProgress,
  } = useAuth();

  // One-time schema upgrade of an older on-disk vault. This runs BEFORE login
  // and can take minutes on a large vault (index rebuilds + table walks), so
  // it must never hide behind the generic "Loading vault..." spinner — that
  // reads as a hang and a force-quit aborts the upgrade transaction.
  if (dbUpgrade) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-background"
        data-testid="db-upgrade-overlay"
      >
        <div className="text-center max-w-md space-y-4 p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <div className="text-2xl font-semibold text-foreground">Upgrading Your Vault</div>
          <p className="text-muted-foreground">
            One-time database upgrade after updating the app. On large vaults this can take
            several minutes.
          </p>
          <div className="w-full bg-muted rounded-full h-2">
            <div className="bg-primary h-2 rounded-full w-full animate-pulse" />
          </div>
          <p className="text-sm text-muted-foreground" data-testid="text-db-upgrade-step">
            {dbUpgrade.step}
            {dbUpgrade.rowsProcessed > 0 && ` — ${dbUpgrade.rowsProcessed.toLocaleString()} rows`}
          </p>
          <p className="text-xs text-muted-foreground">
            Please do not close the application — closing now restarts the upgrade.
          </p>
        </div>
      </div>
    );
  }

  // NOTE: while unauthenticated but initialized, a login attempt toggles the
  // global isLoading flag — LoginScreen must STAY MOUNTED through it (it shows
  // its own "Please wait..." state). Unmounting it here wipes its local error
  // state, so a wrong password would fail silently with no "Incorrect
  // password" message (packaged-app bug). Only gate on isLoading before the
  // vault status is known or after authentication succeeds.
  if (isInitialized === null || (isLoading && isAuthenticated)) {
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
            <p className="mt-4 text-muted-foreground" data-testid="text-migration-phase">
              {migrationPhase ?? 'Preparing your vault...'}
            </p>
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
