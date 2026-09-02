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
  Check,
  Copy,
  ExternalLink,
  Eye,
  Edit,
  Hash,
  Pencil,
  Info,
  Tag,
  Link2
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

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

const quickActionPatterns: PatternOption[] = [
  { id: "QA-1", title: "Hover Card Preview", description: "Hover over address/txid to see quick preview with metadata", tags: ["no-click", "fast", "preview"] },
  { id: "QA-2", title: "Click Popover", description: "Click address/txid for small popover with view/edit/copy actions", tags: ["minimal", "context-menu"] },
  { id: "QA-3", title: "Inline Expand", description: "Click to expand details inline below the address/txid", tags: ["no-modal", "inline"] },
  { id: "QA-4", title: "Side Sheet Panel", description: "Click opens slide-in panel from right with full details", tags: ["detail-view", "non-blocking"] },
  { id: "QA-5", title: "Modal Dialog", description: "Click opens centered modal with full edit form", tags: ["focused", "full-edit"] },
  { id: "QA-6", title: "Dropdown Actions", description: "Right-click or icon menu with View/Edit/Copy/Explorer actions", tags: ["power-user", "context-menu"] },
];

const SAMPLE_ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const SAMPLE_TXID = "a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d";

export default function NavigationPatterns() {
  const [selectedPatterns, setSelectedPatterns] = useState<string[]>([]);
  const [demoSidebarCollapsed, setDemoSidebarCollapsed] = useState(false);
  const [demoGroupsOpen, setDemoGroupsOpen] = useState<Record<string, boolean>>({ main: true, data: false, settings: false });
  const [activeTab, setActiveTab] = useState("dashboard");
  const [inlineExpanded, setInlineExpanded] = useState<string | null>(null);

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

        <Tabs defaultValue="quick-actions" className="w-full">
          <TabsList>
            <TabsTrigger value="quick-actions" data-testid="tab-quick-actions">Quick Actions</TabsTrigger>
            <TabsTrigger value="sidebars" data-testid="tab-sidebars">Sidebars</TabsTrigger>
            <TabsTrigger value="headers" data-testid="tab-headers">Headers</TabsTrigger>
            <TabsTrigger value="layouts" data-testid="tab-layouts">Layouts</TabsTrigger>
            <TabsTrigger value="demos" data-testid="tab-demos">Interactive Demos</TabsTrigger>
          </TabsList>

          <TabsContent value="quick-actions" className="space-y-6 mt-6">
            <div className="space-y-2 mb-6">
              <p className="text-sm text-muted-foreground">
                These patterns demonstrate different ways to quickly view and edit address/transaction metadata without navigating away from the current page. 
                Especially important for the portable desktop app where opening multiple browser tabs isn't available.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {quickActionPatterns.map((pattern) => (
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
                <CardTitle>Interactive Quick Action Demos</CardTitle>
                <CardDescription>Try each pattern to see how it works. Sample addresses and txids are shown below.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-8">
                {/* QA-1: Hover Card Preview */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">QA-1</Badge>
                    <span className="font-medium">Hover Card Preview</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Hover over the address to see a preview card with metadata.</p>
                  <div className="p-4 bg-muted/30 rounded-md border">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Address:</span>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <Button variant="link" className="h-auto p-0 font-mono text-sm" data-testid="hover-card-address">
                            {SAMPLE_ADDRESS.slice(0, 12)}...{SAMPLE_ADDRESS.slice(-8)}
                          </Button>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80" align="start">
                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <Wallet className="h-4 w-4 text-primary" />
                              <span className="font-semibold">Address Details</span>
                            </div>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Owner</span>
                                <span>Personal Wallet</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Wallet</span>
                                <span>Main Savings</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Tags</span>
                                <div className="flex gap-1">
                                  <Badge variant="secondary" className="text-xs">cold-storage</Badge>
                                </div>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Balance</span>
                                <span className="font-mono">0.5432 BTC</span>
                              </div>
                            </div>
                            <Separator />
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" className="flex-1">
                                <Eye className="h-3 w-3 mr-1" /> View
                              </Button>
                              <Button size="sm" variant="outline" className="flex-1">
                                <Edit className="h-3 w-3 mr-1" /> Edit
                              </Button>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* QA-2: Click Popover */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">QA-2</Badge>
                    <span className="font-medium">Click Popover</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Click the txid for a small popover with quick actions.</p>
                  <div className="p-4 bg-muted/30 rounded-md border">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">TxID:</span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="link" className="h-auto p-0 font-mono text-sm" data-testid="click-popover-txid">
                            {SAMPLE_TXID.slice(0, 16)}...
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64" align="start">
                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <Hash className="h-4 w-4 text-primary" />
                              <span className="text-sm font-semibold">Transaction</span>
                            </div>
                            <div className="space-y-1">
                              <Button variant="ghost" size="sm" className="w-full justify-start" data-testid="button-popover-view">
                                <Eye className="h-4 w-4 mr-2" /> View Details
                              </Button>
                              <Button variant="ghost" size="sm" className="w-full justify-start" data-testid="button-popover-edit">
                                <Pencil className="h-4 w-4 mr-2" /> Edit Labels
                              </Button>
                              <Button variant="ghost" size="sm" className="w-full justify-start" data-testid="button-popover-copy">
                                <Copy className="h-4 w-4 mr-2" /> Copy TxID
                              </Button>
                              <Button variant="ghost" size="sm" className="w-full justify-start" data-testid="button-popover-explorer">
                                <ExternalLink className="h-4 w-4 mr-2" /> Open in Explorer
                              </Button>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* QA-3: Inline Expand */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">QA-3</Badge>
                    <span className="font-medium">Inline Expand</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Click to expand details inline below the address.</p>
                  <div className="p-4 bg-muted/30 rounded-md border">
                    <div className="space-y-2">
                      <div 
                        className="flex items-center gap-2 cursor-pointer hover-elevate rounded p-2 -m-2"
                        onClick={() => setInlineExpanded(inlineExpanded === 'demo' ? null : 'demo')}
                        data-testid="inline-expand-trigger"
                      >
                        {inlineExpanded === 'demo' ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="text-sm text-muted-foreground">Address:</span>
                        <span className="font-mono text-sm">{SAMPLE_ADDRESS.slice(0, 12)}...{SAMPLE_ADDRESS.slice(-8)}</span>
                      </div>
                      
                      {inlineExpanded === 'demo' && (
                        <div className="ml-6 p-3 bg-card border rounded-md space-y-3">
                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div>
                              <span className="text-muted-foreground">Owner:</span>
                              <span className="ml-2">Personal</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Wallet:</span>
                              <span className="ml-2">Main</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Type:</span>
                              <span className="ml-2">Receive</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Status:</span>
                              <Badge variant="secondary" className="ml-2 text-xs">Verified</Badge>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" data-testid="button-inline-edit">
                              <Edit className="h-3 w-3 mr-1" /> Edit
                            </Button>
                            <Button size="sm" variant="ghost" data-testid="button-inline-copy">
                              <Copy className="h-3 w-3 mr-1" /> Copy
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <Separator />

                {/* QA-4: Side Sheet Panel */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">QA-4</Badge>
                    <span className="font-medium">Side Sheet Panel</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Click to open a slide-in panel from the right with full details.</p>
                  <div className="p-4 bg-muted/30 rounded-md border">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Address:</span>
                      <Sheet>
                        <SheetTrigger asChild>
                          <Button variant="link" className="h-auto p-0 font-mono text-sm" data-testid="sheet-trigger-address">
                            {SAMPLE_ADDRESS.slice(0, 12)}...{SAMPLE_ADDRESS.slice(-8)}
                          </Button>
                        </SheetTrigger>
                        <SheetContent className="sm:max-w-lg">
                          <SheetHeader>
                            <SheetTitle className="flex items-center gap-2">
                              <Wallet className="h-5 w-5" />
                              Address Details
                            </SheetTitle>
                          </SheetHeader>
                          <div className="mt-6 space-y-6">
                            <div className="space-y-4">
                              <div>
                                <label className="text-sm font-medium text-muted-foreground">Full Address</label>
                                <div className="flex items-center gap-2 mt-1">
                                  <code className="flex-1 p-2 bg-muted rounded text-xs font-mono break-all">{SAMPLE_ADDRESS}</code>
                                  <Button size="icon" variant="ghost" data-testid="button-sheet-copy">
                                    <Copy className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                              
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <label className="text-sm font-medium text-muted-foreground">Owner</label>
                                  <p className="mt-1">Personal Wallet</p>
                                </div>
                                <div>
                                  <label className="text-sm font-medium text-muted-foreground">Wallet Name</label>
                                  <p className="mt-1">Main Savings</p>
                                </div>
                              </div>

                              <div>
                                <label className="text-sm font-medium text-muted-foreground">Tags</label>
                                <div className="flex gap-2 mt-1 flex-wrap">
                                  <Badge variant="secondary">cold-storage</Badge>
                                  <Badge variant="secondary">long-term</Badge>
                                  <Button size="sm" variant="ghost" className="h-6">
                                    <Plus className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>

                              <div>
                                <label className="text-sm font-medium text-muted-foreground">Notes</label>
                                <p className="mt-1 text-sm">Main cold storage address for long-term holdings.</p>
                              </div>
                            </div>

                            <Separator />

                            <div className="flex gap-2">
                              <Button className="flex-1" data-testid="button-sheet-edit">
                                <Edit className="h-4 w-4 mr-2" /> Edit Record
                              </Button>
                              <Button variant="outline" data-testid="button-sheet-explorer">
                                <ExternalLink className="h-4 w-4 mr-2" /> Explorer
                              </Button>
                            </div>
                          </div>
                        </SheetContent>
                      </Sheet>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* QA-5: Modal Dialog */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">QA-5</Badge>
                    <span className="font-medium">Modal Dialog</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Click to open a centered modal with full edit form.</p>
                  <div className="p-4 bg-muted/30 rounded-md border">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">TxID:</span>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="link" className="h-auto p-0 font-mono text-sm" data-testid="modal-trigger-txid">
                            {SAMPLE_TXID.slice(0, 16)}...
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-xl">
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                              <Hash className="h-5 w-5" />
                              Edit Transaction
                            </DialogTitle>
                          </DialogHeader>
                          <div className="space-y-4 mt-4">
                            <div>
                              <label className="text-sm font-medium">Transaction ID</label>
                              <code className="block p-2 bg-muted rounded text-xs font-mono mt-1 break-all">{SAMPLE_TXID}</code>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <label className="text-sm font-medium">Flow Type</label>
                                <div className="mt-1 p-2 bg-muted rounded text-sm">Received</div>
                              </div>
                              <div>
                                <label className="text-sm font-medium">Counterparty Type</label>
                                <div className="mt-1 p-2 bg-muted rounded text-sm">Exchange</div>
                              </div>
                            </div>

                            <div>
                              <label className="text-sm font-medium">Label</label>
                              <div className="mt-1 p-2 bg-muted rounded text-sm">BTC purchase from Coinbase</div>
                            </div>

                            <div>
                              <label className="text-sm font-medium">Notes</label>
                              <div className="mt-1 p-2 bg-muted rounded text-sm min-h-[60px]">Purchased during the dip. Cost basis: $42,500</div>
                            </div>

                            <div className="flex gap-2 justify-end">
                              <Button variant="outline" data-testid="button-modal-cancel">Cancel</Button>
                              <Button data-testid="button-modal-save">Save Changes</Button>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* QA-6: Dropdown Actions */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">QA-6</Badge>
                    <span className="font-medium">Dropdown Actions</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Click the menu icon for a dropdown with View/Edit/Copy/Explorer actions.</p>
                  <div className="p-4 bg-muted/30 rounded-md border">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Address:</span>
                      <span className="font-mono text-sm">{SAMPLE_ADDRESS.slice(0, 12)}...{SAMPLE_ADDRESS.slice(-8)}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" data-testid="dropdown-trigger">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem data-testid="dropdown-item-view">
                            <Eye className="h-4 w-4 mr-2" /> View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem data-testid="dropdown-item-edit">
                            <Pencil className="h-4 w-4 mr-2" /> Edit Record
                          </DropdownMenuItem>
                          <DropdownMenuItem data-testid="dropdown-item-tag">
                            <Tag className="h-4 w-4 mr-2" /> Add Tag
                          </DropdownMenuItem>
                          <DropdownMenuItem data-testid="dropdown-item-copy">
                            <Copy className="h-4 w-4 mr-2" /> Copy Address
                          </DropdownMenuItem>
                          <DropdownMenuItem data-testid="dropdown-item-explorer">
                            <ExternalLink className="h-4 w-4 mr-2" /> Open in Explorer
                          </DropdownMenuItem>
                          <DropdownMenuItem data-testid="dropdown-item-provenance">
                            <Link2 className="h-4 w-4 mr-2" /> Trace Provenance
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recommended Combination</CardTitle>
                <CardDescription>Best practice for KYUTXO portable app</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm">
                  For the portable desktop app without browser tabs, we recommend combining:
                </p>
                <ul className="list-disc list-inside text-sm space-y-2 text-muted-foreground">
                  <li><strong className="text-foreground">QA-1 (Hover Card)</strong> - Quick preview on hover for scanning data</li>
                  <li><strong className="text-foreground">QA-4 (Side Sheet)</strong> - Full details without leaving context</li>
                  <li><strong className="text-foreground">QA-6 (Dropdown)</strong> - Power-user actions menu</li>
                </ul>
                <p className="text-sm text-muted-foreground">
                  This combination provides: instant preview (hover), detailed view (side sheet), and quick actions (dropdown) - 
                  all without navigating away from the current page or needing multiple tabs.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

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
