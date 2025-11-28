import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { LoginScreen } from "@/components/LoginScreen";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import Dashboard from "@/pages/Dashboard";
import ValueUpdaterPage from "@/pages/ValueUpdaterPage";
import BulkImport from "@/pages/BulkImport";
import WalletImport from "@/pages/WalletImport";
import PriceImport from "@/pages/PriceImport";
import TransactionSync from "@/pages/TransactionSync";
import QRScanner from "@/pages/QRScanner";
import ExportPage from "@/pages/ExportPage";
import SettingsPage from "@/pages/SettingsPage";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/value-updater" component={ValueUpdaterPage} />
      <Route path="/import" component={BulkImport} />
      <Route path="/wallet-import" component={WalletImport} />
      <Route path="/price-import" component={PriceImport} />
      <Route path="/transaction-sync" component={TransactionSync} />
      <Route path="/scanner" component={QRScanner} />
      <Route path="/export" component={ExportPage} />
      <Route path="/settings" component={SettingsPage} />
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
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
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
