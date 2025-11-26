import { useState } from "react";
import { Download, Lock, FileJson, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";

export default function ExportPage() {
  const [encrypted, setEncrypted] = useState(false);
  const [password, setPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleExport = () => {
    setExporting(true);
    setProgress(0);
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setExporting(false);
          alert("Export complete!");
          return 100;
        }
        return prev + 20;
      });
    }, 300);
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Export Data</h1>
          <p className="text-muted-foreground">
            Download your Bitcoin records and metadata in encrypted format
          </p>
        </div>

        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Export includes all records, tags, categories, and file attachments. Store the export file securely.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileJson className="h-5 w-5" />
              Export Configuration
            </CardTitle>
            <CardDescription>
              Configure your data export options
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base">Encrypt Export</Label>
                <p className="text-sm text-muted-foreground">
                  Protect your data with password-based encryption
                </p>
              </div>
              <Switch
                checked={encrypted}
                onCheckedChange={setEncrypted}
                data-testid="switch-encrypt"
              />
            </div>

            {encrypted && (
              <div className="space-y-2 p-4 border rounded-lg bg-muted/50">
                <div className="flex items-center gap-2 mb-3">
                  <Lock className="h-4 w-4 text-primary" />
                  <Label htmlFor="password" className="text-sm font-medium">
                    Encryption Password
                  </Label>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter a strong password"
                  data-testid="input-password"
                />
                <p className="text-xs text-muted-foreground">
                  Use a strong password. You'll need this to import the data later.
                </p>
              </div>
            )}

            {exporting && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Preparing export...</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} />
              </div>
            )}

            <Button
              className="w-full"
              size="lg"
              onClick={handleExport}
              disabled={exporting || (encrypted && !password)}
              data-testid="button-export"
            >
              <Download className="h-4 w-4 mr-2" />
              {exporting ? "Exporting..." : "Export Data"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Export Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Records</span>
              <span className="font-medium" data-testid="text-record-count">25</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Attachments</span>
              <span className="font-medium" data-testid="text-attachment-count">12</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Estimated Size</span>
              <span className="font-medium" data-testid="text-file-size">2.4 MB</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Format</span>
              <span className="font-medium">JSON + Base64 attachments</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
