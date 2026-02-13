import { 
  Database, 
  Settings, 
  Download, 
  QrCode, 
  RefreshCw, 
  Wallet, 
  ArrowDownUp, 
  List, 
  Repeat2, 
  BarChart3, 
  Server, 
  ClipboardList, 
  Zap, 
  Coins, 
  Sparkles, 
  Wrench, 
  Palette, 
  Network, 
  ChevronDown, 
  Shapes, 
  PanelLeft, 
  LayoutGrid,
  LayoutDashboard,
  Upload,
  Layers,
  Map,
  Import,
  DollarSign,
  AlertCircle,
  Key,
  FileText,
  Tags,
  Vault,
  Trash2,
  Smartphone,
  LayoutList
} from "lucide-react";
import logoUrl from "@assets/foot_1764929618997.png";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Link, useLocation } from "wouter";
import { useState, useEffect } from "react";

interface NavItem {
  title: string;
  url: string;
  icon: React.ElementType;
}

interface NavGroup {
  id: string;
  title: string;
  icon: React.ElementType;
  items: NavItem[];
  defaultOpen?: boolean;
}

const navGroups: NavGroup[] = [
  {
    id: "overview",
    title: "Overview",
    icon: LayoutDashboard,
    defaultOpen: true,
    items: [
      { title: "Records", url: "/", icon: Database },
      { title: "Nudgie", url: "/nudgie", icon: Sparkles },
    ]
  },
  {
    id: "data",
    title: "Data",
    icon: Database,
    defaultOpen: true,
    items: [
      { title: "Transactions", url: "/transactions", icon: List },
      { title: "UTXOs", url: "/utxos", icon: Coins },
      { title: "Vaults", url: "/vaults", icon: Vault },
      { title: "Wallet Overview", url: "/wallet-overview", icon: LayoutList },
      { title: "Bulk Editor", url: "/bulk-editor", icon: Layers },
      { title: "Conflict Resolution", url: "/conflict-resolution", icon: AlertCircle },
    ]
  },
  {
    id: "analysis",
    title: "Analysis",
    icon: BarChart3,
    defaultOpen: false,
    items: [
      { title: "Address Reuse", url: "/address-reuse", icon: Repeat2 },
      { title: "Provenance", url: "/provenance", icon: Map },
      { title: "Flow Visualizer", url: "/flow-visualizer", icon: Network },
      { title: "Data Stats", url: "/data-stats", icon: BarChart3 },
      { title: "Reports", url: "/reports", icon: ClipboardList },
      { title: "Statement", url: "/statement", icon: FileText },
      { title: "Lightning", url: "/lightning-speculator", icon: Zap },
    ]
  },
  {
    id: "import-export",
    title: "Import / Export",
    icon: Upload,
    defaultOpen: false,
    items: [
      { title: "Address Importer", url: "/import", icon: Import },
      { title: "Descriptor Import", url: "/descriptor-import", icon: Key },
      { title: "BIP-329 Labels", url: "/bip329-import", icon: Tags },
      { title: "Wallet Data Sync", url: "/wallet-import", icon: Wallet },
      { title: "Mobile Wallets", url: "/mobile-wallet-import", icon: Smartphone },
      { title: "Price Import", url: "/price-import", icon: DollarSign },
      { title: "Transaction Sync", url: "/transaction-sync", icon: ArrowDownUp },
      { title: "QR Scanner", url: "/scanner", icon: QrCode },
      { title: "Quick Tagger", url: "/quick-tagger", icon: Tags },
      { title: "Backup", url: "/export", icon: Download },
    ]
  },
  {
    id: "documents",
    title: "Documents",
    icon: FileText,
    defaultOpen: false,
    items: [
      { title: "Evidence", url: "/evidence", icon: FileText },
    ]
  },
  {
    id: "system",
    title: "System",
    icon: Settings,
    defaultOpen: false,
    items: [
      { title: "Node Connection", url: "/node-settings", icon: Server },
      { title: "Value Updater", url: "/value-updater", icon: RefreshCw },
      { title: "Cleanup", url: "/cleanup", icon: Trash2 },
      { title: "Settings", url: "/settings", icon: Settings },
    ]
  },
];

const devToolsGroup: NavGroup = {
  id: "dev-tools",
  title: "Dev Tools",
  icon: Wrench,
  defaultOpen: false,
  items: [
    { title: "Test Data Seeder", url: "/dev/test-data", icon: Database },
    { title: "UI Assets", url: "/dev/ui-assets", icon: Palette },
    { title: "Icons Reference", url: "/dev/icons", icon: Shapes },
    { title: "Nav Patterns", url: "/dev/nav-patterns", icon: PanelLeft },
    { title: "Grouped Sidebar", url: "/dev/grouped-sidebar", icon: LayoutGrid },
    { title: "Flow Visualizations", url: "/dev/flow-viz", icon: Network },
  ]
};

export function AppSidebar() {
  const [location] = useLocation();
  
  const getInitialOpenState = () => {
    const state: Record<string, boolean> = {};
    
    navGroups.forEach(group => {
      const hasActiveItem = group.items.some(item => location === item.url);
      state[group.id] = hasActiveItem || (group.defaultOpen ?? false);
    });
    
    const devToolsActive = location.startsWith("/dev/");
    state[devToolsGroup.id] = devToolsActive || (devToolsGroup.defaultOpen ?? false);
    
    return state;
  };

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(getInitialOpenState);

  useEffect(() => {
    setOpenGroups(prev => {
      const newState = { ...prev };
      
      navGroups.forEach(group => {
        const hasActiveItem = group.items.some(item => location === item.url);
        if (hasActiveItem && !prev[group.id]) {
          newState[group.id] = true;
        }
      });
      
      const devToolsActive = location.startsWith("/dev/");
      if (devToolsActive && !prev[devToolsGroup.id]) {
        newState[devToolsGroup.id] = true;
      }
      
      return newState;
    });
  }, [location]);

  const toggleGroup = (id: string) => {
    setOpenGroups(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const renderGroup = (group: NavGroup) => (
    <Collapsible 
      key={group.id} 
      open={openGroups[group.id]} 
      onOpenChange={() => toggleGroup(group.id)}
    >
      <SidebarGroup className="py-0">
        <CollapsibleTrigger 
          className="flex items-center justify-between w-full px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:bg-muted/50 rounded-md transition-colors cursor-pointer"
          data-testid={`group-${group.id}`}
        >
          <span className="flex items-center gap-2">
            <group.icon className="h-4 w-4" />
            {group.title}
          </span>
          <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${openGroups[group.id] ? "" : "-rotate-90"}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarGroupContent className="mt-1 pl-6">
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url} 
                    data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                    className="text-xs"
                  >
                    <Link href={item.url}>
                      <item.icon className="h-4 w-4" />
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
  );

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <img src={logoUrl} alt="KYUTXO" className="h-8 w-8" />
          <div className="flex flex-col">
            <span className="font-bold text-lg tracking-tight">KYUTXO</span>
            <span className="text-xs text-muted-foreground">Bitcoin Metadata Manager</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2">
        <div className="space-y-1">
          {navGroups.map(renderGroup)}
          {renderGroup(devToolsGroup)}
        </div>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <div className="text-xs text-muted-foreground">
          <p>Offline-first PWA</p>
          <p className="mt-1">All data stored locally</p>
          <p className="mt-1">v1.5.2</p>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
