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
import UIAssets from "@/pages/UIAssets";
import IconsReference from "@/pages/IconsReference";
import NavigationPatterns from "@/pages/NavigationPatterns";
import GroupedSidebarPreview from "@/pages/GroupedSidebarPreview";
import FlowVisualizations from "@/pages/FlowVisualizations";
import BitcoinFlowVisualizer from "@/pages/BitcoinFlowVisualizer";
import BulkEditor from "@/pages/BulkEditor";
import QuickTagger from "@/pages/QuickTagger";
import DevTestData from "@/pages/DevTestData";
import ConflictResolution from "@/pages/ConflictResolution";
import EvidencePage from "@/pages/Evidence";
import VaultManagement from "@/pages/VaultManagement";
import Cleanup from "@/pages/Cleanup";
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
      <Route path="/dev/ui-assets" component={UIAssets} />
      <Route path="/dev/icons" component={IconsReference} />
      <Route path="/dev/nav-patterns" component={NavigationPatterns} />
      <Route path="/dev/grouped-sidebar" component={GroupedSidebarPreview} />
      <Route path="/dev/flow-viz" component={FlowVisualizations} />
      <Route path="/dev/test-data" component={DevTestData} />
      <Route path="/flow-visualizer" component={BitcoinFlowVisualizer} />
      <Route path="/bulk-editor" component={BulkEditor} />
      <Route path="/quick-tagger" component={QuickTagger} />
      <Route path="/conflict-resolution" component={ConflictResolution} />
      <Route path="/evidence" component={EvidencePage} />
      <Route path="/vaults" component={VaultManagement} />
      <Route path="/cleanup" component={Cleanup} />
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
              <header className="flex items-center justify-between p-4 border-b gap-2">
                <SidebarTrigger data-testid="button-sidebar-toggle" />
                <div className="flex items-center gap-2">
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
  const { isAuthenticated, isInitialized, isLoading } = useAuth();

  // Still loading vault status
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

  // Not authenticated - show login screen
  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // Authenticated - show main app
  return <AuthenticatedApp />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <AppContent />
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
