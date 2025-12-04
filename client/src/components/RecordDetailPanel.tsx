import { Edit, Paperclip, Wallet as WalletIcon, User, Upload, QrCode, Key, GitBranch, ArrowDownLeft, ArrowUpRight, Shield, ChevronDown, ChevronRight, Link2, Layers, FileInput, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BitcoinAddressDisplay } from "./BitcoinAddressDisplay";
import { RecordTypeBadge } from "./RecordTypeBadge";
import { AttachmentList } from "./AttachmentList";
import { AttachmentUpload } from "./AttachmentUpload";
import { MetadataSourcesPanel } from "./MetadataSourcesPanel";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { 
  Attachment, 
  VaultMetadata, 
  AddressImportance, 
  ChainType,
  FlowType,
  AcquisitionMethod,
  DispositionType,
  CounterpartyType,
} from "@/lib/database";
import { 
  FLOW_TYPE_OPTIONS,
  ACQUISITION_METHOD_OPTIONS,
  DISPOSITION_TYPE_OPTIONS,
  COUNTERPARTY_TYPE_OPTIONS,
} from "@/lib/database";
import QRCode from "qrcode";

interface CustomFieldDef {
  id?: number;
  name: string;
  slug: string;
  enabled: boolean;
}

interface RecordDetailPanelProps {
  open: boolean;
  onClose: () => void;
  onEdit?: () => void;
  record?: {
    id: string;
    type: "address" | "transaction" | "other";
    inputString: string;
    label: string;
    notes?: string;
    tags: string[];
    categories: string[];
    seedName?: string;
    walletSoftware?: string;
    owner?: string;
    walletName?: string;
    privateKeyStatus?: string;
    source?: string;
    derivationPath?: string;
    chainType?: ChainType;
    vault?: VaultMetadata;
    addressImportance?: AddressImportance;
    customFields?: { [slug: string]: string };
    syncDepth?: number;
    maxSyncedDepth?: number;
    discoveredInTxid?: string;
    discoveredFromRecordId?: number;
    // Transaction metadata
    flowType?: FlowType;
    acquisitionMethod?: AcquisitionMethod;
    dispositionType?: DispositionType;
    costBasisUsd?: number;
    // Address metadata
    counterpartyType?: CounterpartyType;
  };
  attachments?: Attachment[];
  onAttachmentsChange?: () => void;
  customFieldDefs?: CustomFieldDef[];
}

function getImportanceBadgeVariant(importance?: AddressImportance): "default" | "secondary" | "outline" | "destructive" {
  switch (importance) {
    case 'verified':
      return 'default';
    case 'manual':
      return 'default';
    case 'wallet-import':
      return 'secondary';
    case 'xpub-derived':
      return 'secondary';
    case 'blockchain-discovered':
      return 'outline';
    case 'pending-review':
      return 'destructive';
    default:
      return 'outline';
  }
}

function getImportanceLabel(importance?: AddressImportance): string {
  switch (importance) {
    case 'verified':
      return 'Verified';
    case 'manual':
      return 'Manual Entry';
    case 'wallet-import':
      return 'Wallet Import';
    case 'xpub-derived':
      return 'XPUB Derived';
    case 'blockchain-discovered':
      return 'Blockchain Discovered';
    case 'pending-review':
      return 'Pending Review';
    default:
      return 'Unknown';
  }
}

function getSourceLabel(source?: string): string {
  switch (source) {
    case 'manual':
      return 'Manual Entry';
    case 'wallet-import':
      return 'Wallet Import';
    case 'xpub-import':
      return 'XPUB Import';
    case 'blockchain-sync':
      return 'Blockchain Sync';
    default:
      return source || 'Unknown';
  }
}

export function RecordDetailPanel({ 
  open, 
  onClose, 
  onEdit, 
  record, 
  attachments = [], 
  onAttachmentsChange,
  customFieldDefs = [],
}: RecordDetailPanelProps) {
  const [showUpload, setShowUpload] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);

  useEffect(() => {
    if (qrDialogOpen && record?.inputString) {
      QRCode.toDataURL(record.inputString, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      })
        .then((url) => setQrCodeDataUrl(url))
        .catch((err) => console.error('Error generating QR code:', err));
    }
  }, [qrDialogOpen, record?.inputString]);

  if (!record) return null;

  const handleUploadComplete = () => {
    setShowUpload(false);
    onAttachmentsChange?.();
  };

  const handleOpenQrDialog = () => {
    setQrCodeDataUrl(null);
    setQrDialogOpen(true);
  };

  const hasWalletInfo = record.seedName || record.walletSoftware || record.derivationPath || record.chainType || record.privateKeyStatus;
  const hasVaultInfo = record.vault?.isVaultXpub;
  // Only show discovery info section for addresses discovered at deeper levels (syncDepth > 0)
  // or that have specific discovery metadata (discovered in transaction or from another record)
  const hasBlockchainDiscoveryInfo = (record.syncDepth !== undefined && record.syncDepth > 0) || record.discoveredInTxid || record.discoveredFromRecordId !== undefined;
  
  const customFieldsToShow = customFieldDefs.filter(
    def => def.enabled && record.customFields?.[def.slug]
  );

  return (
    <>
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-md overflow-hidden flex flex-col p-0">
        <SheetHeader className="p-6 pb-4 space-y-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-xl mb-2">{record.label}</SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <RecordTypeBadge type={record.type} />
                {record.addressImportance && (
                  <Badge 
                    variant={getImportanceBadgeVariant(record.addressImportance)}
                    data-testid="badge-importance"
                  >
                    <Shield className="h-3 w-3 mr-1" />
                    {getImportanceLabel(record.addressImportance)}
                  </Badge>
                )}
                {record.chainType && (
                  <Badge variant="outline" data-testid="badge-chain-type">
                    {record.chainType === 'receive' ? (
                      <><ArrowDownLeft className="h-3 w-3 mr-1" />Receive</>
                    ) : (
                      <><ArrowUpRight className="h-3 w-3 mr-1" />Change</>
                    )}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" onClick={onEdit} data-testid="button-edit-panel">
                <Edit className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-6">
          <div className="space-y-6 pb-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium">
                  {record.type === "address" ? "Bitcoin Address" : record.type === "transaction" ? "Transaction ID" : "Identifier"}
                </h4>
                {(record.type === "address" || record.type === "transaction") && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleOpenQrDialog}
                    data-testid="button-show-qr"
                  >
                    <QrCode className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <BitcoinAddressDisplay address={record.inputString} truncate={false} />
            </div>

            {record.notes && (
              <div>
                <h4 className="text-sm font-medium mb-2">Notes</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-notes-detail">
                  {record.notes}
                </p>
              </div>
            )}

            {record.source && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <FileInput className="h-4 w-4" />
                  Source
                </h4>
                <Badge variant="outline" data-testid="text-source-detail">
                  {getSourceLabel(record.source)}
                </Badge>
              </div>
            )}

            <Separator />

            {record.owner && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Owner
                </h4>
                <p className="text-sm" data-testid="text-owner-detail">{record.owner}</p>
              </div>
            )}

            {record.walletName && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <WalletIcon className="h-4 w-4" />
                  Wallet Name
                </h4>
                <p className="text-sm" data-testid="text-walletname-detail">{record.walletName}</p>
              </div>
            )}

            {hasWalletInfo && (
              <>
                {record.seedName && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Key className="h-4 w-4" />
                      Seed Name
                    </h4>
                    <p className="text-sm" data-testid="text-seed-detail">{record.seedName}</p>
                  </div>
                )}

                {record.walletSoftware && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Wallet Software</h4>
                    <p className="text-sm" data-testid="text-wallet-detail">{record.walletSoftware}</p>
                  </div>
                )}

                {record.derivationPath && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <GitBranch className="h-4 w-4" />
                      Derivation Path
                    </h4>
                    <code className="text-sm bg-muted px-2 py-1 rounded" data-testid="text-derivation-detail">
                      {record.derivationPath}
                    </code>
                  </div>
                )}

                {record.privateKeyStatus && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      Private Key Status
                    </h4>
                    <p className="text-sm" data-testid="text-privatekey-detail">{record.privateKeyStatus}</p>
                  </div>
                )}
              </>
            )}

            {hasVaultInfo && record.vault && (
              <div className="p-3 bg-muted/50 rounded-lg space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  Multisig Vault
                </h4>
                {record.vault.vaultName && (
                  <div>
                    <span className="text-xs text-muted-foreground">Vault Name:</span>
                    <p className="text-sm" data-testid="text-vault-name">{record.vault.vaultName}</p>
                  </div>
                )}
                {record.vault.m && record.vault.n && (
                  <div>
                    <span className="text-xs text-muted-foreground">Quorum:</span>
                    <p className="text-sm" data-testid="text-vault-quorum">
                      {record.vault.m} of {record.vault.n} signatures required
                    </p>
                  </div>
                )}
                {record.vault.vaultNotes && (
                  <div>
                    <span className="text-xs text-muted-foreground">Notes:</span>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-vault-notes">
                      {record.vault.vaultNotes}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Transaction Metadata Section */}
            {record.type === 'transaction' && (record.flowType || record.acquisitionMethod || record.dispositionType || record.costBasisUsd !== undefined) && (
              <div className="p-3 bg-muted/50 rounded-lg space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <ArrowUpRight className="h-4 w-4" />
                  Transaction Details
                </h4>
                {record.flowType && (
                  <div>
                    <span className="text-xs text-muted-foreground">Flow Type:</span>
                    <p className="text-sm" data-testid="text-flow-type">
                      {FLOW_TYPE_OPTIONS.find(o => o.value === record.flowType)?.label || record.flowType}
                    </p>
                  </div>
                )}
                {record.acquisitionMethod && (
                  <div>
                    <span className="text-xs text-muted-foreground">Acquisition Method:</span>
                    <p className="text-sm" data-testid="text-acquisition-method">
                      {ACQUISITION_METHOD_OPTIONS.find(o => o.value === record.acquisitionMethod)?.label || record.acquisitionMethod}
                    </p>
                  </div>
                )}
                {record.dispositionType && (
                  <div>
                    <span className="text-xs text-muted-foreground">Disposition Type:</span>
                    <p className="text-sm" data-testid="text-disposition-type">
                      {DISPOSITION_TYPE_OPTIONS.find(o => o.value === record.dispositionType)?.label || record.dispositionType}
                    </p>
                  </div>
                )}
                {record.costBasisUsd !== undefined && record.costBasisUsd !== null && (
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {record.flowType === 'received' ? 'Cost Basis:' : 'Disposal Value:'}
                    </span>
                    <p className="text-sm font-medium" data-testid="text-cost-basis">
                      ${record.costBasisUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Address Counterparty Type */}
            {record.type === 'address' && record.counterpartyType && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Counterparty Type
                </h4>
                <Badge variant="outline" data-testid="badge-counterparty-type">
                  {COUNTERPARTY_TYPE_OPTIONS.find(o => o.value === record.counterpartyType)?.label || record.counterpartyType}
                </Badge>
              </div>
            )}

            {customFieldsToShow.length > 0 && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-3">Custom Fields</h4>
                  <div className="space-y-3">
                    {customFieldsToShow.map(field => (
                      <div key={field.slug}>
                        <span className="text-xs text-muted-foreground">{field.name}</span>
                        <p className="text-sm" data-testid={`text-custom-${field.slug}`}>
                          {record.customFields?.[field.slug]}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {record.tags.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Tags</h4>
                <div className="flex flex-wrap gap-2">
                  {record.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {record.categories.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Categories</h4>
                <div className="flex flex-wrap gap-2">
                  {record.categories.map((category) => (
                    <Badge key={category} variant="outline">
                      {category}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <MetadataSourcesPanel recordId={Number(record.id)} />

            {hasBlockchainDiscoveryInfo && (
              <Collapsible open={technicalOpen} onOpenChange={setTechnicalOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="w-full justify-between px-0" data-testid="button-toggle-technical">
                    <span className="text-sm font-medium flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      Blockchain Discovery Info
                    </span>
                    {technicalOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-2">
                  {record.syncDepth !== undefined && record.syncDepth > 0 && (
                    <div>
                      <span className="text-xs text-muted-foreground">Discovery Depth</span>
                      <p className="text-sm" data-testid="text-sync-depth">
                        {record.syncDepth === 1 
                          ? 'First hop (directly connected to your addresses)' 
                          : record.syncDepth === 2
                            ? 'Second hop (2 transactions from your addresses)'
                            : `${record.syncDepth} hops from your addresses`}
                      </p>
                    </div>
                  )}
                  {record.discoveredInTxid && (
                    <div>
                      <span className="text-xs text-muted-foreground">Discovered in Transaction</span>
                      <BitcoinAddressDisplay address={record.discoveredInTxid} truncate={true} />
                    </div>
                  )}
                  {record.discoveredFromRecordId !== undefined && (
                    <div>
                      <span className="text-xs text-muted-foreground">Discovered From Record</span>
                      <Link 
                        href={`/records?id=${record.discoveredFromRecordId}`}
                        className="flex items-center gap-1 text-sm text-primary hover:underline"
                        data-testid="link-discovered-from"
                      >
                        Record #{record.discoveredFromRecordId}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>
            )}

            <Separator />

            <div>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <Paperclip className="h-4 w-4" />
                  Attachments ({attachments.length})
                </h4>
                {!showUpload && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowUpload(true)}
                    data-testid="button-show-upload"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Upload
                  </Button>
                )}
              </div>

              {showUpload && (
                <div className="mb-4">
                  <AttachmentUpload
                    recordId={Number(record.id)}
                    identifier={record.inputString}
                    onUploadComplete={handleUploadComplete}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowUpload(false)}
                    className="mt-2"
                    data-testid="button-cancel-upload"
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <AttachmentList
                attachments={attachments}
                onDelete={onAttachmentsChange}
              />
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>

    <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
      <DialogContent className="sm:max-w-[320px]">
        <DialogHeader>
          <DialogTitle className="text-center">
            {record.type === "address" ? "Address QR Code" : "Transaction ID QR Code"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          {qrCodeDataUrl ? (
            <img
              src={qrCodeDataUrl}
              alt="QR Code"
              className="w-64 h-64"
              data-testid="img-qr-code"
            />
          ) : (
            <div className="w-64 h-64 flex items-center justify-center bg-muted rounded">
              <span className="text-muted-foreground">Generating...</span>
            </div>
          )}
          <p className="text-xs text-muted-foreground text-center break-all px-4" data-testid="text-qr-value">
            {record.inputString}
          </p>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
