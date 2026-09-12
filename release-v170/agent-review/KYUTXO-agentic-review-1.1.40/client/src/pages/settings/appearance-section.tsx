import { useState } from "react";
import { Moon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getSearchFadePreference,
  setSearchFadePreference,
  SEARCH_FADE_OPTIONS,
  type SearchFadeOption,
} from "@/config/debounce";
import { useActivityBus } from "@/lib/activity-bus";

export function AppearanceSection() {
  const { toast } = useToast();
  const [searchFadeIntensity, setSearchFadeIntensity] = useState<SearchFadeOption>(getSearchFadePreference);
  const { monitorEnabled, setMonitorEnabled } = useActivityBus();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Moon className="h-5 w-5" />
          Appearance
        </CardTitle>
        <CardDescription>
          Customize the look and feel of the application
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Dark Mode</Label>
            <p className="text-sm text-muted-foreground">
              Switch between light and dark theme
            </p>
          </div>
          <ThemeToggle />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Activity Monitor</Label>
            <p className="text-sm text-muted-foreground">
              Show a live activity indicator in the header and sidebar
            </p>
          </div>
          <Switch
            checked={monitorEnabled}
            onCheckedChange={setMonitorEnabled}
            data-testid="toggle-activity-monitor"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-base">Search Fade Intensity</Label>
            <p className="text-sm text-muted-foreground">
              How much the results dim while a search is in progress
            </p>
          </div>
          <Select
            value={searchFadeIntensity}
            onValueChange={(val) => {
              setSearchFadeIntensity(val as SearchFadeOption);
              setSearchFadePreference(val as SearchFadeOption);
              toast({
                title: "Search fade updated",
                description: SEARCH_FADE_OPTIONS.find(o => o.value === val)?.label ?? val,
              });
            }}
          >
            <SelectTrigger className="w-[200px]" data-testid="select-search-fade">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEARCH_FADE_OPTIONS.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  data-testid={`option-fade-${opt.value}`}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
