import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { useLocation } from 'wouter';
import { ChevronDown, ChevronRight, History, Key, Upload, Edit3, Tag, FolderOpen, KeyRound, RefreshCw, Link2, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type RecordOrigin, type RecordOriginType, type Record as DBRecord, type ConflictResolutionMap } from '@/lib/database';
import { getRecordOrigins } from '@/lib/dataFacade';
import { SINGULAR_FIELDS, detectSingularFieldConflicts, type FieldConfig } from '@/lib/conflict-detection';
import { renderSourceNote } from '@/lib/renderSourceNote';

interface RecordFields {
  label?: string;
  owner?: string;
  seedName?: string;
  walletName?: string;
  walletSoftware?: string;
  privateKeyStatus?: string;
  conflictResolutions?: ConflictResolutionMap;
}

interface MetadataSourcesPanelProps {
  recordId: number;
  record?: RecordFields;
}

const originTypeConfig: Record<RecordOriginType, { label: string; icon: typeof Key; variant: 'default' | 'secondary' | 'outline' }> = {
  'manual': {
    label: 'Manual Entry',
    icon: Edit3,
    variant: 'default',
  },
  'xpub-derived': {
    label: 'xPub Import',
    icon: Key,
    variant: 'secondary',
  },
  'bulk-import': {
    label: 'Bulk Import',
    icon: Upload,
    variant: 'outline',
  },
  'wallet-sync': {
    label: 'Wallet Sync',
    icon: RefreshCw,
    variant: 'secondary',
  },
  'blockchain-sync': {
    label: 'Blockchain Sync',
    icon: Link2,
    variant: 'outline',
  },
};

function isFieldDifferent(origin: RecordOrigin, record: RecordFields | undefined, fieldKey: keyof RecordOrigin): boolean {
  if (!record) return false;
  const originValue = origin[fieldKey] as string | undefined;
  if (!originValue || originValue.trim() === '') return false;
  
  const recordKeyMap: Partial<{ [K in keyof RecordOrigin]: keyof Omit<RecordFields, 'conflictResolutions'> }> = {
    label: 'label',
    owner: 'owner',
    seedName: 'seedName',
    walletName: 'walletName',
    walletSoftware: 'walletSoftware',
    privateKeyStatus: 'privateKeyStatus',
  };
  
  const recordKey = recordKeyMap[fieldKey];
  if (!recordKey) return false;
  
  const recordValue = record[recordKey];
  return originValue.trim() !== (recordValue?.trim() || '');
}

function ConflictIndicator({ tooltip }: { tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center ml-1">
          <AlertCircle className="h-3 w-3 text-orange-500" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs">{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function OriginCard({ origin, record }: { origin: RecordOrigin; record?: RecordFields }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const config = originTypeConfig[origin.originType] || originTypeConfig['manual'];
  const Icon = config.icon;

  const hasMetadata = origin.label || origin.notes || origin.owner || origin.walletName || 
    origin.seedName || origin.walletSoftware || origin.privateKeyStatus || origin.xpub || origin.derivationPath ||
    origin.source || (origin.tags && origin.tags.length > 0) || (origin.categories && origin.categories.length > 0);
  
  const conflictingFields = record ? SINGULAR_FIELDS.filter(f => 
    isFieldDifferent(origin, record, f.key)
  ) : [];
  const hasConflicts = conflictingFields.length > 0;

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
              {hasConflicts && (
                <Badge variant="outline" className="gap-1 text-orange-600 border-orange-300 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-700">
                  <AlertCircle className="h-3 w-3" />
                  {conflictingFields.length} differs
                </Badge>
              )}
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
                  {isFieldDifferent(origin, record, 'label') && (
                    <ConflictIndicator tooltip={`Active value: "${record?.label || '(empty)'}"`} />
                  )}
                </div>
              )}

              {origin.notes && (
                <div data-testid={`text-origin-notes-${origin.id}`}>
                  <span className="text-muted-foreground">Notes:</span>
                  <p className="mt-1 text-xs whitespace-pre-wrap bg-muted p-2 rounded">
                    {renderSourceNote(origin.notes)}
                  </p>
                </div>
              )}

              {origin.owner && (
                <div data-testid={`text-origin-owner-${origin.id}`}>
                  <span className="text-muted-foreground">Owner:</span>{' '}
                  <span>{origin.owner}</span>
                  {isFieldDifferent(origin, record, 'owner') && (
                    <ConflictIndicator tooltip={`Active value: "${record?.owner || '(empty)'}"`} />
                  )}
                </div>
              )}

              {origin.walletName && (
                <div data-testid={`text-origin-wallet-${origin.id}`}>
                  <span className="text-muted-foreground">Wallet:</span>{' '}
                  <span>{origin.walletName}</span>
                  {isFieldDifferent(origin, record, 'walletName') && (
                    <ConflictIndicator tooltip={`Active value: "${record?.walletName || '(empty)'}"`} />
                  )}
                </div>
              )}

              {origin.seedName && (
                <div data-testid={`text-origin-seed-${origin.id}`}>
                  <span className="text-muted-foreground">Seed Name:</span>{' '}
                  <span>{origin.seedName}</span>
                  {isFieldDifferent(origin, record, 'seedName') && (
                    <ConflictIndicator tooltip={`Active value: "${record?.seedName || '(empty)'}"`} />
                  )}
                </div>
              )}

              {origin.walletSoftware && (
                <div data-testid={`text-origin-software-${origin.id}`}>
                  <span className="text-muted-foreground">Wallet Software:</span>{' '}
                  <span>{origin.walletSoftware}</span>
                  {isFieldDifferent(origin, record, 'walletSoftware') && (
                    <ConflictIndicator tooltip={`Active value: "${record?.walletSoftware || '(empty)'}"`} />
                  )}
                </div>
              )}

              {origin.privateKeyStatus && (
                <div data-testid={`text-origin-pkey-${origin.id}`}>
                  <span className="text-muted-foreground flex items-center gap-1">
                    <KeyRound className="h-3 w-3" /> Private Key Status:
                  </span>{' '}
                  <span>{origin.privateKeyStatus}</span>
                  {isFieldDifferent(origin, record, 'privateKeyStatus') && (
                    <ConflictIndicator tooltip={`Active value: "${record?.privateKeyStatus || '(empty)'}"`} />
                  )}
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

export function MetadataSourcesPanel({ recordId, record }: MetadataSourcesPanelProps) {
  const [, navigate] = useLocation();
  const [origins, setOrigins] = useState<RecordOrigin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalConflicts, setTotalConflicts] = useState(0);

  useEffect(() => {
    async function loadOrigins() {
      setIsLoading(true);
      setError(null);
      try {
        const loadedOrigins = await getRecordOrigins(recordId);
        loadedOrigins.sort((a, b) => b.createdAt - a.createdAt);
        setOrigins(loadedOrigins);
        
        if (record) {
          // Same shared detection the Conflict Resolution page uses, so the
          // header count always agrees with what that page will show.
          setTotalConflicts(detectSingularFieldConflicts(record, loadedOrigins).length);
        }
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
  }, [recordId, record]);

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
        {/* The conflicts deep-link badge lives OUTSIDE the toggle button so a
            click aimed anywhere at "the toggle" can never be hijacked into a
            navigation (Task #1838). The badge sits at the right edge, next to
            the chevron, visually and spatially distinct from the toggle area. */}
        <div className="flex items-center gap-2 mb-3">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="flex-1 justify-between p-0 h-auto hover:bg-transparent"
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
          {totalConflicts > 0 && (
            <Badge
              variant="outline"
              role="button"
              tabIndex={0}
              className="gap-1 shrink-0 text-orange-600 border-orange-300 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-700 cursor-pointer"
              onClick={() => {
                // Deep-link to the Conflict Resolution page for this record.
                navigate(`/conflict-resolution?recordId=${recordId}`);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/conflict-resolution?recordId=${recordId}`);
                }
              }}
              data-testid="badge-sources-conflicts"
            >
              <AlertCircle className="h-3 w-3" />
              {totalConflicts} conflicts
            </Badge>
          )}
        </div>

        <CollapsibleContent>
          <div className="space-y-2" data-testid="list-metadata-sources">
            {origins.map((origin) => (
              <OriginCard key={origin.id} origin={origin} record={record} />
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
