import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { ChevronDown, ChevronRight, History, Key, Upload, Edit3, Tag, FolderOpen, KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { type RecordOrigin, type RecordOriginType } from '@/lib/database';
import { getDecryptedRecordOrigins, isEncryptionReady } from '@/lib/encryptionFacade';

interface MetadataSourcesPanelProps {
  recordId: number;
}

const originTypeConfig: Record<RecordOriginType, { label: string; icon: typeof Key; variant: 'default' | 'secondary' | 'outline' }> = {
  'manual': {
    label: 'Manual Entry',
    icon: Edit3,
    variant: 'default',
  },
  'xpub-derived': {
    label: 'xPub Derived',
    icon: Key,
    variant: 'secondary',
  },
  'bulk-import': {
    label: 'Bulk Import',
    icon: Upload,
    variant: 'outline',
  },
};

function OriginCard({ origin }: { origin: RecordOrigin }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const config = originTypeConfig[origin.originType] || originTypeConfig['manual'];
  const Icon = config.icon;

  const hasMetadata = origin.label || origin.notes || origin.owner || origin.walletName || 
    origin.seedName || origin.walletSoftware || origin.privateKeyStatus || origin.xpub || origin.derivationPath ||
    origin.source || (origin.tags && origin.tags.length > 0) || (origin.categories && origin.categories.length > 0);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div className="border rounded-lg p-3">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="w-full justify-between p-0 h-auto hover:bg-transparent"
            data-testid={`button-origin-${origin.id}`}
          >
            <div className="flex items-center gap-3">
              <Badge variant={config.variant} className="gap-1">
                <Icon className="h-3 w-3" />
                {config.label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {format(new Date(origin.createdAt), 'MMM d, yyyy h:mm a')}
              </span>
            </div>
            {hasMetadata && (
              isExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )
            )}
          </Button>
        </CollapsibleTrigger>

        {hasMetadata && (
          <CollapsibleContent>
            <div className="mt-3 pt-3 border-t space-y-3 text-sm">
              {origin.label && (
                <div data-testid={`text-origin-label-${origin.id}`}>
                  <span className="text-muted-foreground">Label:</span>{' '}
                  <span className="font-medium">{origin.label}</span>
                </div>
              )}

              {origin.notes && (
                <div data-testid={`text-origin-notes-${origin.id}`}>
                  <span className="text-muted-foreground">Notes:</span>
                  <p className="mt-1 text-xs whitespace-pre-wrap bg-muted p-2 rounded">
                    {origin.notes}
                  </p>
                </div>
              )}

              {origin.owner && (
                <div data-testid={`text-origin-owner-${origin.id}`}>
                  <span className="text-muted-foreground">Owner:</span>{' '}
                  <span>{origin.owner}</span>
                </div>
              )}

              {origin.walletName && (
                <div data-testid={`text-origin-wallet-${origin.id}`}>
                  <span className="text-muted-foreground">Wallet:</span>{' '}
                  <span>{origin.walletName}</span>
                </div>
              )}

              {origin.seedName && (
                <div data-testid={`text-origin-seed-${origin.id}`}>
                  <span className="text-muted-foreground">Seed Name:</span>{' '}
                  <span>{origin.seedName}</span>
                </div>
              )}

              {origin.walletSoftware && (
                <div data-testid={`text-origin-software-${origin.id}`}>
                  <span className="text-muted-foreground">Wallet Software:</span>{' '}
                  <span>{origin.walletSoftware}</span>
                </div>
              )}

              {origin.privateKeyStatus && (
                <div data-testid={`text-origin-pkey-${origin.id}`}>
                  <span className="text-muted-foreground flex items-center gap-1">
                    <KeyRound className="h-3 w-3" /> Private Key Status:
                  </span>{' '}
                  <span>{origin.privateKeyStatus}</span>
                </div>
              )}

              {origin.source && (
                <div data-testid={`text-origin-source-${origin.id}`}>
                  <span className="text-muted-foreground">Source:</span>{' '}
                  <span>{origin.source}</span>
                </div>
              )}

              {origin.xpub && (
                <div data-testid={`text-origin-xpub-${origin.id}`}>
                  <span className="text-muted-foreground">xPub:</span>
                  <p className="mt-1 text-xs font-mono bg-muted p-2 rounded break-all">
                    {origin.xpub}
                  </p>
                </div>
              )}

              {origin.derivationPath && (
                <div data-testid={`text-origin-path-${origin.id}`}>
                  <span className="text-muted-foreground">Derivation Path:</span>{' '}
                  <span className="font-mono text-xs">{origin.derivationPath}</span>
                </div>
              )}

              {origin.chainType && (
                <div data-testid={`text-origin-chain-${origin.id}`}>
                  <span className="text-muted-foreground">Chain Type:</span>{' '}
                  <Badge variant="outline" className="text-xs">
                    {origin.chainType === 'receive' ? 'Receive' : 'Change'}
                  </Badge>
                </div>
              )}

              {origin.tags && origin.tags.length > 0 && (
                <div data-testid={`text-origin-tags-${origin.id}`}>
                  <span className="text-muted-foreground flex items-center gap-1 mb-1">
                    <Tag className="h-3 w-3" /> Tags:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {origin.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {origin.categories && origin.categories.length > 0 && (
                <div data-testid={`text-origin-categories-${origin.id}`}>
                  <span className="text-muted-foreground flex items-center gap-1 mb-1">
                    <FolderOpen className="h-3 w-3" /> Categories:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {origin.categories.map((cat) => (
                      <Badge key={cat} variant="outline" className="text-xs">
                        {cat}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

export function MetadataSourcesPanel({ recordId }: MetadataSourcesPanelProps) {
  const [origins, setOrigins] = useState<RecordOrigin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadOrigins() {
      if (!isEncryptionReady()) {
        setIsLoading(false);
        setError('Encryption not ready');
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const decryptedOrigins = await getDecryptedRecordOrigins(recordId);
        decryptedOrigins.sort((a, b) => b.createdAt - a.createdAt);
        setOrigins(decryptedOrigins);
      } catch (err) {
        console.error('[MetadataSourcesPanel] Failed to load origins:', err);
        setError('Failed to load metadata sources');
        setOrigins([]);
      } finally {
        setIsLoading(false);
      }
    }

    if (recordId) {
      loadOrigins();
    }
  }, [recordId]);

  if (isLoading) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">
        Loading metadata sources...
      </div>
    );
  }

  if (error || origins.length === 0) {
    return null;
  }

  return (
    <div>
      <Separator className="my-4" />
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="w-full justify-between p-0 h-auto hover:bg-transparent mb-3"
            data-testid="button-toggle-sources"
          >
            <h4 className="text-sm font-medium flex items-center gap-2">
              <History className="h-4 w-4" />
              Metadata Sources ({origins.length})
            </h4>
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-2" data-testid="list-metadata-sources">
            {origins.map((origin) => (
              <OriginCard key={origin.id} origin={origin} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Shows how this record's metadata was added or updated over time. 
            Expand each source to see the specific values contributed.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
