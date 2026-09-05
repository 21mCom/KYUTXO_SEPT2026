import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Activity, Globe2, Server, Shield, Trash2, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useNodeSettings } from '@/hooks/use-node-settings';
import {
  clearNetworkPrivacyActivity,
  getNetworkPrivacyActivity,
} from '@/lib/data/network-privacy-activity-crud';
import type { NetworkPrivacyActivityEntry, NetworkPrivacyMode } from '@/lib/database';
import {
  getNetworkPrivacyLabel,
  isExplicitNetworkChoice,
  isNetworkAccessEnabled,
} from '@/lib/network-privacy';

const PROVIDER_LABELS: Record<NetworkPrivacyMode, string> = {
  'own-node': 'Own node',
  electrum: 'Electrum',
  'public-tor': 'Public API through Tor',
  'public-direct': 'Direct public API',
};

const ACTION_LABELS: Record<NetworkPrivacyActivityEntry['action'], string> = {
  sync: 'Sync',
  'address-check': 'Address check',
  'provider-test': 'Provider test',
  'price-source': 'Price source',
};

function NetworkPrivacyActivityDialog() {
  const [open, setOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const entries = useLiveQuery(() => getNetworkPrivacyActivity(), []) ?? [];

  const clearActivity = async () => {
    setIsClearing(true);
    try {
      await clearNetworkPrivacyActivity();
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          title="View local network activity"
          aria-label="View local network activity"
          data-testid="button-network-privacy-activity"
        >
          <Activity className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl" data-testid="network-privacy-activity-dialog">
        <DialogHeader>
          <DialogTitle>Local network activity</DialogTitle>
          <DialogDescription>
            A device-only summary of blockchain-related requests. Full addresses,
            URLs, and response data are never stored.
          </DialogDescription>
        </DialogHeader>

        {entries.length === 0 ? (
          <div className="rounded-md border p-6 text-center text-sm text-muted-foreground" data-testid="network-privacy-activity-empty">
            No network activity recorded yet.
          </div>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="network-privacy-activity-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2 font-medium">Time</th>
                    <th className="p-2 font-medium">Provider</th>
                    <th className="p-2 font-medium">Action</th>
                    <th className="p-2 text-right font-medium">Addresses</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => (
                    <tr key={entry.id ?? `${entry.timestamp}-${entry.action}`} className="border-b last:border-0" data-testid={`network-privacy-activity-row-${entry.id ?? entry.timestamp}`}>
                      <td className="whitespace-nowrap p-2">{new Date(entry.timestamp).toLocaleString()}</td>
                      <td className="p-2">
                        <Badge variant="outline">{PROVIDER_LABELS[entry.providerClass]}</Badge>
                      </td>
                      <td className="p-2">{ACTION_LABELS[entry.action]}</td>
                      <td className="p-2 text-right tabular-nums">
                        {entry.addressCount === undefined ? '—' : entry.addressCount.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Stored locally on this device; not included in backups.
          </p>
          <Button
            variant="destructive"
            onClick={clearActivity}
            disabled={entries.length === 0 || isClearing}
            data-testid="button-clear-network-privacy-activity"
          >
            <Trash2 className="h-4 w-4" />
            Clear activity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NetworkPrivacyControl() {
  const [isUpdating, setIsUpdating] = useState(false);
  const { nodeSettings, updateSettings, isLoading } = useNodeSettings();
  const enabled = isNetworkAccessEnabled(nodeSettings);
  const label = getNetworkPrivacyLabel(nodeSettings);
  const choiceMade = isExplicitNetworkChoice(nodeSettings) ||
    nodeSettings.networkOnboardingStage === undefined;

  const Icon =
    label === 'Offline' ? WifiOff :
    label === 'Own node' ? Server :
    label === 'Tor' ? Shield :
    Globe2;

  return (
    <div className="flex items-center gap-1">
      <Button
        variant={enabled ? 'outline' : 'secondary'}
        size="sm"
        className="gap-2"
        disabled={isLoading || isUpdating || !choiceMade}
        onClick={async () => {
          setIsUpdating(true);
          try {
            await updateSettings({ networkAccessEnabled: !enabled });
          } finally {
            setIsUpdating(false);
          }
        }}
        title={
          !choiceMade
            ? 'Configure a network source in Node Settings'
            : enabled
              ? 'Go offline now'
              : 'Restore the configured network connection'
        }
        data-testid="button-network-privacy"
        aria-pressed={!enabled}
      >
        <Icon className="h-4 w-4" />
        <span data-testid="text-network-privacy-state">{label}</span>
      </Button>
      <NetworkPrivacyActivityDialog />
    </div>
  );
}