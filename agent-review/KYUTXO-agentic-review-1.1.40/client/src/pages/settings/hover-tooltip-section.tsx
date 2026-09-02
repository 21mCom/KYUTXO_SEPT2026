import { Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useSettings, updateHoverTooltipPrefs } from "@/hooks/use-settings";

export function HoverTooltipSection() {
  const { hoverTooltipPrefs, isLoading: settingsLoading } = useSettings();
  const { toast } = useToast();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-5 w-5" />
          Address &amp; Transaction Hover
        </CardTitle>
        <CardDescription>
          Choose which metadata fields appear when hovering an address or transaction ID.
          Only non-blank fields are shown. System tags (e.g.{" "}
          <code className="text-xs">quantum:*</code>) can be included or excluded separately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(
          [
            { key: "showLabel", label: "Label" },
            { key: "showWalletName", label: "Wallet Name" },
            { key: "showOwner", label: "Owner" },
            { key: "showSeedName", label: "Seed Name" },
            { key: "showSoftware", label: "Software" },
            { key: "showCategory", label: "Category" },
            { key: "showTags", label: "Tags" },
            { key: "showPrivateKeyStatus", label: "Private Key Status" },
            { key: "showNotes", label: "Notes" },
          ] as Array<{ key: keyof typeof hoverTooltipPrefs; label: string }>
        ).map(({ key, label }) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <Label htmlFor={`hover-toggle-${key}`} className="text-sm cursor-pointer">
              {label}
            </Label>
            <Switch
              id={`hover-toggle-${key}`}
              checked={hoverTooltipPrefs[key]}
              onCheckedChange={async (checked) => {
                try {
                  await updateHoverTooltipPrefs({ [key]: checked });
                } catch {
                  toast({ title: "Error", description: "Failed to update hover setting", variant: "destructive" });
                }
              }}
              disabled={settingsLoading}
              data-testid={`switch-hover-${key}`}
            />
          </div>
        ))}
        <Separator />
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="hover-toggle-systemtags" className="text-sm cursor-pointer">
              Include system tags
            </Label>
            <p className="text-xs text-muted-foreground">
              Show namespace-prefixed tags such as{" "}
              <code className="text-xs">quantum:critical</code> in the hover tooltip and
              count them toward the metadata indicator.
            </p>
          </div>
          <Switch
            id="hover-toggle-systemtags"
            checked={hoverTooltipPrefs.includeSystemTags}
            onCheckedChange={async (checked) => {
              try {
                await updateHoverTooltipPrefs({ includeSystemTags: checked });
              } catch {
                toast({ title: "Error", description: "Failed to update hover setting", variant: "destructive" });
              }
            }}
            disabled={settingsLoading}
            data-testid="switch-hover-includeSystemTags"
          />
        </div>
      </CardContent>
    </Card>
  );
}
