import { useState, useEffect } from "react";
import { Download, Lock, FileJson, AlertCircle, CheckCircle2, FolderOpen, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { db, type Record } from "@/lib/database";
import { useAuth } from "@/contexts/AuthContext";
import { decrypt, encrypt, deriveKey, generateSalt, bufferToBase64 } from "@/lib/crypto";
import { isElectron } from "@/lib/electron";
import JSZip from "jszip";

interface CustomFieldDef {
  id?: number;
  name: string;
  slug: string;
  enabled: boolean;
  createdAt: number;
}

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
    customFields: CustomFieldDef[];
  };
}

function escapeCSVField(value: any): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function generateRecordsCSV(records: any[], attachments: any[], customFields: CustomFieldDef[]): string {
  // Static headers
  const staticHeaders = [
    "id",
    "type",
    "inputString",
    "label",
    "notes",
    "amount",
    "date",
    "tags",
    "categories",
    "attachments",
    "seedName",
    "walletSoftware",
    "privateKeyStatus",
    "owner",
    "walletName",
    "source",
    "chainType",
    "derivationPath",
    "xpub",
    "isVaultXpub",
    "vaultName",
    "vaultM",
    "vaultN",
    "vaultNotes",
    "createdAt",
    "updatedAt",
  ];

  // Add custom field headers (sorted by name for consistency)
  const sortedCustomFields = [...customFields].sort((a, b) => a.name.localeCompare(b.name));
  const customFieldHeaders = sortedCustomFields.map(f => `custom:${f.name}`);
  const headers = [...staticHeaders, ...customFieldHeaders];

  // Build a map of recordId -> attachment filenames for quick lookup
  const attachmentsByRecord = new Map<number, string[]>();
  for (const att of attachments) {
    if (att.recordId) {
      const existing = attachmentsByRecord.get(att.recordId) || [];
      existing.push(att.filename);
      attachmentsByRecord.set(att.recordId, existing);
    }
  }

  const rows = records.map((record) => {
    const recordAttachments = attachmentsByRecord.get(record.id) || [];
    const staticValues = [
      escapeCSVField(record.id),
      escapeCSVField(record.type),
      escapeCSVField(record.inputString),
      escapeCSVField(record.label),
      escapeCSVField(record.notes),
      escapeCSVField(record.amount),
      escapeCSVField(record.date),
      escapeCSVField(record.tags?.join(";") || ""),
      escapeCSVField(record.categories?.join(";") || ""),
      escapeCSVField(recordAttachments.join(";") || ""),
      escapeCSVField(record.seedName),
      escapeCSVField(record.walletSoftware),
      escapeCSVField(record.privateKeyStatus),
      escapeCSVField(record.owner),
      escapeCSVField(record.walletName),
      escapeCSVField(record.source),
      escapeCSVField(record.chainType),
      escapeCSVField(record.derivationPath),
      escapeCSVField(record.xpub),
      escapeCSVField(record.vault?.isVaultXpub),
      escapeCSVField(record.vault?.vaultName),
      escapeCSVField(record.vault?.m),
      escapeCSVField(record.vault?.n),
      escapeCSVField(record.vault?.vaultNotes),
      escapeCSVField(record.createdAt ? new Date(record.createdAt).toISOString() : ""),
      escapeCSVField(record.updatedAt ? new Date(record.updatedAt).toISOString() : ""),
    ];

    // Add custom field values in same order as headers
    const customFieldValues = sortedCustomFields.map(f => 
      escapeCSVField(record.customFields?.[f.slug] || "")
    );

    return [...staticValues, ...customFieldValues].join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

function generateTagsCSV(tags: any[]): string {
  const headers = ["id", "name", "color", "createdAt"];
  const rows = tags.map((tag) => [
    escapeCSVField(tag.id),
    escapeCSVField(tag.name),
    escapeCSVField(tag.color),
    escapeCSVField(tag.createdAt ? new Date(tag.createdAt).toISOString() : ""),
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
}

function generateCategoriesCSV(categories: any[]): string {
  const headers = ["id", "name", "createdAt"];
  const rows = categories.map((cat) => [
    escapeCSVField(cat.id),
    escapeCSVField(cat.name),
    escapeCSVField(cat.createdAt ? new Date(cat.createdAt).toISOString() : ""),
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
}

function generateAttachmentsCSV(attachments: any[]): string {
  const headers = ["id", "recordId", "filename", "mimeType", "size", "objectStoragePath", "createdAt"];
  const rows = attachments.map((att) => [
    escapeCSVField(att.id),
    escapeCSVField(att.recordId),
    escapeCSVField(att.filename),
    escapeCSVField(att.mimeType),
    escapeCSVField(att.size),
    escapeCSVField(att.objectStoragePath),
    escapeCSVField(att.createdAt ? new Date(att.createdAt).toISOString() : ""),
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
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

  const attachmentsFolderPath = isElectron() 
    ? "User Data Folder → data/attachments/" 
    : "data/attachments/";

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
      const rawCustomFields = await db.customFields.toArray();

      setProgress(20);
      setProgressMessage("Decrypting data...");

      const records = await Promise.all(rawRecords.map(decryptRecord));
      setProgress(35);

      const tags = await Promise.all(rawTags.map(decryptRecord));
      const categories = await Promise.all(rawCategories.map(decryptRecord));
      const attachments = await Promise.all(rawAttachments.map(decryptRecord));
      const recordOrigins = await Promise.all(rawOrigins.map(decryptRecord));

      setProgress(50);
      setProgressMessage("Generating CSV files...");

      const cleanRecords = records.map(({ encryptedPayload, isEncrypted, ...r }) => r);
      const cleanTags = tags.map(({ encryptedPayload, isEncrypted, ...t }) => t);
      const cleanCategories = categories.map(({ encryptedPayload, isEncrypted, ...c }) => c);
      const cleanAttachments = attachments.map(({ encryptedPayload, isEncrypted, ...a }) => a);
      const cleanOrigins = recordOrigins.map(({ encryptedPayload, isEncrypted, ...o }) => o);
      const customFields = rawCustomFields as CustomFieldDef[];

      const recordsCSV = generateRecordsCSV(cleanRecords, cleanAttachments, customFields);
      const tagsCSV = generateTagsCSV(cleanTags);
      const categoriesCSV = generateCategoriesCSV(cleanCategories);
      const attachmentsCSV = generateAttachmentsCSV(cleanAttachments);

      setProgress(65);
      setProgressMessage("Creating ZIP archive...");

      const exportData: ExportData = {
        version: "1.0.0",
        exportDate: new Date().toISOString(),
        encrypted: encrypted,
        data: {
          records: cleanRecords,
          tags: cleanTags,
          categories: cleanCategories,
          attachments: cleanAttachments,
          recordOrigins: cleanOrigins,
          customFields: customFields,
        },
      };

      const zip = new JSZip();
      const dateStr = new Date().toISOString().split('T')[0];

      if (encrypted) {
        setProgress(75);
        setProgressMessage("Encrypting data...");
        
        const salt = generateSalt();
        const exportKey = await deriveKey(password, salt);
        
        const encryptedJson = await encrypt(JSON.stringify(exportData.data), exportKey);
        const encryptedRecordsCSV = await encrypt(recordsCSV, exportKey);
        const encryptedTagsCSV = await encrypt(tagsCSV, exportKey);
        const encryptedCategoriesCSV = await encrypt(categoriesCSV, exportKey);
        const encryptedAttachmentsCSV = await encrypt(attachmentsCSV, exportKey);

        const encryptedExport = {
          version: exportData.version,
          exportDate: exportData.exportDate,
          encrypted: true,
          salt: bufferToBase64(salt),
          data: encryptedJson,
        };

        zip.file("backup.json", JSON.stringify(encryptedExport, null, 2));
        zip.file("records.csv.encrypted", encryptedRecordsCSV);
        zip.file("tags.csv.encrypted", encryptedTagsCSV);
        zip.file("categories.csv.encrypted", encryptedCategoriesCSV);
        zip.file("attachments.csv.encrypted", encryptedAttachmentsCSV);
        zip.file("README.txt", `KYBTC Encrypted Backup
========================
Export Date: ${exportData.exportDate}
Version: ${exportData.version}

This backup is encrypted with AES-256-GCM.
You will need your export password to import this backup.

Files:
- backup.json: Full encrypted database export
- records.csv.encrypted: Encrypted records spreadsheet
- tags.csv.encrypted: Encrypted tags list
- categories.csv.encrypted: Encrypted categories list
- attachments.csv.encrypted: Encrypted attachment metadata

Note: File attachments are NOT included in this backup.
They are stored separately in: ${attachmentsFolderPath}
`);

      } else {
        zip.file("backup.json", JSON.stringify(exportData, null, 2));
        zip.file("records.csv", recordsCSV);
        zip.file("tags.csv", tagsCSV);
        zip.file("categories.csv", categoriesCSV);
        zip.file("attachments.csv", attachmentsCSV);
        zip.file("README.txt", `KYBTC Backup
========================
Export Date: ${exportData.exportDate}
Version: ${exportData.version}

This backup is NOT encrypted. Store it securely.

Files:
- backup.json: Full database export (JSON format)
- records.csv: Records spreadsheet (can open in Excel/Google Sheets)
- tags.csv: Tags list
- categories.csv: Categories list
- attachments.csv: Attachment metadata

Note: File attachments are NOT included in this backup.
They are stored separately in: ${attachmentsFolderPath}
`);
      }

      setProgress(85);
      setProgressMessage("Compressing ZIP file...");

      const zipBlob = await zip.generateAsync({ 
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      });

      setProgress(95);
      setProgressMessage("Downloading...");

      const fileName = encrypted 
        ? `kybtc-backup-encrypted-${dateStr}.zip`
        : `kybtc-backup-${dateStr}.zip`;

      const url = URL.createObjectURL(zipBlob);
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
          <h1 className="text-3xl font-bold mb-2">Backup</h1>
          <p className="text-muted-foreground">
            Download your Bitcoin records and metadata as a backup ZIP file
          </p>
        </div>

        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Export includes all records, tags, categories, and attachment metadata in both JSON and CSV formats.
            The backup will be downloaded as a ZIP file to your browser's default download location.
          </AlertDescription>
        </Alert>

        {exportComplete && (
          <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700 dark:text-green-300">
              Export complete! Check your Downloads folder for the backup ZIP file.
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
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              What's Included
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm space-y-2">
              <p className="font-medium">The ZIP file contains:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
                <li><code className="text-xs bg-muted px-1 rounded">backup.json</code> - Complete database in JSON format</li>
                <li><code className="text-xs bg-muted px-1 rounded">records.csv</code> - Records spreadsheet (Excel/Sheets compatible)</li>
                <li><code className="text-xs bg-muted px-1 rounded">tags.csv</code> - Tags list</li>
                <li><code className="text-xs bg-muted px-1 rounded">categories.csv</code> - Categories list</li>
                <li><code className="text-xs bg-muted px-1 rounded">attachments.csv</code> - Attachment metadata</li>
              </ul>
            </div>
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
              <span className="font-medium">ZIP (JSON + CSV)</span>
            </div>
          </CardContent>
        </Card>

        {attachmentCount > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="h-5 w-5" />
                File Attachments
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                File attachments are stored separately and are not included in this backup. 
                To backup your attachments, manually copy the attachments folder:
              </p>
              <div className="p-3 bg-muted rounded-lg font-mono text-sm break-all" data-testid="text-attachments-path">
                {attachmentsFolderPath}
              </div>
              <p className="text-xs text-muted-foreground">
                In the desktop app, this will be inside your user data folder. 
                Attachment files are encrypted and can only be read by the application.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
