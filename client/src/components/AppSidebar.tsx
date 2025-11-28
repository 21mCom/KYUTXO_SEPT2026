import { Database, FileText, Settings, Upload, Download, QrCode, Key, RefreshCw, Wallet } from "lucide-react";
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
import { Link, useLocation } from "wouter";

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
    title: "Wallet Import",
    url: "/wallet-import",
    icon: Wallet,
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
    title: "Export Data",
    url: "/export",
    icon: Download,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
];

export function AppSidebar() {
  const [location] = useLocation();

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
