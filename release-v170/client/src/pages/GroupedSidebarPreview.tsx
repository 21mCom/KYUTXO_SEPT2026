import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { 
  Database,
  Sparkles,
  List,
  Coins,
  Repeat2,
  GitBranch,
  BarChart3,
  ClipboardList,
  Zap,
  Key,
  Wallet,
  TrendingUp,
  ArrowDownUp,
  QrCode,
  RefreshCw,
  Download,
  Server,
  Settings,
  Wrench,
  Palette,
  Shapes,
  PanelLeft,
  Network,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  PanelLeftClose,
  Eye,
  EyeOff,
  LayoutGrid,
  LayoutDashboard,
  Upload
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";

interface NavItem {
  title: string;
  url: string;
  icon: React.ElementType;
  badge?: string;
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
      { title: "Nudgie", url: "/nudgie", icon: Sparkles, badge: "Workflow" },
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
    ]
  },
  {
    id: "analysis",
    title: "Analysis",
    icon: BarChart3,
    defaultOpen: false,
    items: [
      { title: "Address Reuse", url: "/address-reuse", icon: Repeat2 },
      { title: "Provenance", url: "/provenance", icon: GitBranch },
      { title: "Data Stats", url: "/data-stats", icon: BarChart3 },
      { title: "Reports", url: "/reports", icon: ClipboardList },
      { title: "Lightning", url: "/lightning-speculator", icon: Zap, badge: "Beta" },
    ]
  },
  {
    id: "import-export",
    title: "Import / Export",
    icon: Upload,
    defaultOpen: false,
    items: [
      { title: "Address Importer", url: "/import", icon: Key },
      { title: "Wallet Data Sync", url: "/wallet-import", icon: Wallet },
      { title: "Price Import", url: "/price-import", icon: TrendingUp },
      { title: "Transaction Sync", url: "/transaction-sync", icon: ArrowDownUp },
      { title: "QR Scanner", url: "/scanner", icon: QrCode },
    ]
  },
  {
    id: "system",
    title: "System",
    icon: Settings,
    defaultOpen: false,
    items: [
      { title: "Backup", url: "/export", icon: Download },
      { title: "Node Connection", url: "/node-settings", icon: Server },
      { title: "Value Updater", url: "/value-updater", icon: RefreshCw },
      { title: "Settings", url: "/settings", icon: Settings },
    ]
  },
  {
    id: "dev-tools",
    title: "Dev Tools",
    icon: Wrench,
    defaultOpen: false,
    items: [
      { title: "UI Assets", url: "/dev/ui-assets", icon: Palette },
      { title: "Icons Reference", url: "/dev/icons", icon: Shapes },
      { title: "Nav Patterns", url: "/dev/nav-patterns", icon: PanelLeft },
      { title: "Grouped Sidebar", url: "/dev/grouped-sidebar", icon: LayoutGrid },
      { title: "Flow Visualizations", url: "/dev/flow-viz", icon: Network },
    ]
  },
];

export default function GroupedSidebarPreview() {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    Object.fromEntries(navGroups.map(g => [g.id, g.defaultOpen ?? false]))
  );
  const [activeItem, setActiveItem] = useState("/");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showDevTools, setShowDevTools] = useState(true);

  const toggleGroup = (id: string) => {
    setOpenGroups(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const expandAll = () => {
    setOpenGroups(Object.fromEntries(navGroups.map(g => [g.id, true])));
  };

  const collapseAll = () => {
    setOpenGroups(Object.fromEntries(navGroups.map(g => [g.id, false])));
  };

  const visibleGroups = showDevTools 
    ? navGroups 
    : navGroups.filter(g => g.id !== 'dev-tools');

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">Preview</Badge>
            <h1 className="text-3xl font-bold" data-testid="text-page-title">Grouped Sidebar Preview</h1>
          </div>
          <p className="text-muted-foreground">
            Interactive preview of the proposed grouped navigation. Click items to simulate navigation.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <CardTitle>Preview Controls</CardTitle>
                <CardDescription>Adjust the preview to test different states</CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={expandAll}
                  data-testid="button-expand-all"
                >
                  Expand All
                </Button>
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={collapseAll}
                  data-testid="button-collapse-all"
                >
                  Collapse All
                </Button>
                <Separator orientation="vertical" className="h-6" />
                <Button 
                  size="sm" 
                  variant={sidebarCollapsed ? "default" : "outline"}
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  data-testid="button-toggle-collapse"
                >
                  {sidebarCollapsed ? <PanelLeft className="h-4 w-4 mr-2" /> : <PanelLeftClose className="h-4 w-4 mr-2" />}
                  {sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
                </Button>
                <Button 
                  size="sm" 
                  variant={showDevTools ? "outline" : "secondary"}
                  onClick={() => setShowDevTools(!showDevTools)}
                  data-testid="button-toggle-devtools"
                >
                  {showDevTools ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
                  {showDevTools ? "Hide Dev Tools" : "Show Dev Tools"}
                </Button>
              </div>
            </div>
          </CardHeader>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Full Sidebar (Expanded)</CardTitle>
              <CardDescription>Click groups to expand/collapse, click items to select</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="border-t flex h-[560px]">
                <div className={`bg-sidebar border-r transition-all duration-200 ${sidebarCollapsed ? 'w-14' : 'w-64'} flex flex-col`}>
                  <div className="p-3 border-b flex items-center gap-2">
                    <div className="w-8 h-8 rounded bg-primary flex items-center justify-center flex-shrink-0">
                      <SiBitcoin className="h-5 w-5 text-primary-foreground" />
                    </div>
                    {!sidebarCollapsed && (
                      <div className="flex flex-col">
                        <span className="font-bold text-sm">KYBTC</span>
                        <span className="text-xs text-muted-foreground">Bitcoin Manager</span>
                      </div>
                    )}
                  </div>
                  
                  <ScrollArea className="flex-1">
                    <div className="p-2 space-y-1">
                      {visibleGroups.map((group) => (
                        <Collapsible 
                          key={group.id} 
                          open={!sidebarCollapsed && openGroups[group.id]}
                          onOpenChange={() => !sidebarCollapsed && toggleGroup(group.id)}
                        >
                          <CollapsibleTrigger 
                            className={`flex items-center w-full p-2 rounded text-sm hover:bg-muted/50 transition-colors ${
                              sidebarCollapsed ? 'justify-center' : 'justify-between gap-2'
                            }`}
                            data-testid={`group-trigger-${group.id}`}
                          >
                            <div className="flex items-center gap-2">
                              <group.icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                              {!sidebarCollapsed && (
                                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                  {group.title}
                                </span>
                              )}
                            </div>
                            {!sidebarCollapsed && (
                              openGroups[group.id] 
                                ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> 
                                : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            )}
                          </CollapsibleTrigger>
                          
                          <CollapsibleContent className="space-y-0.5 mt-0.5">
                            {group.items.map((item) => (
                              <button
                                key={item.url}
                                onClick={() => setActiveItem(item.url)}
                                className={`flex items-center gap-2 w-full p-2 rounded text-sm transition-colors ${
                                  activeItem === item.url 
                                    ? 'bg-sidebar-accent text-sidebar-accent-foreground' 
                                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                                } ${sidebarCollapsed ? 'justify-center' : 'pl-8'}`}
                                data-testid={`nav-item-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                              >
                                <item.icon className="h-4 w-4 flex-shrink-0" />
                                {!sidebarCollapsed && (
                                  <>
                                    <span className="flex-1 text-left">{item.title}</span>
                                    {item.badge && (
                                      <Badge variant="secondary" className="text-xs px-1.5 py-0">
                                        {item.badge}
                                      </Badge>
                                    )}
                                  </>
                                )}
                              </button>
                            ))}
                          </CollapsibleContent>
                        </Collapsible>
                      ))}
                    </div>
                  </ScrollArea>

                  <div className="p-2 border-t">
                    <button
                      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                      className={`flex items-center gap-2 w-full p-2 rounded text-sm text-muted-foreground hover:bg-muted/50 transition-colors ${
                        sidebarCollapsed ? 'justify-center' : ''
                      }`}
                      data-testid="button-sidebar-collapse-internal"
                    >
                      {sidebarCollapsed 
                        ? <PanelLeft className="h-4 w-4" />
                        : <><PanelLeftClose className="h-4 w-4" /><span>Collapse</span></>
                      }
                    </button>
                  </div>
                </div>
                
                <div className="flex-1 bg-background p-4 overflow-auto">
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">Selected</Badge>
                      <span className="font-medium">{activeItem}</span>
                    </div>
                    <div className="h-64 border-2 border-dashed border-muted rounded-lg flex items-center justify-center">
                      <span className="text-muted-foreground">
                        {navGroups.flatMap(g => g.items).find(i => i.url === activeItem)?.title || 'Page'} Content
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Proposed Groupings</CardTitle>
                <CardDescription>How the current nav items are organized</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {navGroups.map((group) => (
                  <div key={group.id} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <group.icon className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{group.title}</span>
                      <Badge variant="outline" className="text-xs">{group.items.length}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1 pl-6">
                      {group.items.map((item) => (
                        <Badge 
                          key={item.url} 
                          variant={activeItem === item.url ? "default" : "secondary"}
                          className="cursor-pointer"
                          onClick={() => setActiveItem(item.url)}
                          data-testid={`badge-nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                        >
                          {item.title}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Group Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3 text-sm">
                  <div className="flex items-start gap-2">
                    <LayoutDashboard className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="font-medium">Overview</span>
                      <span className="text-muted-foreground"> - Main views and workflows</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Database className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="font-medium">Data</span>
                      <span className="text-muted-foreground"> - Transaction and UTXO lists</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <BarChart3 className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="font-medium">Analysis</span>
                      <span className="text-muted-foreground"> - Reports and pattern detection</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Upload className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="font-medium">Import / Export</span>
                      <span className="text-muted-foreground"> - Data import and QR scanning</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Settings className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="font-medium">System</span>
                      <span className="text-muted-foreground"> - Backup, nodes, utilities, settings</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Wrench className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="font-medium">Dev Tools</span>
                      <span className="text-muted-foreground"> - Development utilities</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Key Features</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span><strong>6 logical groups</strong> vs flat list of 18 items</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span><strong>Collapsible</strong> - Hide sections you don't use</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span><strong>Icon-only mode</strong> - More content space</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span><strong>Dev Tools hidden</strong> - Toggle off for production</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span><strong>Badges</strong> - Mark Beta, Workflow, etc.</span>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle>Ready to Apply?</CardTitle>
            <CardDescription>
              If you like this layout, let me know and I'll update the actual sidebar to match.
            </CardDescription>
          </CardHeader>
        </Card>

        <div className="h-8" />
      </div>
    </ScrollArea>
  );
}
