import { useState } from 'react';
import { Globe2, Server, Shield, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNodeSettings } from '@/hooks/use-node-settings';
import {
  getNetworkPrivacyLabel,
  isExplicitNetworkChoice,
  isNetworkAccessEnabled,
} from '@/lib/network-privacy';

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
      title={enabled ? 'Go offline now' : 'Restore the configured network connection'}
      data-testid="button-network-privacy"
      aria-pressed={!enabled}
    >
      <Icon className="h-4 w-4" />
      <span data-testid="text-network-privacy-state">{label}</span>
    </Button>
  );
}