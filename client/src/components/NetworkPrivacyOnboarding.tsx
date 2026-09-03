import { useState } from 'react';
import { isElectron } from '@/lib/electron';
import { isElectronFileMode } from '@/lib/hashLocation';
import { useNodeSettings } from '@/hooks/use-node-settings';
import { DEFAULT_TRUSTED_LOCAL_HOSTS, type NetworkPrivacyMode } from '@/lib/database';
import { DemoVaultLoader } from '@/components/DemoVaultLoader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Globe2, HardDrive, LockKeyhole, Server, Shield, Upload, WalletCards } from 'lucide-react';

function moveTo(path: string): void {
  if (isElectronFileMode()) {
    window.location.hash = path;
  } else {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}

const privacyCards: Array<{
  mode: NetworkPrivacyMode;
  title: string;
  summary: string;
  impact: string;
  icon: typeof Server;
}> = [
  {
    mode: 'own-node',
    title: 'Own node',
    summary: 'Use your own Electrs, Esplora, or mempool instance.',
    impact: 'Best privacy when the node is yours. Your addresses are sent only to the server URL you configure.',
    icon: Server,
  },
  {
    mode: 'electrum',
    title: 'Electrum',
    summary: 'Connect to an Electrum server from the desktop app.',
    impact: 'The Electrum server can associate queried addresses. Prefer a server you control, optionally through Tor.',
    icon: HardDrive,
  },
  {
    mode: 'public-tor',
    title: 'Public API through Tor',
    summary: 'Use mempool.space while hiding your IP with Tor.',
    impact: 'The provider still sees the queried addresses, but Tor prevents it from seeing your normal public IP.',
    icon: Shield,
  },
  {
    mode: 'public-direct',
    title: 'Direct public API',
    summary: 'Connect directly to mempool.space.',
    impact: 'Lowest privacy: the provider can see both your IP address and every address queried together.',
    icon: Globe2,
  },
];

export function NetworkPrivacyOnboarding() {
  const { nodeSettings, updateSettings } = useNodeSettings();
  const [selected, setSelected] = useState<NetworkPrivacyMode>('public-tor');
  const [customUrl, setCustomUrl] = useState('');
  const [electrumHost, setElectrumHost] = useState('');
  const [error, setError] = useState('');
  const stage = nodeSettings.networkOnboardingStage ?? 'complete';

  const chooseSource = async () => {
    setError('');
    if (selected === 'own-node' && !customUrl.trim()) {
      setError('Enter your own node URL before continuing.');
      return;
    }
    if (selected === 'electrum' && !isElectron()) {
      setError('Electrum is available in the desktop app. Choose another source in this build.');
      return;
    }
    if (selected === 'electrum' && !electrumHost.trim()) {
      setError('Enter your Electrum server host before continuing.');
      return;
    }

    const common = {
      networkPrivacyMode: selected,
      networkAccessEnabled: true,
      networkOnboardingStage: 'import' as const,
      networkPrivacyChosenAt: Date.now(),
      firstSyncConfirmedAt: undefined,
    };

    if (selected === 'own-node') {
      let hostname = '';
      try {
        hostname = new URL(customUrl.trim()).hostname.toLowerCase();
      } catch {
        setError('Enter a valid http:// or https:// node URL.');
        return;
      }
      await updateSettings({
        ...common,
        providerType: 'custom-electrs',
        customUrl: customUrl.trim(),
        useTor: customUrl.includes('.onion'),
        useElectrum: false,
        allowLocalNetwork: true,
        trustedLocalHosts: Array.from(new Set([...DEFAULT_TRUSTED_LOCAL_HOSTS, hostname])),
      });
    } else if (selected === 'electrum') {
      await updateSettings({
        ...common,
        useElectrum: true,
        electrumHost: electrumHost.trim(),
        electrumPort: 50001,
        electrumSSL: false,
        useTor: false,
      });
    } else {
      await updateSettings({
        ...common,
        providerType: 'mempool-space',
        useElectrum: false,
        useTor: selected === 'public-tor',
      });
    }
  };

  const finish = async (path: string) => {
    await updateSettings({ networkOnboardingStage: 'complete' });
    moveTo(path);
  };

  if (stage === 'import') {
    return (
      <div className="min-h-screen bg-background p-4 flex items-center justify-center">
        <Card className="w-full max-w-3xl" data-testid="network-onboarding-import">
          <CardHeader className="text-center">
            <CardTitle>Build your local vault</CardTitle>
            <CardDescription>
              Imports and the demo vault stay on this device. No blockchain request is made until you start a sync and confirm its disclosure.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <Button variant="outline" className="h-auto py-5 justify-start" onClick={() => finish('/wallet-import')} data-testid="button-onboarding-wallet-import">
                <WalletCards className="h-5 w-5 mr-3" />
                <span className="text-left"><strong className="block">Import a wallet</strong><span className="text-xs text-muted-foreground">Descriptors, wallet files, and extended public keys</span></span>
              </Button>
              <Button variant="outline" className="h-auto py-5 justify-start" onClick={() => finish('/import')} data-testid="button-onboarding-bulk-import">
                <Upload className="h-5 w-5 mr-3" />
                <span className="text-left"><strong className="block">Import addresses</strong><span className="text-xs text-muted-foreground">Paste or upload local address data</span></span>
              </Button>
            </div>
            <div className="border rounded-lg p-4 text-center space-y-3">
              <p className="text-sm text-muted-foreground">Or try KYUTXO with a local demo backup. Loading it does not contact a blockchain provider.</p>
              <DemoVaultLoader />
            </div>
            <div className="flex justify-between gap-3">
              <Button variant="ghost" onClick={() => updateSettings({ networkOnboardingStage: 'source' })}>Back</Button>
              <Button onClick={() => finish('/')} data-testid="button-onboarding-finish">Continue to empty vault</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 flex items-center justify-center">
      <Card className="w-full max-w-4xl" data-testid="network-onboarding-source">
        <CardHeader className="text-center">
          <div className="mx-auto rounded-full bg-muted p-3"><LockKeyhole className="h-6 w-6" /></div>
          <CardTitle>Choose before KYUTXO connects</CardTitle>
          <CardDescription>
            Your vault starts offline. Pick where blockchain requests may go; nothing below tests a connection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            {privacyCards.map(({ mode, title, summary, impact, icon: Icon }) => {
              const unavailable = mode === 'electrum' && !isElectron();
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={unavailable}
                  onClick={() => setSelected(mode)}
                  className={`text-left rounded-lg border p-4 transition-colors ${selected === mode ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'} disabled:opacity-50`}
                  data-testid={`choice-network-${mode}`}
                >
                  <div className="flex gap-3">
                    <Icon className="h-5 w-5 mt-0.5" />
                    <div>
                      <p className="font-semibold">{title}</p>
                      <p className="text-sm text-muted-foreground">{summary}</p>
                      <p className="text-xs mt-2">{impact}</p>
                      {unavailable && <p className="text-xs mt-2 text-muted-foreground">Desktop app only</p>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {selected === 'own-node' && (
            <div className="space-y-2">
              <Label htmlFor="onboarding-node-url">Own node URL</Label>
              <Input id="onboarding-node-url" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="http://umbrel.local:3006/api" data-testid="input-onboarding-node-url" />
            </div>
          )}
          {selected === 'electrum' && (
            <div className="space-y-2">
              <Label htmlFor="onboarding-electrum-host">Electrum server host</Label>
              <Input id="onboarding-electrum-host" value={electrumHost} onChange={(e) => setElectrumHost(e.target.value)} placeholder="umbrel.local" data-testid="input-onboarding-electrum-host" />
              <p className="text-xs text-muted-foreground">Port 50001 without TLS is selected initially; review advanced settings before using a different server.</p>
            </div>
          )}

          {error && <Alert variant="destructive"><AlertTitle>Cannot continue</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          <Alert>
            <AlertTitle>No hidden request</AlertTitle>
            <AlertDescription>
              Saving this choice only stores settings locally. Provider tests, address checks, price-source links, and sync remain under the same offline control.
            </AlertDescription>
          </Alert>
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="text-center"><DemoVaultLoader /></div>
            <Button onClick={chooseSource} data-testid="button-save-network-choice">Save choice and continue</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}