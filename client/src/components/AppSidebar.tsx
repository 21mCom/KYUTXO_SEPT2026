import { Database, FileText, Settings, Upload, Download, QrCode, Key, RefreshCw, Wallet, TrendingUp, ArrowDownUp, List, GitBranch, Repeat2, BarChart3, Server, ClipboardList, Zap, Coins, Sparkles, Wrench, Palette, Network, ChevronDown } from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Link, useLocation } from "wouter";
import { useState } from "react";

const menuItems = [
  {
    title: "Records",
    url: "/",
    icon: Database,
  },
  {
    title: "Address Importer",
    url: "/import",
    icon: Key,
  },
  {
    title: "Wallet Data Sync",
    url: "/wallet-import",
    icon: Wallet,
  },
  {
    title: "Price Import",
    url: "/price-import",
    icon: TrendingUp,
  },
  {
    title: "Transaction Sync",
    url: "/transaction-sync",
    icon: ArrowDownUp,
  },
  {
    title: "Transactions",
    url: "/transactions",
    icon: List,
  },
  {
    title: "UTXOs",
    url: "/utxos",
    icon: Coins,
  },
  {
    title: "Nudgie",
    url: "/nudgie",
    icon: Sparkles,
  },
  {
    title: "Lightning Speculator",
    url: "/lightning-speculator",
    icon: Zap,
  },
  {
    title: "Provenance",
    url: "/provenance",
    icon: GitBranch,
  },
  {
    title: "Address Reuse",
    url: "/address-reuse",
    icon: Repeat2,
  },
  {
    title: "Data Stats",
    url: "/data-stats",
    icon: BarChart3,
  },
  {
    title: "Reports",
    url: "/reports",
    icon: ClipboardList,
  },
  {
    title: "QR Scanner",
    url: "/scanner",
    icon: QrCode,
  },
  {
    title: "Value Updater",
    url: "/value-updater",
    icon: RefreshCw,
  },
  {
    title: "Backup",
    url: "/export",
    icon: Download,
  },
  {
    title: "Node Connection",
    url: "/node-settings",
    icon: Server,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
];

const devToolsItems = [
  {
    title: "UI Assets",
    url: "/dev/ui-assets",
    icon: Palette,
  },
  {
    title: "Flow Visualizations",
    url: "/dev/flow-viz",
    icon: Network,
  },
];

export function AppSidebar() {
  const [location] = useLocation();
  const [devToolsOpen, setDevToolsOpen] = useState(
    location.startsWith("/dev/")
  );

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <SiBitcoin className="h-8 w-8 text-primary" />
          <div className="flex flex-col">
            <span className="font-bold text-lg tracking-tight">KYBTC</span>
            <span className="text-xs text-muted-foreground">Bitcoin Manager</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={location === item.url} data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                    <Link href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        
        <Collapsible open={devToolsOpen} onOpenChange={setDevToolsOpen}>
          <SidebarGroup>
            <CollapsibleTrigger asChild>
              <SidebarGroupLabel className="cursor-pointer flex items-center justify-between hover-elevate rounded-md px-2 py-1" data-testid="link-dev-tools">
                <span className="flex items-center gap-2">
                  <Wrench className="h-4 w-4" />
                  Dev Tools
                </span>
                <ChevronDown className={`h-4 w-4 transition-transform ${devToolsOpen ? "rotate-180" : ""}`} />
              </SidebarGroupLabel>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {devToolsItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild isActive={location === item.url} data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                        <Link href={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <div className="text-xs text-muted-foreground">
          <p>Offline-first PWA</p>
          <p className="mt-1">All data stored locally</p>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
