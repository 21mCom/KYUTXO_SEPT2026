import { Settings, Moon, Eye, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Settings</h1>
          <p className="text-muted-foreground">
            Configure your KYBTC application preferences
          </p>
        </div>

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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Field Visibility
            </CardTitle>
            <CardDescription>
              Choose which fields to show in forms and tables
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Show Seed Name</Label>
              <Switch defaultChecked data-testid="switch-seed" />
            </div>
            <div className="flex items-center justify-between">
              <Label>Show Wallet Software</Label>
              <Switch defaultChecked data-testid="switch-wallet" />
            </div>
            <div className="flex items-center justify-between">
              <Label>Show Counterparty</Label>
              <Switch defaultChecked data-testid="switch-counterparty" />
            </div>
            <div className="flex items-center justify-between">
              <Label>Show Private Key Status</Label>
              <Switch data-testid="switch-private-key" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Storage
            </CardTitle>
            <CardDescription>
              Information about local data storage
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Storage Type</span>
              <Badge variant="secondary">IndexedDB (Offline)</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Data Location</span>
              <span className="text-sm font-mono">Local Device</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Storage Used</span>
              <span className="text-sm font-medium" data-testid="text-storage">2.1 MB</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>About KYBTC</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Version</span>
              <span className="font-medium">1.0.0</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Type</span>
              <Badge variant="outline">Progressive Web App</Badge>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Privacy</span>
              <span className="font-medium">All data stored locally</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
