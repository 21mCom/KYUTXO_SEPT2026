import { ChevronDown } from "lucide-react";
import logoUrl from "@/assets/foot_1764929618997.png";
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
import { useLiveQuery } from "dexie-react-hooks";
import { countActionableTransactionCurations } from "@/lib/data/transaction-crud";
import { ActivityMonitorPanel } from "@/components/ActivityMonitorPanel";
import { DEV_TOOLS_GROUP, NAV_GROUPS, type NavGroup } from "@/config/navigation";

export function AppSidebar() {
  const [location] = useLocation();
  const inboxCount = useLiveQuery(() => countActionableTransactionCurations(), [], 0);
  
  const getInitialOpenState = () => {
    const state: Record<string, boolean> = {};
    
    NAV_GROUPS.forEach(group => {
      const hasActiveItem = group.items.some(item => location === item.url);
      state[group.id] = hasActiveItem || (group.defaultOpen ?? false);
    });
    
    const devToolsActive = location.startsWith("/dev/");
    state[DEV_TOOLS_GROUP.id] = devToolsActive || (DEV_TOOLS_GROUP.defaultOpen ?? false);
    
    return state;
  };

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(getInitialOpenState);

  useEffect(() => {
    setOpenGroups(prev => {
      const newState = { ...prev };
      
      NAV_GROUPS.forEach(group => {
        const hasActiveItem = group.items.some(item => location === item.url);
        if (hasActiveItem && !prev[group.id]) {
          newState[group.id] = true;
        }
      });
      
      const devToolsActive = location.startsWith("/dev/");
      if (devToolsActive && !prev[DEV_TOOLS_GROUP.id]) {
        newState[DEV_TOOLS_GROUP.id] = true;
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
                      {item.badge === "transaction-inbox" && inboxCount > 0 && (
                        <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground" data-testid="badge-transaction-inbox-count">
                          {inboxCount > 999 ? "999+" : inboxCount}
                        </span>
                      )}
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
          {NAV_GROUPS.map(renderGroup)}
          {import.meta.env.DEV && renderGroup(DEV_TOOLS_GROUP)}
        </div>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <ActivityMonitorPanel />
        <div className="text-xs text-muted-foreground mt-2">
          <p>Offline-first PWA</p>
          <p className="mt-1">All data stored locally</p>
          <p className="mt-1">v{__APP_VERSION__}</p>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
