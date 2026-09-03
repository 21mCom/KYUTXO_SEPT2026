import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowDownUp,
  BarChart3,
  Biohazard,
  CalendarRange,
  ChevronsLeftRight,
  ClipboardList,
  Coins,
  Database,
  DollarSign,
  Download,
  Droplets,
  Eye,
  FileText,
  FlaskConical,
  GitBranch,
  HeartPulse,
  Hourglass,
  Import,
  Key,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  LayoutList,
  Layers,
  Map,
  Network,
  Palette,
  PanelLeft,
  QrCode,
  RefreshCw,
  Repeat2,
  Search,
  Server,
  Settings,
  Shapes,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Tags,
  Trash2,
  Upload,
  Vault,
  Wallet,
  Waypoints,
  Wrench,
  Zap,
} from "lucide-react";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  /** Additional words users commonly type when looking for this destination. */
  aliases?: string[];
}

export interface NavGroup {
  id: string;
  title: string;
  icon: LucideIcon;
  items: NavItem[];
  defaultOpen?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    title: "Overview",
    icon: LayoutDashboard,
    defaultOpen: true,
    items: [
      { title: "Records", url: "/", icon: Database, aliases: ["home", "dashboard", "metadata", "saved records"] },
      { title: "Nudgie", url: "/nudgie", icon: Sparkles, aliases: ["nudges", "suggestions"] },
      { title: "Vault Health", url: "/vault-health", icon: HeartPulse, aliases: ["health check", "diagnostics"] },
    ],
  },
  {
    id: "data",
    title: "Data",
    icon: Database,
    defaultOpen: true,
    items: [
      { title: "Balance", url: "/balance", icon: Wallet, aliases: ["portfolio", "holdings", "funds"] },
      { title: "Transactions", url: "/transactions", icon: LayoutList, aliases: ["tx", "txids", "transaction history"] },
      { title: "UTXOs", url: "/utxos", icon: Coins, aliases: ["coins", "outputs", "unspent outputs"] },
      { title: "UTXO Provenance", url: "/utxo-provenance", icon: Waypoints, aliases: ["coin provenance", "output history"] },
      { title: "Vaults", url: "/vaults", icon: Vault, aliases: ["wallet vaults", "manage vaults"] },
      { title: "Wallet Overview", url: "/wallet-overview", icon: LayoutList, aliases: ["wallets", "wallet summary"] },
      { title: "Bulk Editor", url: "/bulk-editor", icon: Layers, aliases: ["edit many", "bulk edit", "batch edit"] },
      { title: "Conflict Resolution", url: "/conflict-resolution", icon: AlertCircle, aliases: ["conflicts", "resolve conflicts"] },
    ],
  },
  {
    id: "analysis",
    title: "Analysis",
    icon: BarChart3,
    defaultOpen: false,
    items: [
      { title: "Address Checker", url: "/address-checker", icon: Search, aliases: ["check address", "validate address"] },
      { title: "Address Deriver", url: "/address-deriver", icon: KeyRound, aliases: ["derive address", "derive"] },
      { title: "Address Reuse", url: "/address-reuse", icon: Repeat2, aliases: ["reuse", "reused addresses"] },
      { title: "Provenance", url: "/provenance", icon: Map, aliases: ["address provenance"] },
      { title: "Flow Visualizer", url: "/flow-visualizer", icon: Network, aliases: ["flow", "visualize flow"] },
      { title: "Network Analysis", url: "/network-analysis", icon: GitBranch, aliases: ["graph", "network graph"] },
      { title: "Fund Trail", url: "/fund-trail", icon: ChevronsLeftRight, aliases: ["funds trail", "trace funds"] },
      { title: "Data Stats", url: "/data-stats", icon: BarChart3, aliases: ["statistics", "stats"] },
      { title: "Privacy Audit", url: "/privacy-audit", icon: Eye, aliases: ["privacy", "audit"] },
      { title: "Quantum Risk", url: "/quantum-risk", icon: ShieldAlert, aliases: ["quantum", "risk"] },
      { title: "Reports", url: "/reports", icon: ClipboardList, aliases: ["report"] },
      { title: "Statement", url: "/statement", icon: FileText, aliases: ["financial statement"] },
      { title: "Proof of Funds", url: "/proof-of-funds", icon: FileText, aliases: ["pof", "funds proof"] },
      { title: "Annual Activity", url: "/annual-activity", icon: CalendarRange, aliases: ["yearly activity", "annual report"] },
      { title: "Lightning", url: "/lightning-speculator", icon: Zap, aliases: ["lightning network"] },
      { title: "Dusted", url: "/dusted", icon: Droplets, aliases: ["dust", "dust outputs"] },
      { title: "Address Poisoning", url: "/address-poisoning", icon: Biohazard, aliases: ["poisoning", "address poisoning scan"] },
      { title: "Dormant Coins", url: "/dormant-coins", icon: Hourglass, aliases: ["dormant", "inactive coins"] },
    ],
  },
  {
    id: "import-export",
    title: "Import / Export",
    icon: Upload,
    defaultOpen: false,
    items: [
      { title: "Address Importer", url: "/import", icon: Import, aliases: ["import address", "add address", "bulk import"] },
      { title: "Descriptor Import", url: "/descriptor-import", icon: Key, aliases: ["import descriptor", "descriptors"] },
      { title: "BIP-329 Labels", url: "/bip329-import", icon: Tags, aliases: ["labels", "bip329", "import labels"] },
      { title: "Wallet Data Sync", url: "/wallet-import", icon: Wallet, aliases: ["wallet import", "sync wallet"] },
      { title: "Mobile Wallets", url: "/mobile-wallet-import", icon: Smartphone, aliases: ["mobile wallet import"] },
      { title: "Price Import", url: "/price-import", icon: DollarSign, aliases: ["prices", "import prices"] },
      { title: "Transaction Sync", url: "/transaction-sync", icon: ArrowDownUp, aliases: ["sync transactions", "refresh transactions"] },
      { title: "QR Tools", url: "/scanner", icon: QrCode, aliases: ["qr", "scan qr", "scanner"] },
      { title: "Quick Tagger", url: "/quick-tagger", icon: Tags, aliases: ["tag", "tag records"] },
      { title: "Backup", url: "/export", icon: Download, aliases: ["export", "restore", "backup vault"] },
    ],
  },
  {
    id: "documents",
    title: "Documents",
    icon: FileText,
    defaultOpen: false,
    items: [
      { title: "Evidence", url: "/evidence", icon: FileText, aliases: ["documents", "proof", "evidence files"] },
    ],
  },
  {
    id: "system",
    title: "System",
    icon: Settings,
    defaultOpen: false,
    items: [
      { title: "Node Connection", url: "/node-settings", icon: Server, aliases: ["node", "bitcoin node", "connection"] },
      { title: "Value Updater", url: "/value-updater", icon: RefreshCw, aliases: ["update values", "exchange rates"] },
      { title: "Cleanup", url: "/cleanup", icon: Trash2, aliases: ["clean up", "maintenance"] },
      { title: "Engine Diagnostics", url: "/engine-diagnostics", icon: FlaskConical, aliases: ["engine", "database engine"] },
      { title: "Settings", url: "/settings", icon: Settings, aliases: ["preferences", "configuration"] },
    ],
  },
];

export const DEV_TOOLS_GROUP: NavGroup = {
  id: "dev-tools",
  title: "Dev Tools",
  icon: Wrench,
  defaultOpen: false,
  items: [
    { title: "Test Data Seeder", url: "/dev/test-data", icon: Database, aliases: ["seed data", "test data"] },
    { title: "UI Assets", url: "/dev/ui-assets", icon: Palette, aliases: ["assets"] },
    { title: "Icons Reference", url: "/dev/icons", icon: Shapes, aliases: ["icons"] },
    { title: "Nav Patterns", url: "/dev/nav-patterns", icon: PanelLeft, aliases: ["navigation patterns"] },
    { title: "Grouped Sidebar", url: "/dev/grouped-sidebar", icon: LayoutGrid, aliases: ["sidebar preview"] },
    { title: "Flow Visualizations", url: "/dev/flow-viz", icon: Network, aliases: ["flow demos"] },
  ],
};

export function getNavigationItems(includeDevTools = false): NavItem[] {
  const groups = includeDevTools ? [...NAV_GROUPS, DEV_TOOLS_GROUP] : NAV_GROUPS;
  return groups.flatMap((group) => group.items);
}