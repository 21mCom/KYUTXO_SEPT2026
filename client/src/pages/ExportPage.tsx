import { useState, useEffect } from "react";
import { Download, Lock, FileJson, AlertCircle, CheckCircle2, FolderOpen, FileSpreadsheet, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { db, type Record } from "@/lib/database";
import { encrypt, deriveKey, generateSalt, bufferToBase64 } from "@/lib/crypto";
import { isElectron, getElectronAPI } from "@/lib/electron";
import JSZip from "jszip";

// Helper to list all attachment files
async function listAllAttachmentFiles(): Promise<string[]> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.listAllAttachments();
    return result.success ? (result.files || []) : [];
  } else {
    const response = await fetch('/api/attachments/list-all');
    if (response.ok) {
      const data = await response.json();
      return data.success ? (data.files || []) : [];
    }
    return [];
  }
}

// Helper to read an attachment file
async function readAttachmentFile(relativePath: string): Promise<ArrayBuffer | null> {
  if (isElectron()) {
    const api = getElectronAPI();
    const result = await api.readAttachment(relativePath);
    return result.success ? (result.data || null) : null;
  } else {
    const response = await fetch(`/api/attachments/download/attachments/${relativePath}`);
    if (response.ok) {
      return await response.arrayBuffer();
    }
    return null;
  }
}

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
    owners: any[];
    walletNames: any[];
    seedNames: any[];
    walletSoftware: any[];
    derivationTemplates: any[];
    evidence: any[];
    evidenceAttachments: any[];
    priceData: any[];
    settings: any[];
    nodeSettings: any[];
    utxoLineage: any[];
    custodySegments: any[];
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

function generateOwnersCSV(owners: any[]): string {
  const headers = ["id", "name", "createdAt"];
  const rows = owners.map((owner) => [
    escapeCSVField(owner.id),
    escapeCSVField(owner.name),
    escapeCSVField(owner.createdAt ? new Date(owner.createdAt).toISOString() : ""),
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
}

function generateWalletNamesCSV(walletNames: any[]): string {
  const headers = ["id", "name", "createdAt"];
  const rows = walletNames.map((wn) => [
    escapeCSVField(wn.id),
    escapeCSVField(wn.name),
    escapeCSVField(wn.createdAt ? new Date(wn.createdAt).toISOString() : ""),
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
}

function generateSeedNamesCSV(seedNames: any[]): string {
  const headers = ["id", "name", "createdAt"];
  const rows = seedNames.map((sn) => [
    escapeCSVField(sn.id),
    escapeCSVField(sn.name),
    escapeCSVField(sn.createdAt ? new Date(sn.createdAt).toISOString() : ""),
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
}

function generateWalletSoftwareCSV(walletSoftware: any[]): string {
  const headers = ["id", "name", "createdAt"];
  const rows = walletSoftware.map((ws) => [
    escapeCSVField(ws.id),
    escapeCSVField(ws.name),
    escapeCSVField(ws.createdAt ? new Date(ws.createdAt).toISOString() : ""),
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
}

function generateDerivationTemplatesCSV(templates: any[]): string {
  const headers = ["id", "fingerprint", "scriptType", "derivationPath", "xpub", "gapLimit", "network", "owner", "walletName", "seedName", "notes", "createdAt", "updatedAt"];
  const rows = templates.map((t) => [
    escapeCSVField(t.id),
    escapeCSVField(t.fingerprint),
    escapeCSVField(t.scriptType),
    escapeCSVField(t.derivationPath),
    escapeCSVField(t.xpub),
    escapeCSVField(t.gapLimit),
    escapeCSVField(t.network),
    escapeCSVField(t.owner),
    escapeCSVField(t.walletName),
    escapeCSVField(t.seedName),
    escapeCSVField(t.notes),
    escapeCSVField(t.createdAt ? new Date(t.createdAt).toISOString() : ""),
    escapeCSVField(t.updatedAt ? new Date(t.updatedAt).toISOString() : ""),
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
  const [vocabularyCount, setVocabularyCount] = useState(0);
  const [derivationTemplateCount, setDerivationTemplateCount] = useState(0);

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
        const owners = await db.owners.count();
        const walletNames = await db.walletNames.count();
        const seedNames = await db.seedNames.count();
        const walletSoftware = await db.walletSoftware.count();
        const derivationTemplates = await db.derivationTemplates.count();
        setRecordCount(records);
        setAttachmentCount(attachments);
        setTagCount(tags);
        setCategoryCount(categories);
        setVocabularyCount(owners + walletNames + seedNames + walletSoftware);
        setDerivationTemplateCount(derivationTemplates);
      } catch (error) {
        console.error("Failed to load counts:", error);
      }
    };
    loadCounts();
  }, []);

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

      const EXPORT_BATCH = 1000;
      const rawRecords: Record[] = [];
      let lastRecordId = 0;
      while (true) {
        const batch = await db.records.where('id').above(lastRecordId).limit(EXPORT_BATCH).toArray();
        if (batch.length === 0) break;
        rawRecords.push(...batch);
        const lastItem = batch[batch.length - 1];
        if (!lastItem.id) break;
        lastRecordId = lastItem.id;
      }

      const rawTags = await db.tags.toArray();
      const rawCategories = await db.categories.toArray();
      const rawAttachments = await db.attachments.toArray();
      const rawOrigins = await db.recordOrigins.toArray();
      const rawCustomFields = await db.customFields.toArray();
      const rawOwners = await db.owners.toArray();
      const rawWalletNames = await db.walletNames.toArray();
      const rawSeedNames = await db.seedNames.toArray();
      const rawWalletSoftware = await db.walletSoftware.toArray();
      const rawDerivationTemplates = await db.derivationTemplates.toArray();
      const rawEvidence = await db.evidence.toArray();
      const rawEvidenceAttachments = await db.evidenceAttachments.toArray();
      const rawPriceData = await db.priceData.toArray();
      const rawSettings = await db.settings.toArray();
      const rawNodeSettings = await db.nodeSettings.toArray();
      const rawUtxoLineage = await db.utxoLineage.toArray();
      const rawCustodySegments = await db.custodySegments.toArray();

      setProgress(20);
      setProgressMessage("Generating CSV files...");

      const customFields = rawCustomFields as CustomFieldDef[];

      const recordsCSV = generateRecordsCSV(rawRecords, rawAttachments, customFields);
      const tagsCSV = generateTagsCSV(rawTags);
      const categoriesCSV = generateCategoriesCSV(rawCategories);
      const attachmentsCSV = generateAttachmentsCSV(rawAttachments);
      const ownersCSV = generateOwnersCSV(rawOwners);
      const walletNamesCSV = generateWalletNamesCSV(rawWalletNames);
      const seedNamesCSV = generateSeedNamesCSV(rawSeedNames);
      const walletSoftwareCSV = generateWalletSoftwareCSV(rawWalletSoftware);
      const derivationTemplatesCSV = generateDerivationTemplatesCSV(rawDerivationTemplates);

      setProgress(55);
      setProgressMessage("Gathering attachment files...");

      // List and read all attachment files
      const attachmentFilePaths = await listAllAttachmentFiles();
      const attachmentFiles: { path: string; data: ArrayBuffer }[] = [];
      
      for (let i = 0; i < attachmentFilePaths.length; i++) {
        const filePath = attachmentFilePaths[i];
        setProgressMessage(`Reading attachment ${i + 1} of ${attachmentFilePaths.length}...`);
        
        const fileData = await readAttachmentFile(filePath);
        if (fileData) {
          attachmentFiles.push({ path: filePath, data: fileData });
        }
      }

      setProgress(65);
      setProgressMessage("Creating ZIP archive...");

      const exportData: ExportData = {
        version: "2.2.0",
        exportDate: new Date().toISOString(),
        encrypted: encrypted,
        data: {
          records: rawRecords,
          tags: rawTags,
          categories: rawCategories,
          attachments: rawAttachments,
          recordOrigins: rawOrigins,
          customFields: customFields,
          owners: rawOwners,
          walletNames: rawWalletNames,
          seedNames: rawSeedNames,
          walletSoftware: rawWalletSoftware,
          derivationTemplates: rawDerivationTemplates,
          evidence: rawEvidence,
          evidenceAttachments: rawEvidenceAttachments,
          priceData: rawPriceData,
          settings: rawSettings,
          nodeSettings: rawNodeSettings,
          utxoLineage: rawUtxoLineage,
          custodySegments: rawCustodySegments,
        },
      };

      const zip = new JSZip();
      const dateStr = new Date().toISOString().split('T')[0];
      
      // Add attachment files to ZIP under attachments/ folder
      const attachmentsFolder = zip.folder("attachments");
      for (const file of attachmentFiles) {
        attachmentsFolder?.file(file.path, file.data);
      }

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
        const encryptedOwnersCSV = await encrypt(ownersCSV, exportKey);
        const encryptedWalletNamesCSV = await encrypt(walletNamesCSV, exportKey);
        const encryptedSeedNamesCSV = await encrypt(seedNamesCSV, exportKey);
        const encryptedWalletSoftwareCSV = await encrypt(walletSoftwareCSV, exportKey);
        const encryptedDerivationTemplatesCSV = await encrypt(derivationTemplatesCSV, exportKey);

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
        zip.file("owners.csv.encrypted", encryptedOwnersCSV);
        zip.file("wallet_names.csv.encrypted", encryptedWalletNamesCSV);
        zip.file("seed_names.csv.encrypted", encryptedSeedNamesCSV);
        zip.file("wallet_software.csv.encrypted", encryptedWalletSoftwareCSV);
        zip.file("derivation_templates.csv.encrypted", encryptedDerivationTemplatesCSV);
        zip.file("README.txt", `KYUTXO Encrypted Backup
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
- owners.csv.encrypted: Encrypted owners vocabulary
- wallet_names.csv.encrypted: Encrypted wallet names vocabulary
- seed_names.csv.encrypted: Encrypted seed names vocabulary
- wallet_software.csv.encrypted: Encrypted wallet software vocabulary
- derivation_templates.csv.encrypted: Encrypted derivation templates
- attachments/: Folder containing ${attachmentFiles.length} attachment file(s)

Note: Attachment files are included in this backup and stored unencrypted. 
They will be restored automatically when you import this backup. 
Keep this backup in a secure location.
`);

      } else {
        zip.file("backup.json", JSON.stringify(exportData, null, 2));
        zip.file("records.csv", recordsCSV);
        zip.file("tags.csv", tagsCSV);
        zip.file("categories.csv", categoriesCSV);
        zip.file("attachments.csv", attachmentsCSV);
        zip.file("owners.csv", ownersCSV);
        zip.file("wallet_names.csv", walletNamesCSV);
        zip.file("seed_names.csv", seedNamesCSV);
        zip.file("wallet_software.csv", walletSoftwareCSV);
        zip.file("derivation_templates.csv", derivationTemplatesCSV);
        zip.file("README.txt", `KYUTXO Backup
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
- owners.csv: Owners vocabulary
- wallet_names.csv: Wallet names vocabulary
- seed_names.csv: Seed names vocabulary
- wallet_software.csv: Wallet software vocabulary
- derivation_templates.csv: Derivation templates
- attachments/: Folder containing ${attachmentFiles.length} attachment file(s)

Note: Attachment files are included in this backup and stored unencrypted.
They will be restored automatically when you import this backup.
Keep this backup in a secure location.
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
        ? `kyutxo-backup-encrypted-${dateStr}.zip`
        : `kyutxo-backup-${dateStr}.zip`;

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

            {!encrypted && (
              <Alert variant="destructive" data-testid="alert-unencrypted-export">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Your backup will contain unencrypted plaintext data including Bitcoin addresses, transaction IDs, labels, notes, wallet names, owner information, and financial data. Anyone who obtains this file can read all of its contents. Consider enabling encryption above or storing the exported file in a secure location.
                </AlertDescription>
              </Alert>
            )}

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
                <li><code className="text-xs bg-muted px-1 rounded">owners.csv</code> - Owners vocabulary</li>
                <li><code className="text-xs bg-muted px-1 rounded">wallet_names.csv</code> - Wallet names vocabulary</li>
                <li><code className="text-xs bg-muted px-1 rounded">seed_names.csv</code> - Seed names vocabulary</li>
                <li><code className="text-xs bg-muted px-1 rounded">wallet_software.csv</code> - Wallet software vocabulary</li>
                <li><code className="text-xs bg-muted px-1 rounded">derivation_templates.csv</code> - Derivation templates</li>
                <li><code className="text-xs bg-muted px-1 rounded">attachments/</code> - Folder containing all attachment files</li>
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
              <span className="text-muted-foreground">Vocabulary Items</span>
              <span className="font-medium" data-testid="text-vocabulary-count">{vocabularyCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Derivation Templates</span>
              <span className="font-medium" data-testid="text-template-count">{derivationTemplateCount}</span>
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
                <Paperclip className="h-5 w-5" />
                File Attachments
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                <span className="font-medium">Attachments are included in backup</span>
              </div>
              <p className="text-sm text-muted-foreground">
                All {attachmentCount} attachment file(s) will be exported to the <code className="bg-muted px-1 rounded">attachments/</code> folder 
                in the ZIP file and automatically restored when you import this backup.
              </p>
              <p className="text-xs text-muted-foreground">
                Attachment files are stored unencrypted. Use the ZIP password protection option 
                above to secure your exported backup.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
