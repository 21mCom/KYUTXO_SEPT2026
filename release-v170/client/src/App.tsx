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
import {
  Component,
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useDeferredValue,
  useRef,
  useState,
  useEffect,
  type ComponentType,
  type ReactNode,
} from "react";
import { OrphanedTxNotifier } from "@/components/OrphanedTxNotifier";
import { ActivityBusProvider } from "@/lib/activity-bus";
import { ActivityPulseDot } from "@/components/ActivityPulseDot";
import { EngineBootstrapper, EnginePreparingIndicator } from "@/components/EngineMaintenanceUI";
import { GlobalCommandPalette } from "@/components/GlobalCommandPalette";
import { NetworkPrivacyControl } from "@/components/NetworkPrivacyControl";
import { NetworkPrivacyOnboarding } from "@/components/NetworkPrivacyOnboarding";
import { useNodeSettings } from "@/hooks/use-node-settings";

type RouteLoadErrorBoundaryProps = {
  children: ReactNode;
  onRetry: () => void;
  suppressFallback?: boolean;
};

type RouteLoadErrorBoundaryState = {
  error: Error | null;
};

class RouteLoadErrorBoundary extends Component<
  RouteLoadErrorBoundaryProps,
  RouteLoadErrorBoundaryState
> {
  state: RouteLoadErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RouteLoadErrorBoundaryState {
    return { error };
  }

  private retry = () => {
    this.setState({ error: null });
    this.props.onRetry();
  };

  render() {
    if (this.state.error) {
      if (this.props.suppressFallback) return null;
      return (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
          role="alert"
          data-testid="route-load-error"
        >
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">This page couldn't be loaded</h2>
            <p className="text-sm text-muted-foreground">
              The page download failed. Check your connection and try again.
            </p>
          </div>
          <Button onClick={this.retry} data-testid="button-retry-route">
            Try again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

type RouteNavigationState = {
  pendingPath: string | null;
  retryGeneration: number;
  reportFailure: (path: string) => void;
};

const RouteNavigationContext = createContext<RouteNavigationState>({
  pendingPath: null,
  retryGeneration: 0,
  reportFailure: () => undefined,
});

function RetryableRouteBoundary({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry: () => void;
}) {
  const { pendingPath } = useContext(RouteNavigationContext);
  return (
    <RouteLoadErrorBoundary
      onRetry={onRetry}
      suppressFallback={Boolean(pendingPath)}
    >
      {children}
    </RouteLoadErrorBoundary>
  );
}

export function retryableLazy(
  importer: () => Promise<{ default: ComponentType<Record<string, never>> }>,
) {
  type LazyRouteEntry = {
    component: ReturnType<typeof lazy>;
    status: "pending" | "failed" | "successful";
  };
  const lazyRoutes = new Map<string, LazyRouteEntry>();

  return function RetryableLazyRoute() {
    const { pendingPath, retryGeneration, reportFailure } = useContext(RouteNavigationContext);
    const [attempt, setAttempt] = useState(0);
    const navigationKey = useRef(
      pendingPath ? `navigation:${pendingPath}:${retryGeneration}` : null,
    );
    const routeKey = navigationKey.current ?? `standalone:${attempt}`;
    let routeEntry = lazyRoutes.get(routeKey);
    if (!routeEntry) {
      const failedPath = pendingPath;
      routeEntry = {
        status: "pending",
        component: lazy(() => importer().then(
          (module) => {
            if (routeEntry) routeEntry.status = "successful";
            return module;
          },
          (error) => {
            if (routeEntry) routeEntry.status = "failed";
            if (failedPath) reportFailure(failedPath);
            throw error;
          },
        )),
      };
      lazyRoutes.set(routeKey, routeEntry);
    }
    const activeEntry = routeEntry;
    const LazyRoute = activeEntry.component;

    useEffect(() => () => {
      if (activeEntry.status === "failed" && lazyRoutes.get(routeKey) === activeEntry) {
        lazyRoutes.delete(routeKey);
      }
    }, [activeEntry, routeKey]);

    const retry = () => {
      if (activeEntry.status === "failed" && lazyRoutes.get(routeKey) === activeEntry) {
        lazyRoutes.delete(routeKey);
      }
      setAttempt((value) => value + 1);
    };

    return (
      <RetryableRouteBoundary
        key={attempt}
        onRetry={retry}
      >
        <LazyRoute />
      </RetryableRouteBoundary>
    );
  };
}

const UIAssets = retryableLazy(() => import("@/pages/UIAssets"));
const IconsReference = retryableLazy(() => import("@/pages/IconsReference"));
const NavigationPatterns = retryableLazy(() => import("@/pages/NavigationPatterns"));
const GroupedSidebarPreview = retryableLazy(() => import("@/pages/GroupedSidebarPreview"));
const FlowVisualizations = retryableLazy(() => import("@/pages/FlowVisualizations"));
const DevTestData = retryableLazy(() => import("@/pages/DevTestData"));
import { ScheduledBackupRunner } from "@/components/ScheduledBackupRunner";

const Dashboard = retryableLazy(() => import("@/pages/Dashboard"));
const ValueUpdaterPage = retryableLazy(() => import("@/pages/ValueUpdaterPage"));
const BulkImport = retryableLazy(() => import("@/pages/BulkImport"));
const WalletImport = retryableLazy(() => import("@/pages/WalletImport"));
const MobileWalletImport = retryableLazy(() => import("@/pages/MobileWalletImport"));
const DescriptorImport = retryableLazy(() => import("@/pages/DescriptorImport"));
const BIP329Import = retryableLazy(() => import("@/pages/BIP329Import"));
const PriceImport = retryableLazy(() => import("@/pages/PriceImport"));
const TransactionSync = retryableLazy(() => import("@/pages/TransactionSync"));
const Transactions = retryableLazy(() => import("@/pages/Transactions"));
const TransactionInbox = retryableLazy(() => import("@/pages/TransactionInbox"));
const ResolveOwnership = retryableLazy(() => import("@/pages/ResolveOwnership"));
const UTXOs = retryableLazy(() => import("@/pages/UTXOs"));
const UtxoProvenance = retryableLazy(() => import("@/pages/UtxoProvenance"));
const CoinOrigins = retryableLazy(() => import("@/pages/CoinOrigins"));
const Nudgie = retryableLazy(() => import("@/pages/Nudgie"));
const LightningSpeculator = retryableLazy(() => import("@/pages/LightningSpeculator"));
const Provenance = retryableLazy(() => import("@/pages/Provenance"));
const AddressReuse = retryableLazy(() => import("@/pages/AddressReuse"));
const DataStats = retryableLazy(() => import("@/pages/DataStats"));
const Records = retryableLazy(() => import("@/pages/Records"));
const QRScanner = retryableLazy(() => import("@/pages/QRScanner"));
const ExportPage = retryableLazy(() => import("@/pages/ExportPage"));
const SettingsPage = retryableLazy(() => import("@/pages/SettingsPage"));
const NodeSettings = retryableLazy(() => import("@/pages/NodeSettings"));
const Reports = retryableLazy(() => import("@/pages/Reports"));
const BitcoinFlowVisualizer = retryableLazy(() => import("@/pages/BitcoinFlowVisualizer"));
const BulkEditor = retryableLazy(() => import("@/pages/BulkEditor"));
const QuickTagger = retryableLazy(() => import("@/pages/QuickTagger"));
const ConflictResolution = retryableLazy(() => import("@/pages/ConflictResolution"));
const EvidencePage = retryableLazy(() => import("@/pages/Evidence"));
const VaultManagement = retryableLazy(() => import("@/pages/VaultManagement"));
const WalletOverview = retryableLazy(() => import("@/pages/WalletOverview"));
const Cleanup = retryableLazy(() => import("@/pages/Cleanup"));
const StatementReport = retryableLazy(() => import("@/pages/StatementReport"));
const QuantumRiskScanner = retryableLazy(() => import("@/pages/QuantumRiskScanner"));
const PrivacyAudit = retryableLazy(() => import("@/pages/PrivacyAudit"));
const BalanceOverview = retryableLazy(() => import("@/pages/BalanceOverview"));
const NetworkAnalysis = retryableLazy(() => import("@/pages/NetworkAnalysis"));
const FundTrail = retryableLazy(() => import("@/pages/FundTrail"));
const EngineDiagnostics = retryableLazy(() => import("@/pages/EngineDiagnostics"));
const DatabaseDoctor = retryableLazy(() => import("@/pages/DatabaseDoctor"));
const VaultHealth = retryableLazy(() => import("@/pages/VaultHealth"));
const AnnualActivityReport = retryableLazy(() => import("@/pages/AnnualActivityReport"));
const AddressChecker = retryableLazy(() => import("@/pages/AddressChecker"));
const AddressDeriver = retryableLazy(() => import("@/pages/AddressDeriver"));
const ProofOfFundsDeclaration = retryableLazy(() => import("@/pages/ProofOfFundsDeclaration"));
const DustedPage = retryableLazy(() => import("@/pages/DustedPage"));
const AddressPoisoning = retryableLazy(() => import("@/pages/AddressPoisoning"));
const DormantCoins = retryableLazy(() => import("@/pages/DormantCoins"));
const NotFound = retryableLazy(() => import("@/pages/not-found"));

function RouteCommitReporter({ onCommit }: { onCommit: (path: string) => void }) {
  const [location] = useLocation();
  useEffect(() => {
    onCommit(location);
  }, [location, onCommit]);
  return null;
}

function AppRoutes({ onRouteCommit }: { onRouteCommit: (path: string) => void }) {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground" data-testid="route-loading">Loading page…</div>}>
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
      <Route path="/transaction-inbox" component={TransactionInbox} />
      <Route path="/resolve-ownership" component={ResolveOwnership} />
      <Route path="/utxos" component={UTXOs} />
      <Route path="/utxo-provenance" component={UtxoProvenance} />
      <Route path="/coin-origins" component={CoinOrigins} />
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
      <RouteCommitReporter onCommit={onRouteCommit} />
    </Suspense>
  );
}

function DeferredBackgroundServices({ enabled }: { enabled: boolean }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const windowWithIdle = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (windowWithIdle.requestIdleCallback) {
      const handle = windowWithIdle.requestIdleCallback(() => setReady(true), { timeout: 1500 });
      return () => windowWithIdle.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(() => setReady(true), 250);
    return () => window.clearTimeout(handle);
  }, [enabled]);

  if (!ready) return null;
  return (
    <>
      <EngineBootstrapper />
      <ScheduledBackupRunner />
      <OrphanedTxNotifier />
      <EntityListLoader />
      <SyncStatsBackfill />
    </>
  );
}

export function RouteNavigationContent({
  location,
  navigate,
  onInitialCommit,
  renderRoutes,
}: {
  location: string;
  navigate: (path: string) => void;
  onInitialCommit?: () => void;
  renderRoutes?: (onCommit: (path: string) => void) => ReactNode;
}) {
  const displayedLocation = useDeferredValue(location);
  const [committedPath, setCommittedPath] = useState(location);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const initialCommitReported = useRef(false);
  const pendingPathRef = useRef<string | null>(null);
  const committedPathRef = useRef(committedPath);
  const navigateRef = useRef(navigate);
  const markRouteCommitted = useCallback((path: string) => {
    setCommittedPath(path);
    setFailedPath(null);
    if (!initialCommitReported.current) {
      initialCommitReported.current = true;
      onInitialCommit?.();
    }
  }, [onInitialCommit]);
  const pendingPath = committedPath === location ? null : location;
  pendingPathRef.current = pendingPath;
  committedPathRef.current = committedPath;
  navigateRef.current = navigate;
  const reportFailure = useCallback((path: string) => {
    if (path !== pendingPathRef.current) return;
    setFailedPath(path);
    navigateRef.current(committedPathRef.current);
  }, []);
  const retryFailedNavigation = useCallback(() => {
    if (!failedPath) return;
    const target = failedPath;
    setRetryGeneration((value) => value + 1);
    setFailedPath(null);
    navigate(target);
  }, [failedPath, navigate]);

  return (
    <main className="relative flex-1 flex flex-col overflow-hidden">
      <RouteNavigationContext.Provider value={{ pendingPath, retryGeneration, reportFailure }}>
        <Router hook={() => [displayedLocation, navigate]}>
          {renderRoutes ? renderRoutes(markRouteCommitted) : <AppRoutes onRouteCommit={markRouteCommitted} />}
        </Router>
      </RouteNavigationContext.Provider>
      {pendingPath && (
        <div
          className="absolute right-4 top-4 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-sm"
          role="status"
          data-testid="route-navigation-loading"
        >
          Loading selected page…
        </div>
      )}
      {failedPath && (
        <div
          className="absolute right-4 top-4 max-w-sm rounded-md border border-destructive/40 bg-background p-4 shadow-lg"
          role="alert"
          data-testid="route-navigation-error"
        >
          <p className="font-medium">The selected page couldn't be downloaded</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your current page is still available. Check your connection and try again.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={retryFailedNavigation} data-testid="button-retry-navigation">
              Try again
            </Button>
            <Button size="sm" variant="outline" onClick={() => setFailedPath(null)}>
              Stay on this page
            </Button>
          </div>
        </div>
      )}
    </main>
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

function AuthenticatedAppContent() {
  const { logout } = useAuth();
  const [location, navigate] = useLocation();
  const [initialRouteCommitted, setInitialRouteCommitted] = useState(false);
  const markInitialRouteCommitted = useCallback(() => setInitialRouteCommitted(true), []);
  
  const style = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
      <RecordPreviewProvider>
        <SidebarProvider style={style as React.CSSProperties}>
          <DeferredBackgroundServices enabled={initialRouteCommitted} />
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
                  <NetworkPrivacyControl />
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
              <RouteNavigationContent
                location={location}
                navigate={navigate}
                onInitialCommit={markInitialRouteCommitted}
              />
            </div>
          </div>
        </SidebarProvider>
      </RecordPreviewProvider>
  );
}

function AuthenticatedApp() {
  return (
    <Router hook={useAdaptiveLocation}>
      <AuthenticatedAppContent />
    </Router>
  );
}

function AuthenticatedGate() {
  const { nodeSettings, isLoading } = useNodeSettings();
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (
    nodeSettings.networkOnboardingStage === 'source' ||
    nodeSettings.networkOnboardingStage === 'import'
  ) {
    return <NetworkPrivacyOnboarding />;
  }
  return <AuthenticatedApp />;
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
    protectedRepository,
    protectedRepositoryError,
  } = useAuth();

  // Release Electron is fail-closed. In particular, do not show the setup
  // screen after a protected-store failure: that would tempt callers into
  // creating/using the legacy plaintext IndexedDB vault.
  if (protectedRepository === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="text-center max-w-md space-y-3" data-testid="protected-repository-error">
          <div className="text-xl font-semibold text-foreground">Protected vault unavailable</div>
          <p className="text-muted-foreground">
            {protectedRepositoryError ?? 'The protected vault could not be verified. Your vault was not opened.'}
          </p>
        </div>
      </div>
    );
  }

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
  if (isInitialized === null || protectedRepository === 'checking' || (isLoading && isAuthenticated)) {
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

  // This duplicates the AuthContext post-unlock check intentionally: future
  // auth changes cannot accidentally mount authenticated data consumers before
  // the packaged repository reaches its verified ready state.
  if (protectedRepository !== 'fallback' && protectedRepository !== 'ready') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" data-testid="protected-repository-gate">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="mt-4 text-muted-foreground">Verifying protected vault...</p>
        </div>
      </div>
    );
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
        <AuthenticatedGate />
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
