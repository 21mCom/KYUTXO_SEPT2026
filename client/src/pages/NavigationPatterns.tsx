import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { 
  Home, 
  Settings, 
  Users, 
  FileText, 
  BarChart3, 
  ChevronDown, 
  ChevronRight,
  Menu,
  X,
  Search,
  Bell,
  User,
  Folder,
  Star,
  Clock,
  Archive,
  Trash2,
  Plus,
  LayoutDashboard,
  Wallet,
  ArrowLeftRight,
  Database,
  Shield,
  Zap,
  PanelLeftClose,
  PanelLeft,
  MoreHorizontal,
  Check
} from "lucide-react";

interface PatternOption {
  id: string;
  title: string;
  description: string;
  tags: string[];
}

const sidebarPatterns: PatternOption[] = [
  { id: "NAV-1", title: "Full Sidebar", description: "Traditional sidebar with icons and labels, always visible", tags: ["desktop", "spacious"] },
  { id: "NAV-2", title: "Icon-Only Sidebar", description: "Compact sidebar showing only icons with tooltips on hover", tags: ["compact", "minimal"] },
  { id: "NAV-3", title: "Collapsible Sidebar", description: "Toggle between full and icon-only modes", tags: ["flexible", "responsive"] },
  { id: "NAV-4", title: "Grouped Sidebar", description: "Items organized into collapsible groups/sections", tags: ["organized", "hierarchical"] },
  { id: "NAV-5", title: "Two-Level Sidebar", description: "Primary nav on left rail, secondary content in panel", tags: ["complex", "enterprise"] },
  { id: "NAV-6", title: "Floating Sidebar", description: "Sidebar overlays content on mobile, slides in/out", tags: ["mobile", "overlay"] },
];

const headerPatterns: PatternOption[] = [
  { id: "HDR-1", title: "Simple Header", description: "Logo, search, and user menu", tags: ["minimal", "clean"] },
  { id: "HDR-2", title: "Tabbed Header", description: "Primary navigation as horizontal tabs", tags: ["flat", "quick-access"] },
  { id: "HDR-3", title: "Breadcrumb Header", description: "Shows navigation path with breadcrumbs", tags: ["hierarchical", "context"] },
  { id: "HDR-4", title: "Split Header", description: "Left actions, center title, right actions", tags: ["balanced", "actions"] },
];

const layoutPatterns: PatternOption[] = [
  { id: "LAY-1", title: "Sidebar + Content", description: "Classic two-column layout", tags: ["standard", "familiar"] },
  { id: "LAY-2", title: "Sidebar + Content + Panel", description: "Three-column with detail panel", tags: ["master-detail", "complex"] },
  { id: "LAY-3", title: "Header + Content", description: "No sidebar, horizontal navigation only", tags: ["simple", "marketing"] },
  { id: "LAY-4", title: "Dashboard Grid", description: "Card-based grid with optional sidebar", tags: ["dashboard", "widgets"] },
];

export default function NavigationPatterns() {
  const [selectedPatterns, setSelectedPatterns] = useState<string[]>([]);
  const [demoSidebarCollapsed, setDemoSidebarCollapsed] = useState(false);
  const [demoGroupsOpen, setDemoGroupsOpen] = useState<Record<string, boolean>>({ main: true, data: false, settings: false });
  const [activeTab, setActiveTab] = useState("dashboard");

  const togglePattern = (id: string) => {
    setSelectedPatterns(prev => 
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const toggleGroup = (group: string) => {
    setDemoGroupsOpen(prev => ({ ...prev, [group]: !prev[group] }));
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-8 max-w-6xl mx-auto">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold" data-testid="text-page-title">Navigation Patterns</h1>
          <p className="text-muted-foreground">
            Sidebar layouts, navigation variations, and layout options. Click "Select" to mark preferred patterns.
          </p>
        </div>

        <Tabs defaultValue="sidebars" className="w-full">
          <TabsList>
            <TabsTrigger value="sidebars" data-testid="tab-sidebars">Sidebars</TabsTrigger>
            <TabsTrigger value="headers" data-testid="tab-headers">Headers</TabsTrigger>
            <TabsTrigger value="layouts" data-testid="tab-layouts">Layouts</TabsTrigger>
            <TabsTrigger value="demos" data-testid="tab-demos">Interactive Demos</TabsTrigger>
          </TabsList>

          <TabsContent value="sidebars" className="space-y-6 mt-6">
            <div className="grid gap-4 md:grid-cols-2">
              {sidebarPatterns.map((pattern) => (
                <Card key={pattern.id} className={selectedPatterns.includes(pattern.id) ? "ring-2 ring-primary" : ""}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <Badge variant="outline" className="mb-2">{pattern.id}</Badge>
                        <CardTitle className="text-lg">{pattern.title}</CardTitle>
                      </div>
                      <Button 
                        size="sm" 
                        variant={selectedPatterns.includes(pattern.id) ? "default" : "outline"}
                        onClick={() => togglePattern(pattern.id)}
                        data-testid={`button-select-${pattern.id.toLowerCase()}`}
                      >
                        {selectedPatterns.includes(pattern.id) ? <Check className="h-4 w-4 mr-1" /> : null}
                        {selectedPatterns.includes(pattern.id) ? "Selected" : "Select"}
                      </Button>
                    </div>
                    <CardDescription>{pattern.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-1 flex-wrap">
                      {pattern.tags.map(tag => (
                        <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Sidebar Pattern Previews</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-6 md:grid-cols-3">
                <div className="space-y-2">
                  <p className="text-sm font-medium">NAV-1: Full Sidebar</p>
                  <div className="border rounded-md overflow-hidden h-48 flex">
                    <div className="w-48 bg-sidebar border-r p-2 space-y-1">
                      <div className="flex items-center gap-2 p-2 rounded bg-sidebar-accent text-sm">
                        <Home className="h-4 w-4" /> Dashboard
                      </div>
                      <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                        <Users className="h-4 w-4" /> Users
                      </div>
                      <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                        <FileText className="h-4 w-4" /> Documents
                      </div>
                      <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                        <Settings className="h-4 w-4" /> Settings
                      </div>
                    </div>
                    <div className="flex-1 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Content
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">NAV-2: Icon-Only</p>
                  <div className="border rounded-md overflow-hidden h-48 flex">
                    <div className="w-12 bg-sidebar border-r p-1 space-y-1 flex flex-col items-center">
                      <div className="p-2 rounded bg-sidebar-accent">
                        <Home className="h-4 w-4" />
                      </div>
                      <div className="p-2 rounded text-muted-foreground">
                        <Users className="h-4 w-4" />
                      </div>
                      <div className="p-2 rounded text-muted-foreground">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="p-2 rounded text-muted-foreground">
                        <Settings className="h-4 w-4" />
                      </div>
                    </div>
                    <div className="flex-1 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Content
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">NAV-4: Grouped</p>
                  <div className="border rounded-md overflow-hidden h-48 flex">
                    <div className="w-48 bg-sidebar border-r p-2 space-y-2 overflow-hidden">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Main</div>
                      <div className="flex items-center gap-2 p-2 rounded bg-sidebar-accent text-sm">
                        <Home className="h-4 w-4" /> Home
                      </div>
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-2">Data</div>
                      <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                        <Database className="h-4 w-4" /> Records
                      </div>
                    </div>
                    <div className="flex-1 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Content
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">NAV-5: Two-Level</p>
                  <div className="border rounded-md overflow-hidden h-48 flex">
                    <div className="w-12 bg-sidebar border-r p-1 space-y-1 flex flex-col items-center">
                      <div className="p-2 rounded bg-primary text-primary-foreground">
                        <Home className="h-4 w-4" />
                      </div>
                      <div className="p-2 rounded text-muted-foreground">
                        <Folder className="h-4 w-4" />
                      </div>
                      <div className="p-2 rounded text-muted-foreground">
                        <Settings className="h-4 w-4" />
                      </div>
                    </div>
                    <div className="w-36 bg-muted/30 border-r p-2 space-y-1">
                      <div className="text-xs font-medium mb-2">Workspace</div>
                      <div className="text-xs p-1.5 rounded bg-accent">Overview</div>
                      <div className="text-xs p-1.5 text-muted-foreground">Analytics</div>
                      <div className="text-xs p-1.5 text-muted-foreground">Reports</div>
                    </div>
                    <div className="flex-1 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Content
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">NAV-3: Collapsible</p>
                  <div className="border rounded-md overflow-hidden h-48 flex">
                    <div className="w-12 bg-sidebar border-r p-1 flex flex-col">
                      <div className="p-2 rounded bg-muted mb-1 cursor-pointer">
                        <PanelLeft className="h-4 w-4" />
                      </div>
                      <div className="space-y-1 flex-1 flex flex-col items-center">
                        <div className="p-2 rounded bg-sidebar-accent">
                          <Home className="h-4 w-4" />
                        </div>
                        <div className="p-2 rounded text-muted-foreground">
                          <Users className="h-4 w-4" />
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Click icon to expand
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">NAV-6: Floating/Overlay</p>
                  <div className="border rounded-md overflow-hidden h-48 relative">
                    <div className="absolute inset-0 bg-background p-2">
                      <div className="flex items-center gap-2 mb-2">
                        <Menu className="h-4 w-4" />
                        <span className="text-sm font-medium">Mobile View</span>
                      </div>
                      <div className="h-32 border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Content
                      </div>
                    </div>
                    <div className="absolute left-0 top-0 bottom-0 w-40 bg-sidebar border-r p-2 shadow-lg transform translate-x-0">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-sm font-medium">Menu</span>
                        <X className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 p-2 rounded bg-sidebar-accent text-xs">
                          <Home className="h-3 w-3" /> Home
                        </div>
                        <div className="flex items-center gap-2 p-2 rounded text-xs text-muted-foreground">
                          <Users className="h-3 w-3" /> Users
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="headers" className="space-y-6 mt-6">
            <div className="grid gap-4 md:grid-cols-2">
              {headerPatterns.map((pattern) => (
                <Card key={pattern.id} className={selectedPatterns.includes(pattern.id) ? "ring-2 ring-primary" : ""}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <Badge variant="outline" className="mb-2">{pattern.id}</Badge>
                        <CardTitle className="text-lg">{pattern.title}</CardTitle>
                      </div>
                      <Button 
                        size="sm" 
                        variant={selectedPatterns.includes(pattern.id) ? "default" : "outline"}
                        onClick={() => togglePattern(pattern.id)}
                        data-testid={`button-select-${pattern.id.toLowerCase()}`}
                      >
                        {selectedPatterns.includes(pattern.id) ? <Check className="h-4 w-4 mr-1" /> : null}
                        {selectedPatterns.includes(pattern.id) ? "Selected" : "Select"}
                      </Button>
                    </div>
                    <CardDescription>{pattern.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-1 flex-wrap">
                      {pattern.tags.map(tag => (
                        <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Header Pattern Previews</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-sm font-medium">HDR-1: Simple Header</p>
                  <div className="border rounded-md overflow-hidden">
                    <div className="bg-sidebar border-b p-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded bg-primary" />
                        <span className="text-sm font-semibold">Logo</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 bg-muted rounded px-2 py-1">
                          <Search className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">Search...</span>
                        </div>
                        <Bell className="h-4 w-4 text-muted-foreground" />
                        <User className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="h-20 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded" />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">HDR-2: Tabbed Header</p>
                  <div className="border rounded-md overflow-hidden">
                    <div className="bg-sidebar border-b p-2">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded bg-primary" />
                          <span className="text-sm font-semibold">Logo</span>
                        </div>
                        <User className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex gap-1">
                        <div className="px-3 py-1 text-xs rounded-t bg-background border-b-2 border-primary">Dashboard</div>
                        <div className="px-3 py-1 text-xs text-muted-foreground">Projects</div>
                        <div className="px-3 py-1 text-xs text-muted-foreground">Team</div>
                        <div className="px-3 py-1 text-xs text-muted-foreground">Settings</div>
                      </div>
                    </div>
                    <div className="h-16 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded" />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">HDR-3: Breadcrumb Header</p>
                  <div className="border rounded-md overflow-hidden">
                    <div className="bg-sidebar border-b p-2">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded bg-primary" />
                          <span className="text-sm font-semibold">Logo</span>
                        </div>
                        <User className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex items-center gap-1 text-xs">
                        <span className="text-muted-foreground">Home</span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Projects</span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        <span>Current Page</span>
                      </div>
                    </div>
                    <div className="h-16 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded" />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">HDR-4: Split Header</p>
                  <div className="border rounded-md overflow-hidden">
                    <div className="bg-sidebar border-b p-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                          <Menu className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                      <span className="text-sm font-semibold">Page Title</span>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                          <Search className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="h-20 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="layouts" className="space-y-6 mt-6">
            <div className="grid gap-4 md:grid-cols-2">
              {layoutPatterns.map((pattern) => (
                <Card key={pattern.id} className={selectedPatterns.includes(pattern.id) ? "ring-2 ring-primary" : ""}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <Badge variant="outline" className="mb-2">{pattern.id}</Badge>
                        <CardTitle className="text-lg">{pattern.title}</CardTitle>
                      </div>
                      <Button 
                        size="sm" 
                        variant={selectedPatterns.includes(pattern.id) ? "default" : "outline"}
                        onClick={() => togglePattern(pattern.id)}
                        data-testid={`button-select-${pattern.id.toLowerCase()}`}
                      >
                        {selectedPatterns.includes(pattern.id) ? <Check className="h-4 w-4 mr-1" /> : null}
                        {selectedPatterns.includes(pattern.id) ? "Selected" : "Select"}
                      </Button>
                    </div>
                    <CardDescription>{pattern.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-1 flex-wrap">
                      {pattern.tags.map(tag => (
                        <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Layout Pattern Previews</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-sm font-medium">LAY-1: Sidebar + Content</p>
                  <div className="border rounded-md overflow-hidden h-32 flex">
                    <div className="w-12 bg-sidebar border-r" />
                    <div className="flex-1 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Main Content
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">LAY-2: Sidebar + Content + Panel</p>
                  <div className="border rounded-md overflow-hidden h-32 flex">
                    <div className="w-10 bg-sidebar border-r" />
                    <div className="flex-1 bg-background p-1">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        List
                      </div>
                    </div>
                    <div className="w-24 bg-muted/30 border-l p-1">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Detail
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">LAY-3: Header + Content</p>
                  <div className="border rounded-md overflow-hidden h-32 flex flex-col">
                    <div className="h-8 bg-sidebar border-b flex items-center px-2 gap-4">
                      <div className="w-4 h-4 rounded bg-primary" />
                      <div className="flex gap-2 text-xs">
                        <span className="text-foreground">Home</span>
                        <span className="text-muted-foreground">About</span>
                        <span className="text-muted-foreground">Contact</span>
                      </div>
                    </div>
                    <div className="flex-1 bg-background p-2">
                      <div className="h-full border-2 border-dashed border-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                        Full Width Content
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">LAY-4: Dashboard Grid</p>
                  <div className="border rounded-md overflow-hidden h-32 flex">
                    <div className="w-10 bg-sidebar border-r" />
                    <div className="flex-1 bg-background p-1 grid grid-cols-3 gap-1">
                      <div className="border rounded bg-card" />
                      <div className="border rounded bg-card" />
                      <div className="border rounded bg-card" />
                      <div className="border rounded bg-card col-span-2" />
                      <div className="border rounded bg-card" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="demos" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Interactive Collapsible Sidebar</CardTitle>
                <CardDescription>Click the toggle button to collapse/expand</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="border rounded-md overflow-hidden h-64 flex">
                  <div className={`bg-sidebar border-r transition-all duration-200 ${demoSidebarCollapsed ? 'w-14' : 'w-56'}`}>
                    <div className="p-2 border-b flex items-center justify-between">
                      {!demoSidebarCollapsed && <span className="text-sm font-semibold">KYUTXO</span>}
                      <Button 
                        size="icon" 
                        variant="ghost" 
                        className="h-8 w-8"
                        onClick={() => setDemoSidebarCollapsed(!demoSidebarCollapsed)}
                        data-testid="button-toggle-sidebar"
                      >
                        {demoSidebarCollapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                      </Button>
                    </div>
                    <div className="p-2 space-y-1">
                      {[
                        { icon: LayoutDashboard, label: "Dashboard", active: true },
                        { icon: Wallet, label: "Addresses" },
                        { icon: ArrowLeftRight, label: "Transactions" },
                        { icon: Database, label: "Records" },
                        { icon: Shield, label: "Security" },
                        { icon: Settings, label: "Settings" },
                      ].map((item) => (
                        <div 
                          key={item.label}
                          className={`flex items-center gap-3 p-2 rounded text-sm ${
                            item.active ? 'bg-sidebar-accent' : 'text-muted-foreground hover:bg-muted/50'
                          } ${demoSidebarCollapsed ? 'justify-center' : ''}`}
                        >
                          <item.icon className="h-4 w-4 flex-shrink-0" />
                          {!demoSidebarCollapsed && <span>{item.label}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex-1 bg-background p-4">
                    <h3 className="text-lg font-semibold mb-2">Dashboard</h3>
                    <p className="text-sm text-muted-foreground">
                      {demoSidebarCollapsed 
                        ? "Sidebar is collapsed - more room for content!"
                        : "Sidebar is expanded - showing full labels"
                      }
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Grouped/Collapsible Sections</CardTitle>
                <CardDescription>Click group headers to expand/collapse</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="border rounded-md overflow-hidden h-72 flex">
                  <div className="w-56 bg-sidebar border-r overflow-y-auto">
                    <div className="p-2 space-y-2">
                      <Collapsible open={demoGroupsOpen.main} onOpenChange={() => toggleGroup('main')}>
                        <CollapsibleTrigger className="flex items-center justify-between w-full p-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:bg-muted/50 rounded">
                          <span>Main</span>
                          {demoGroupsOpen.main ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </CollapsibleTrigger>
                        <CollapsibleContent className="space-y-1 mt-1">
                          <div className="flex items-center gap-2 p-2 rounded bg-sidebar-accent text-sm">
                            <LayoutDashboard className="h-4 w-4" /> Dashboard
                          </div>
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <Star className="h-4 w-4" /> Favorites
                          </div>
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <Clock className="h-4 w-4" /> Recent
                          </div>
                        </CollapsibleContent>
                      </Collapsible>

                      <Collapsible open={demoGroupsOpen.data} onOpenChange={() => toggleGroup('data')}>
                        <CollapsibleTrigger className="flex items-center justify-between w-full p-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:bg-muted/50 rounded">
                          <span>Data</span>
                          {demoGroupsOpen.data ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </CollapsibleTrigger>
                        <CollapsibleContent className="space-y-1 mt-1">
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <Wallet className="h-4 w-4" /> Addresses
                          </div>
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <ArrowLeftRight className="h-4 w-4" /> Transactions
                          </div>
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <Zap className="h-4 w-4" /> UTXOs
                          </div>
                        </CollapsibleContent>
                      </Collapsible>

                      <Collapsible open={demoGroupsOpen.settings} onOpenChange={() => toggleGroup('settings')}>
                        <CollapsibleTrigger className="flex items-center justify-between w-full p-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:bg-muted/50 rounded">
                          <span>System</span>
                          {demoGroupsOpen.settings ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </CollapsibleTrigger>
                        <CollapsibleContent className="space-y-1 mt-1">
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <Archive className="h-4 w-4" /> Backup
                          </div>
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <Settings className="h-4 w-4" /> Settings
                          </div>
                          <div className="flex items-center gap-2 p-2 rounded text-sm text-muted-foreground">
                            <Trash2 className="h-4 w-4" /> Trash
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  </div>
                  <div className="flex-1 bg-background p-4">
                    <h3 className="text-lg font-semibold mb-2">Collapsible Groups</h3>
                    <p className="text-sm text-muted-foreground">
                      Groups open: {Object.entries(demoGroupsOpen).filter(([,v]) => v).map(([k]) => k).join(', ') || 'None'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Tabbed Navigation</CardTitle>
                <CardDescription>Horizontal tabs for primary navigation</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="border rounded-md overflow-hidden">
                  <div className="bg-sidebar p-3 border-b">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">K</div>
                        <span className="font-semibold">KYUTXO</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Bell className="h-4 w-4 text-muted-foreground" />
                        <User className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {['dashboard', 'addresses', 'transactions', 'reports', 'settings'].map((tab) => (
                        <button
                          key={tab}
                          onClick={() => setActiveTab(tab)}
                          className={`px-4 py-2 text-sm rounded-t transition-colors ${
                            activeTab === tab 
                              ? 'bg-background text-foreground border-b-2 border-primary' 
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                          data-testid={`tab-demo-${tab}`}
                        >
                          {tab.charAt(0).toUpperCase() + tab.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="h-32 bg-background p-4">
                    <h3 className="text-lg font-semibold mb-2">{activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</h3>
                    <p className="text-sm text-muted-foreground">Content for the {activeTab} tab</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Separator />

        {selectedPatterns.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Selected Patterns ({selectedPatterns.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 flex-wrap">
                {selectedPatterns.map(id => (
                  <Badge key={id} variant="default" className="cursor-pointer" onClick={() => togglePattern(id)}>
                    {id} <X className="h-3 w-3 ml-1" />
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="h-8" />
      </div>
    </ScrollArea>
  );
}
