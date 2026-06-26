import { Switch, Route, Router, useLocation } from "wouter";
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
import Nudgie from "@/pages/Nudgie";
import BitcoinFlowVisualizer from "@/pages/BitcoinFlowVisualizer";
import BulkEditor from "@/pages/BulkEditor";
import QuickTagger from "@/pages/QuickTagger";
import { lazy, Suspense, useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { detectOrphanedTxRecords } from "@/lib/txid-backfill";
import { ActivityBusProvider } from "@/lib/activity-bus";
import { ActivityPulseDot } from "@/components/ActivityPulseDot";
import { EngineBootstrapper, EnginePreparingIndicator } from "@/components/EngineMaintenanceUI";

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
import DatabaseDoctor from "@/pages/DatabaseDoctor";
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
      <Route path="/database-doctor" component={DatabaseDoctor} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Once per browser session, silently scan for transaction records that are
// missing their on-chain data ("orphaned" txids) and, if any are found, show a
// non-intrusive toast that lets the user jump to Settings and rebuild them.
function OrphanedTxNotifier() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  useEffect(() => {
    const SESSION_KEY = "kyutxo:orphanCheckDone";
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, "1");

    let cancelled = false;
    (async () => {
      try {
        const { getSettings } = await import("@/lib/data/settings-crud");
        const settings = await getSettings("default");
        if (cancelled || settings?.disableOrphanCheck) return;

        const { txids } = await detectOrphanedTxRecords();
        if (cancelled || txids.length === 0) return;

        // Rebuilding missing transaction data requires a connected blockchain
        // provider. If none is configured, an auto-triggered backfill would
        // immediately defer with a "no node configured" message — a dead end.
        // Detect that case up front and guide the user to configure a provider
        // first instead of kicking off a backfill that can only defer.
        const { getNodeSettings } = await import("@/lib/data/node-settings-crud");
        const nodeSettings = await getNodeSettings("default");
        if (cancelled) return;
        const hasNode = !!nodeSettings;

        const count = txids.length;
        const plural = count !== 1;

        if (!hasNode) {
          toast({
            title: "Missing transaction data",
            description: `${count.toLocaleString()} transaction${plural ? "s" : ""} ${plural ? "are" : "is"} missing on-chain data. Configure a blockchain provider in Settings to rebuild ${plural ? "them" : "it"}.`,
            duration: 15000,
            action: (
              <ToastAction
                altText="Open Settings to configure a blockchain provider"
                onClick={() => {
                  setLocation("/settings");
                }}
                data-testid="button-configure-provider"
              >
                Configure
              </ToastAction>
            ),
          });
          return;
        }

        toast({
          title: "Missing transaction data",
          description: `${count.toLocaleString()} transaction${plural ? "s" : ""} ${plural ? "are" : "is"} missing on-chain data. Rebuild ${plural ? "them" : "it"} from Settings.`,
          duration: 15000,
          action: (
            <ToastAction
              altText="Open Settings to rebuild missing transactions"
              onClick={() => {
                sessionStorage.setItem("kyutxo:autoBackfill", "1");
                setLocation("/settings");
              }}
              data-testid="button-rebuild-missing-transactions"
            >
              Fix now
            </ToastAction>
          ),
        });
      } catch {
        // Silent: detection failures must never disrupt app startup.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [toast, setLocation]);

  return null;
}

// Loads any persisted offline entity-list snapshot into the active Privacy
// Audit list once at startup. Falls back silently to the bundled list.
function EntityListLoader() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { loadEntitySnapshotFromStorage } = await import("@/lib/data/entity-list-store");
        if (!cancelled) await loadEntitySnapshotFromStorage();
      } catch {
        // Silent: loading the snapshot must never disrupt app startup.
      }
    })();
    return () => {
      cancelled = true;
    };
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
