import { useState, useEffect } from "react";
import { Download, Lock, FileJson, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { db } from "@/lib/database";
import { useAuth } from "@/contexts/AuthContext";
import { decrypt, encrypt, deriveKey, generateSalt, bufferToBase64 } from "@/lib/crypto";

interface ExportData {
  version: string;
  exportDate: string;
  encrypted: boolean;
  salt?: string;
  data: {
    records: any[];
    tags: any[];
    categories: any[];
    attachments: any[];
    recordOrigins: any[];
  };
}

export default function ExportPage() {
  const [encrypted, setEncrypted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [exportComplete, setExportComplete] = useState(false);

  const [recordCount, setRecordCount] = useState(0);
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [tagCount, setTagCount] = useState(0);
  const [categoryCount, setCategoryCount] = useState(0);

  const { encryptionKey } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    const loadCounts = async () => {
      try {
        const records = await db.records.count();
        const attachments = await db.attachments.count();
        const tags = await db.tags.count();
        const categories = await db.categories.count();
        setRecordCount(records);
        setAttachmentCount(attachments);
        setTagCount(tags);
        setCategoryCount(categories);
      } catch (error) {
        console.error("Failed to load counts:", error);
      }
    };
    loadCounts();
  }, []);

  const decryptRecord = async (record: any): Promise<any> => {
    if (!record.isEncrypted || !record.encryptedPayload || !encryptionKey) {
      return record;
    }
    try {
      const decrypted = await decrypt(record.encryptedPayload, encryptionKey);
      const parsed = JSON.parse(decrypted);
      const { encryptedPayload, isEncrypted, ...rest } = record;
      return { ...rest, ...parsed };
    } catch (error) {
      console.error("Failed to decrypt record:", error);
      return record;
    }
  };

  const handleExport = async () => {
    if (encrypted && password !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Passwords Don't Match",
        description: "Please make sure both passwords match.",
      });
      return;
    }

    if (encrypted && password.length < 8) {
      toast({
        variant: "destructive",
        title: "Password Too Short",
        description: "Export password must be at least 8 characters.",
      });
      return;
    }

    setExporting(true);
    setProgress(0);
    setExportComplete(false);

    try {
      setProgressMessage("Gathering records...");
      setProgress(10);

      const rawRecords = await db.records.toArray();
      const rawTags = await db.tags.toArray();
      const rawCategories = await db.categories.toArray();
      const rawAttachments = await db.attachments.toArray();
      const rawOrigins = await db.recordOrigins.toArray();

      setProgress(20);
      setProgressMessage("Decrypting data...");

      const records = await Promise.all(rawRecords.map(decryptRecord));
      setProgress(40);

      const tags = await Promise.all(rawTags.map(decryptRecord));
      const categories = await Promise.all(rawCategories.map(decryptRecord));
      const attachments = await Promise.all(rawAttachments.map(decryptRecord));
      const recordOrigins = await Promise.all(rawOrigins.map(decryptRecord));

      setProgress(60);
      setProgressMessage("Preparing export...");

      const exportData: ExportData = {
        version: "1.0.0",
        exportDate: new Date().toISOString(),
        encrypted: encrypted,
        data: {
          records: records.map(({ encryptedPayload, isEncrypted, ...r }) => r),
          tags: tags.map(({ encryptedPayload, isEncrypted, ...t }) => t),
          categories: categories.map(({ encryptedPayload, isEncrypted, ...c }) => c),
          attachments: attachments.map(({ encryptedPayload, isEncrypted, ...a }) => a),
          recordOrigins: recordOrigins.map(({ encryptedPayload, isEncrypted, ...o }) => o),
        },
      };

      setProgress(80);

      let fileContent: string;
      let fileName: string;

      if (encrypted) {
        setProgressMessage("Encrypting export...");
        const salt = generateSalt();
        const exportKey = await deriveKey(password, salt);
        const dataString = JSON.stringify(exportData.data);
        const encryptedData = await encrypt(dataString, exportKey);

        const encryptedExport = {
          version: exportData.version,
          exportDate: exportData.exportDate,
          encrypted: true,
          salt: bufferToBase64(salt),
          data: encryptedData,
        };

        fileContent = JSON.stringify(encryptedExport, null, 2);
        fileName = `kybtc-backup-encrypted-${new Date().toISOString().split('T')[0]}.json`;
      } else {
        fileContent = JSON.stringify(exportData, null, 2);
        fileName = `kybtc-backup-${new Date().toISOString().split('T')[0]}.json`;
      }

      setProgress(90);
      setProgressMessage("Creating download...");

      const blob = new Blob([fileContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setProgress(100);
      setProgressMessage("Export complete!");
      setExportComplete(true);

      toast({
        title: "Export Successful",
        description: `Your backup "${fileName}" has been downloaded.`,
      });

    } catch (error) {
      console.error("Export failed:", error);
      toast({
        variant: "destructive",
        title: "Export Failed",
        description: error instanceof Error ? error.message : "Failed to export data",
      });
    } finally {
      setExporting(false);
    }
  };

  const estimatedSize = () => {
    const estimate = (recordCount * 500) + (attachmentCount * 100) + (tagCount * 50) + (categoryCount * 50);
    if (estimate < 1024) return `${estimate} B`;
    if (estimate < 1024 * 1024) return `${(estimate / 1024).toFixed(1)} KB`;
    return `${(estimate / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Export Data</h1>
          <p className="text-muted-foreground">
            Download your Bitcoin records and metadata as a backup file
          </p>
        </div>

        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Export includes all records, tags, categories, and attachment metadata. 
            The backup file will be downloaded to your browser's default download location.
          </AlertDescription>
        </Alert>

        {exportComplete && (
          <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700 dark:text-green-300">
              Export complete! Check your Downloads folder for the backup file.
            </AlertDescription>
          </Alert>
        )}

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
                  Protect your backup with a separate password
                </p>
              </div>
              <Switch
                checked={encrypted}
                onCheckedChange={setEncrypted}
                data-testid="switch-encrypt"
              />
            </div>

            {encrypted && (
              <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
                <div className="flex items-center gap-2 mb-3">
                  <Lock className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">
                    Export Encryption Password
                  </span>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter a strong password (min 8 characters)"
                    data-testid="input-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    data-testid="input-confirm-password"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  You'll need this password to import the backup. Store it securely.
                </p>
              </div>
            )}

            {exporting && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{progressMessage}</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} />
              </div>
            )}

            <Button
              className="w-full"
              size="lg"
              onClick={handleExport}
              disabled={exporting || (encrypted && (!password || password !== confirmPassword || password.length < 8))}
              data-testid="button-export"
            >
              <Download className="h-4 w-4 mr-2" />
              {exporting ? "Exporting..." : "Export & Download Backup"}
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
              <span className="font-medium" data-testid="text-record-count">{recordCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Tags</span>
              <span className="font-medium" data-testid="text-tag-count">{tagCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Categories</span>
              <span className="font-medium" data-testid="text-category-count">{categoryCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Attachments</span>
              <span className="font-medium" data-testid="text-attachment-count">{attachmentCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Estimated Size</span>
              <span className="font-medium" data-testid="text-file-size">{estimatedSize()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Format</span>
              <span className="font-medium">JSON</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
