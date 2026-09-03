import { useState, useEffect } from "react";
import { 
  Server, 
  Globe, 
  Shield, 
  Wifi, 
  WifiOff, 
  Clock, 
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Info,
  Plus,
  X,
  Home,
  Zap
} from "lucide-react";
import { isElectron, getElectronAPI, ElectrumTestResult, ElectrumCertificateInfo } from "@/lib/electron";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { useSettings } from "@/hooks/use-settings";
import {
  updateDesktopLockSettings,
} from "@/lib/data/settings-crud";
import {
  canonicalizeTorProxyUrl,
  syncTorProxySettings,
  torProxySettingsFromNodeSettings,
} from "@/lib/tor-proxy-settings-sync";
import { usePageShortcuts } from "@/hooks/use-page-shortcuts";
import {
  NodeProviderType,
  NodeSettings as NodeSettingsType,
  DesktopLockSettings,
  DEFAULT_TRUSTED_LOCAL_HOSTS,
} from "@/lib/database";
import { isLocalOrPrivateHostname } from "@/lib/providers/types";
import { 
  testConnectionWithSettings, 
  getProviderDisplayName, 
  getProviderPrivacyInfo,
  testTorConnectivity,
  TorTestResult
} from "@/lib/blockchain-api";

type UrlClassification = 'local' | 'onion' | 'public' | 'unknown';

function classifyUrl(url: string | undefined): UrlClassification {
  if (!url || url.trim() === '') return 'unknown';
  
  try {
    const parsed = new URL(url.trim());
    const hostname = parsed.hostname.toLowerCase();
    
    // Check for .onion addresses (Tor hidden services)
    if (hostname.endsWith('.onion')) {
      return 'onion';
    }
    
    if (isLocalOrPrivateHostname(hostname)) return 'local';
    
    return 'public';
  } catch {
    return 'unknown';
  }
}

function getTorAvailability(providerType: NodeProviderType, customUrl?: string): {
  available: boolean;
  reason?: string;
  autoEnable?: boolean;
} {
  // Built-in providers always support Tor (they have .onion endpoints)
  if (providerType === 'mempool-space' || providerType === 'blockstream') {
    return { available: true };
  }
  
  // Custom providers depend on the URL
  const classification = classifyUrl(customUrl);
  
  switch (classification) {
    case 'local':
      return { 
        available: false, 
        reason: 'Tor cannot route to local/private network addresses. Use direct connection for LAN nodes.' 
      };
    case 'onion':
      return { 
        available: true, 
        autoEnable: true 
      };
    case 'public':
      return { available: true };
    case 'unknown':
    default:
      return { available: true };
  }
}

const PROVIDER_OPTIONS: { value: NodeProviderType; label: string; description: string }[] = [
  { 
    value: 'mempool-space', 
    label: 'mempool.space', 
    description: 'Popular public Bitcoin explorer API' 
  },
  { 
    value: 'blockstream', 
    label: 'blockstream.info', 
    description: 'Public API by Blockstream' 
  },
  { 
    value: 'custom-electrs', 
    label: 'Custom Electrs/Esplora', 
    description: 'Your own Electrs or Esplora server' 
  },
  { 
    value: 'custom-mempool', 
    label: 'Custom Mempool', 
    description: 'Your own mempool.space instance' 
  },
];

export default function NodeSettings() {
  const { nodeSettings, updateSettings, resetToDefaults, isLoading } = useNodeSettings();
  const { desktopLockSettings } = useSettings();
  const { toast } = useToast();

  usePageShortcuts("Node Settings", [
    { keys: ["Enter"], action: "Add the entered trusted local host (while the host field is focused)" },
  ]);
  
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    blockHeight?: number;
    error?: string;
    latency?: number;
    providerName: string;
    testedUrl?: string;
  } | null>(null);
  
  const [isTorTesting, setIsTorTesting] = useState(false);
  const [torTestResult, setTorTestResult] = useState<TorTestResult | null>(null);
  
  const [isElectrumTesting, setIsElectrumTesting] = useState(false);
  const [electrumTestResult, setElectrumTestResult] = useState<ElectrumTestResult | null>(null);
  // TLS trust prompt state: set when the server presents a certificate that is
  // not CA-verified and not pinned yet (or whose fingerprint changed).
  const [electrumTrustPrompt, setElectrumTrustPrompt] = useState<{
    host: string;
    port: number;
    errorCode: string;
    certificate: ElectrumCertificateInfo;
  } | null>(null);
  const [isTrustingCertificate, setIsTrustingCertificate] = useState(false);
  // Pinned (TOFU-trusted) certificate for the configured Electrum server, so
  // the user can review the active trust decision and revoke it.
  const [pinnedCertificate, setPinnedCertificate] = useState<
    (ElectrumCertificateInfo & { trustedAt?: number }) | null
  >(null);
  const [isRevokingCertificate, setIsRevokingCertificate] = useState(false);
  
  const [pendingChanges, setPendingChanges] = useState<Partial<NodeSettingsType>>({});
  const [pendingDesktopLockSettings, setPendingDesktopLockSettings] =
    useState<Partial<DesktopLockSettings>>({});
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [newLocalHost, setNewLocalHost] = useState('');
  
  const currentSettings: NodeSettingsType = {
    ...nodeSettings,
    ...pendingChanges,
    // Ensure trustedLocalHosts always has a value
    trustedLocalHosts: pendingChanges.trustedLocalHosts ?? nodeSettings.trustedLocalHosts ?? [...DEFAULT_TRUSTED_LOCAL_HOSTS],
  };
  const currentDesktopLockSettings: DesktopLockSettings = {
    ...desktopLockSettings,
    ...pendingDesktopLockSettings,
  };
  
  const hasCustomProvider = currentSettings.providerType === 'custom-electrs' || 
                            currentSettings.providerType === 'custom-mempool';
  
  const privacyInfo = getProviderPrivacyInfo(currentSettings.providerType, currentSettings.useTor);
  
  const handleProviderChange = (value: NodeProviderType) => {
    const newCustomUrl = value.startsWith('custom-') ? pendingChanges.customUrl || currentSettings.customUrl : undefined;
    const torInfo = getTorAvailability(value, newCustomUrl);
    
    setPendingChanges(prev => ({ 
      ...prev, 
      providerType: value,
      customUrl: newCustomUrl,
      // Preserve useTor, but disable if not available for new provider
      useTor: torInfo.available ? (prev.useTor ?? currentSettings.useTor ?? false) : false,
    }));
    setTestResult(null);
  };
  
  const handleCustomUrlChange = (url: string) => {
    const torInfo = getTorAvailability(currentSettings.providerType, url);
    
    setPendingChanges(prev => {
      let newUseTor = prev.useTor ?? currentSettings.useTor ?? false;
      
      // Auto-enable Tor for .onion URLs
      if (torInfo.autoEnable) {
        newUseTor = true;
      }
      // Disable Tor if URL is local
      if (!torInfo.available) {
        newUseTor = false;
      }
      
      return { 
        ...prev, 
        customUrl: url,
        useTor: newUseTor,
      };
    });
    setTestResult(null);
  };
  
  const handleTorToggle = (enabled: boolean) => {
    setPendingChanges(prev => ({ 
      ...prev, 
      useTor: enabled,
      requestTimeout: enabled && (prev.requestTimeout || currentSettings.requestTimeout) < 60000 
        ? 60000 
        : prev.requestTimeout || currentSettings.requestTimeout,
    }));
    setTestResult(null);
  };
  
  const handleTestTor = async () => {
    setIsTorTesting(true);
    setTorTestResult(null);
    
    try {
      // Push the current (including unsaved) settings so the proxy tests the
      // configured custom SOCKS proxy server-side.
      await syncTorProxySettings(torProxySettingsFromNodeSettings(currentSettings));
      const result = await testTorConnectivity();
      setTorTestResult(result);
      
      if (result.success) {
        toast({
          title: "Tor Connected",
          description: `Connected via ${result.proxyName}. Exit IP: ${result.torIp}`,
        });
        
        // Auto-save the detected working proxy URL so it's used for syncs.
        // Newer desktop builds omit proxyUrl from the IPC payload; map the
        // proxy name back to its known built-in URL ("Custom" needs no update
        // since the setting already holds the custom URL).
        const builtInProxyUrls: Record<string, string> = {
          "Tor Browser": "socks5h://127.0.0.1:9150",
          "Tor Service": "socks5h://127.0.0.1:9050",
        };
        const detectedProxyUrl =
          result.proxyUrl ?? (result.proxyName ? builtInProxyUrls[result.proxyName] : undefined);
        if (detectedProxyUrl && detectedProxyUrl !== currentSettings.torProxyUrl) {
          try {
            await updateSettings({ torProxyUrl: detectedProxyUrl });
            setPendingChanges(prev => {
              const { torProxyUrl, ...rest } = prev;
              return rest;
            });
          } catch (saveError) {
            // If auto-save fails, keep it as a pending change so user can save manually
            setPendingChanges(prev => ({ ...prev, torProxyUrl: detectedProxyUrl }));
            console.error('[KYUTXO] Failed to auto-save Tor proxy URL:', saveError);
          }
        }
      } else {
        toast({
          title: "Tor Not Available",
          description: result.error || "Could not connect to Tor",
          variant: "destructive",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      setTorTestResult({
        success: false,
        error: errorMessage,
      });
      toast({
        title: "Tor Test Failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsTorTesting(false);
    }
  };
  
  const handleTimeoutChange = (value: number[]) => {
    setPendingChanges(prev => ({ ...prev, requestTimeout: value[0] * 1000 }));
  };
  
  const handleNetworkChange = (value: 'mainnet' | 'testnet') => {
    setPendingChanges(prev => ({ ...prev, network: value }));
    setTestResult(null);
  };
  
  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    
    try {
      const result = await testConnectionWithSettings(currentSettings);
      setTestResult(result);
      
      if (result.success) {
        toast({
          title: "Connection Successful",
          description: `Connected to ${result.providerName}. Block height: ${result.blockHeight?.toLocaleString()}`,
        });
      } else {
        toast({
          title: "Connection Failed",
          description: result.error || "Could not connect to the node",
          variant: "destructive",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Build the testedUrl for diagnostics
      let testedUrl: string | undefined;
      if (currentSettings.providerType === 'custom-mempool' && currentSettings.customUrl) {
        const baseUrl = currentSettings.customUrl.endsWith('/api') 
          ? currentSettings.customUrl 
          : `${currentSettings.customUrl}/api`;
        testedUrl = `${baseUrl}/blocks/tip/height`;
      }
      setTestResult({
        success: false,
        error: errorMessage,
        providerName: getProviderDisplayName(currentSettings.providerType),
        testedUrl,
      });
      toast({
        title: "Connection Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsTesting(false);
    }
  };
  
  const handleSaveSettings = async () => {
    if (isSavingSettings) return;
    if (hasCustomProvider && !currentSettings.customUrl?.trim()) {
      toast({
        title: "Missing URL",
        description: "Please enter a server URL for your custom node",
        variant: "destructive",
      });
      return;
    }

    setIsSavingSettings(true);
    try {
      // Normalize electrumHost before saving - remove http:// prefix
      const settingsToSave = { ...pendingChanges };
      if (settingsToSave.torProxyUrl !== undefined) {
        const normalizedProxy = canonicalizeTorProxyUrl(settingsToSave.torProxyUrl);
        if (!normalizedProxy.ok) {
          toast({
            title: "Invalid Tor Proxy",
            description: normalizedProxy.error,
            variant: "destructive",
          });
          return;
        }
        settingsToSave.torProxyUrl = normalizedProxy.value;
      }
      if (settingsToSave.electrumHost) {
        settingsToSave.electrumHost = settingsToSave.electrumHost
          .replace(/^https?:\/\//i, '')
          .replace(/\/+$/, '')
          .trim();
      }
      if (Object.keys(settingsToSave).length > 0) {
        await updateSettings(settingsToSave);
      }
      if (Object.keys(pendingDesktopLockSettings).length > 0) {
        await updateDesktopLockSettings(currentDesktopLockSettings);
      }
      setPendingChanges({});
      setPendingDesktopLockSettings({});
      toast({
        title: "Settings Saved",
        description: "Your node connection settings have been updated",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to save settings",
        variant: "destructive",
      });
    } finally {
      setIsSavingSettings(false);
    }
  };
  
  const handleReset = async () => {
    await resetToDefaults();
    setPendingChanges({});
    setTestResult(null);
    toast({
      title: "Settings Reset",
      description: "Node settings have been reset to defaults",
    });
  };
  
  // Helper functions for managing trusted local hosts
  const handleAddLocalHost = () => {
    const host = newLocalHost.trim().toLowerCase();
    if (!host) return;
    
    // Basic validation: must be an IP, hostname, or domain-like pattern
    const isValidHost = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || 
                        /^(\d{1,3}\.){0,3}\d{0,3}$/.test(host);
    
    if (!isValidHost) {
      toast({
        title: "Invalid Host",
        description: "Please enter a valid IP address or hostname",
        variant: "destructive",
      });
      return;
    }
    
    const existingHosts = currentSettings.trustedLocalHosts || [];
    if (existingHosts.includes(host)) {
      toast({
        title: "Already Added",
        description: `"${host}" is already in your trusted hosts list`,
        variant: "destructive",
      });
      return;
    }
    
    setPendingChanges(prev => ({
      ...prev,
      trustedLocalHosts: [...existingHosts, host],
    }));
    setNewLocalHost('');
    toast({
      title: "Host Added",
      description: `"${host}" added to trusted hosts. Click "Save Settings" to apply.`,
    });
  };
  
  const handleRemoveLocalHost = (hostToRemove: string) => {
    const existingHosts = currentSettings.trustedLocalHosts || [];
    setPendingChanges(prev => ({
      ...prev,
      trustedLocalHosts: existingHosts.filter(h => h !== hostToRemove),
    }));
  };
  
  const handleResetLocalHosts = () => {
    setPendingChanges(prev => ({
      ...prev,
      trustedLocalHosts: [...DEFAULT_TRUSTED_LOCAL_HOSTS],
    }));
    toast({
      title: "Hosts Reset",
      description: "Trusted hosts reset to defaults. Click \"Save Settings\" to apply.",
    });
  };
  
  const handleTestElectrum = async () => {
    if (!isElectron()) {
      toast({
        title: "Not Available",
        description: "Electrum protocol requires the desktop app",
        variant: "destructive",
      });
      return;
    }
    
    // Clean the host - remove http:// prefix in case it's still in stored settings
    let host = currentSettings.electrumHost?.trim() || '';
    host = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const port = currentSettings.electrumPort || 50001;
    
    if (!host) {
      toast({
        title: "Missing Host",
        description: "Please enter an Electrum server host",
        variant: "destructive",
      });
      return;
    }
    
    console.log(`[NodeSettings] Testing Electrum connection to ${host}:${port}`);

    setIsElectrumTesting(true);
    setElectrumTestResult(null);
    setElectrumTrustPrompt(null);

    try {
      const api = getElectronAPI();
      const result = await api.electrumTest({
        host,
        port,
        useSSL: currentSettings.electrumSSL ?? false,
        timeout: currentSettings.requestTimeout || 30000,
        // Route through the configured Tor proxy when Tor is enabled (this is
        // also what makes .onion Electrum hosts reachable).
        useTor: currentSettings.useTor ?? false,
        torProxyUrl: currentSettings.torProxyUrl,
      });

      setElectrumTestResult(result);

      if (result.success) {
        toast({
          title: "Electrum Connected",
          description: `${result.serverVersion} - Block height: ${result.blockHeight?.toLocaleString()} (${result.transport === 'tor' ? 'via Tor' : 'direct'})`,
        });
      } else if (
        (result.errorCode === 'CERT_UNTRUSTED' || result.errorCode === 'CERT_FINGERPRINT_CHANGED') &&
        result.certificate
      ) {
        // TLS trust decision required — show the fingerprint prompt instead
        // of a plain error toast so the user can verify + pin the cert.
        setElectrumTrustPrompt({
          host,
          port,
          errorCode: result.errorCode,
          certificate: result.certificate,
        });
        toast({
          title: result.errorCode === 'CERT_FINGERPRINT_CHANGED' ? "Certificate Changed" : "Untrusted Certificate",
          description: "Verify the certificate fingerprint below before connecting.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Connection Failed",
          description: result.error || "Could not connect to Electrum server",
          variant: "destructive",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      setElectrumTestResult({
        success: false,
        error: errorMessage,
      });
      toast({
        title: "Connection Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsElectrumTesting(false);
    }
  };
  
  // User confirmed the certificate fingerprint in the trust dialog — persist
  // the pin in the main process and immediately retry the connection test.
  const handleTrustElectrumCertificate = async () => {
    if (!electrumTrustPrompt) return;
    setIsTrustingCertificate(true);
    try {
      const api = getElectronAPI();
      const result = await api.electrumTrustCertificate({
        host: electrumTrustPrompt.host,
        port: electrumTrustPrompt.port,
        certificate: electrumTrustPrompt.certificate,
      });
      if (!result.success) {
        toast({
          title: "Trust Failed",
          description: result.error || "Could not save the certificate trust decision",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Certificate Trusted",
        description: "The fingerprint was saved. Future connections must present the same certificate.",
      });
      setElectrumTrustPrompt(null);
      setCertTrustRefresh((n) => n + 1);
      await handleTestElectrum();
    } catch (error) {
      toast({
        title: "Trust Failed",
        description: error instanceof Error ? error.message : "Could not save the certificate trust decision",
        variant: "destructive",
      });
    } finally {
      setIsTrustingCertificate(false);
    }
  };

  // Keep the pinned-certificate display in sync with the configured Electrum
  // server. Re-runs after trust/revoke via the refresh counter.
  const [certTrustRefresh, setCertTrustRefresh] = useState(0);
  const electrumHostForTrust = (currentSettings.electrumHost || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const electrumPortForTrust = currentSettings.electrumPort || 50001;
  useEffect(() => {
    if (!isElectron() || !electrumHostForTrust) {
      setPinnedCertificate(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const api = getElectronAPI();
        if (typeof api.electrumGetCertificateTrust !== 'function') return;
        const result = await api.electrumGetCertificateTrust({
          host: electrumHostForTrust,
          port: electrumPortForTrust,
        });
        if (!cancelled) {
          setPinnedCertificate(result.success ? result.pinned : null);
        }
      } catch {
        if (!cancelled) setPinnedCertificate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [electrumHostForTrust, electrumPortForTrust, certTrustRefresh]);

  // Revoke the pinned certificate for the configured server. The next SSL
  // connection re-prompts the TOFU trust dialog.
  const handleRevokeElectrumCertificate = async () => {
    if (!electrumHostForTrust) return;
    setIsRevokingCertificate(true);
    try {
      const api = getElectronAPI();
      const result = await api.electrumRevokeCertificate({
        host: electrumHostForTrust,
        port: electrumPortForTrust,
      });
      if (!result.success) {
        toast({
          title: "Revoke Failed",
          description: result.error || "Could not remove the certificate trust",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Trust Removed",
        description: result.revoked
          ? "The pinned certificate was removed. The next connection will ask you to verify the server's certificate again."
          : "No pinned certificate was found for this server.",
      });
      setPinnedCertificate(null);
      setElectrumTestResult(null);
      setCertTrustRefresh((n) => n + 1);
    } catch (error) {
      toast({
        title: "Revoke Failed",
        description: error instanceof Error ? error.message : "Could not remove the certificate trust",
        variant: "destructive",
      });
    } finally {
      setIsRevokingCertificate(false);
    }
  };

  const hasPendingChanges =
    Object.keys(pendingChanges).length > 0 ||
    Object.keys(pendingDesktopLockSettings).length > 0;
  
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 space-y-6 pb-8 max-w-3xl mx-auto">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Server className="h-6 w-6" />
            Node Connection
          </h1>
          <p className="text-muted-foreground mt-1">
            Configure how the app connects to the Bitcoin network for syncing transaction data
          </p>
        </div>
      
      {/* Privacy Warning for Public APIs */}
      <Alert variant={privacyInfo.level === 'low' ? 'destructive' : privacyInfo.level === 'medium' ? 'default' : 'default'}>
        <Shield className="h-4 w-4" />
        <AlertTitle className="flex items-center gap-2">
          Privacy Level: 
          <Badge 
            variant={privacyInfo.level === 'high' ? 'default' : privacyInfo.level === 'medium' ? 'secondary' : 'destructive'}
            className={privacyInfo.level === 'high' ? 'bg-green-600' : ''}
          >
            {privacyInfo.level === 'high' ? 'High' : privacyInfo.level === 'medium' ? 'Medium' : 'Low'}
          </Badge>
        </AlertTitle>
        <AlertDescription>{privacyInfo.description}</AlertDescription>
      </Alert>

      {isElectron() && (
        <Card data-testid="card-desktop-vault-lock">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Desktop Vault Lock
            </CardTitle>
            <CardDescription>
              Automatically lock the vault when you step away or the computer changes state.
              These settings apply to this desktop installation only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="idle-lock-timeout">Lock after inactivity</Label>
              <Select
                value={String(currentDesktopLockSettings.idleTimeoutSeconds)}
                onValueChange={(value) => {
                  setPendingDesktopLockSettings((previous) => ({
                    ...previous,
                    idleTimeoutSeconds: Number(value) as DesktopLockSettings["idleTimeoutSeconds"],
                  }));
                }}
              >
                <SelectTrigger id="idle-lock-timeout" data-testid="select-idle-lock-timeout">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="60">After 1 minute</SelectItem>
                  <SelectItem value="300">After 5 minutes</SelectItem>
                  <SelectItem value="900">After 15 minutes</SelectItem>
                  <SelectItem value="1800">After 30 minutes</SelectItem>
                  <SelectItem value="3600">After 1 hour</SelectItem>
                  <SelectItem value="0">Never (not recommended)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A shorter timeout is safer in shared or public spaces. The five-minute choice
                is the secure default.
              </p>
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="lock-on-suspend">Lock when the computer suspends</Label>
                  <p className="text-sm text-muted-foreground">
                    Lock before sleep or hibernation.
                  </p>
                </div>
                <Switch
                  id="lock-on-suspend"
                  checked={currentDesktopLockSettings.lockOnSuspend}
                  onCheckedChange={(checked) =>
                    setPendingDesktopLockSettings((previous) => ({
                      ...previous,
                      lockOnSuspend: checked,
                    }))
                  }
                  data-testid="switch-lock-on-suspend"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="lock-on-resume">Lock when the computer resumes</Label>
                  <p className="text-sm text-muted-foreground">
                    Require unlocking after sleep or hibernation.
                  </p>
                </div>
                <Switch
                  id="lock-on-resume"
                  checked={currentDesktopLockSettings.lockOnResume}
                  onCheckedChange={(checked) =>
                    setPendingDesktopLockSettings((previous) => ({
                      ...previous,
                      lockOnResume: checked,
                    }))
                  }
                  data-testid="switch-lock-on-resume"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="lock-on-screen-lock">Lock when the screen locks</Label>
                  <p className="text-sm text-muted-foreground">
                    Keep the vault protected when your OS locks the display.
                  </p>
                </div>
                <Switch
                  id="lock-on-screen-lock"
                  checked={currentDesktopLockSettings.lockOnScreenLock}
                  onCheckedChange={(checked) =>
                    setPendingDesktopLockSettings((previous) => ({
                      ...previous,
                      lockOnScreenLock: checked,
                    }))
                  }
                  data-testid="switch-lock-on-screen-lock"
                />
              </div>
            </div>

            {!currentDesktopLockSettings.lockOnSuspend ||
              !currentDesktopLockSettings.lockOnResume ||
              !currentDesktopLockSettings.lockOnScreenLock ||
              currentDesktopLockSettings.idleTimeoutSeconds === 0 ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Some automatic lock protections are disabled. Your vault may remain open
                  while you are away from the computer.
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      )}
      
      {/* Provider Selection */}
      <Card className={currentSettings.useElectrum ? 'opacity-60' : ''}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" />
            HTTP Data Provider
            {currentSettings.useElectrum && (
              <Badge variant="outline" className="ml-2 text-xs text-muted-foreground">
                Overridden by Electrum
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {currentSettings.useElectrum 
              ? "Not used when Electrum protocol is enabled above"
              : "Choose where to fetch blockchain data from"
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {currentSettings.useElectrum && (
            <Alert>
              <AlertDescription className="text-sm">
                The Electrum protocol is enabled and will be used exclusively for syncing. 
                This HTTP provider setting is ignored.
              </AlertDescription>
            </Alert>
          )}
          <RadioGroup 
            value={currentSettings.providerType} 
            onValueChange={(v) => handleProviderChange(v as NodeProviderType)}
            className="space-y-3"
            disabled={currentSettings.useElectrum}
          >
            {PROVIDER_OPTIONS.map(option => (
              <div key={option.value} className="flex items-start space-x-3">
                <RadioGroupItem 
                  value={option.value} 
                  id={option.value}
                  data-testid={`radio-provider-${option.value}`}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={option.value} className="font-medium cursor-pointer">
                    {option.label}
                    {option.value.startsWith('custom-') && (
                      <Badge variant="outline" className="ml-2 text-xs">Self-hosted</Badge>
                    )}
                  </Label>
                  <p className="text-sm text-muted-foreground">{option.description}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
          
          {/* Custom URL Input */}
          {hasCustomProvider && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="customUrl">Server URL</Label>
              <Input
                id="customUrl"
                placeholder={
                  currentSettings.providerType === 'custom-electrs' 
                    ? "http://192.168.1.100:3002 or http://xyz.onion:3002"
                    : "http://192.168.1.100:3006 or http://xyz.onion"
                }
                value={currentSettings.customUrl || ''}
                onChange={(e) => handleCustomUrlChange(e.target.value)}
                data-testid="input-custom-url"
              />
              <p className="text-xs text-muted-foreground">
                {currentSettings.providerType === 'custom-electrs' 
                  ? "Enter the URL of your Electrs or Esplora API endpoint"
                  : "Enter the URL of your mempool instance (without /api suffix)"
                }
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Tor Settings */}
      {(() => {
        const torInfo = getTorAvailability(currentSettings.providerType, currentSettings.customUrl);
        const urlClassification = hasCustomProvider ? classifyUrl(currentSettings.customUrl) : null;
        
        return (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Tor / Privacy Settings
              </CardTitle>
              <CardDescription>
                Route connections through Tor for enhanced privacy
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="useTor" className={`font-medium ${!torInfo.available ? 'text-muted-foreground' : ''}`}>
                    Use Tor
                    {urlClassification === 'onion' && (
                      <Badge variant="outline" className="ml-2 text-xs bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800">
                        Required for .onion
                      </Badge>
                    )}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {torInfo.available 
                      ? "Connect via Tor hidden services (.onion addresses)"
                      : torInfo.reason
                    }
                  </p>
                </div>
                <Switch
                  id="useTor"
                  checked={currentSettings.useTor ?? false}
                  onCheckedChange={handleTorToggle}
                  disabled={!torInfo.available}
                  data-testid="switch-use-tor"
                />
              </div>
              
              {/* Show hint for custom providers without URL */}
              {hasCustomProvider && !currentSettings.customUrl && (
                <p className="text-xs text-muted-foreground italic">
                  Enter a server URL above to configure Tor availability
                </p>
              )}
              
              {currentSettings.useTor && (
                <>
                  <Separator />
                  
                  {/* Tor Test Result */}
                  {torTestResult && (
                    <div className={`p-3 rounded-md ${torTestResult.success ? 'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800' : 'bg-destructive/10 border border-destructive/20'}`}>
                      <div className="flex items-center gap-2">
                        {torTestResult.success ? (
                          <CheckCircle2 className="h-5 w-5 text-green-600" />
                        ) : (
                          <AlertTriangle className="h-5 w-5 text-destructive" />
                        )}
                        <div>
                          <p className="font-medium">
                            {torTestResult.success ? 'Tor Connected' : 'Tor Not Available'}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {torTestResult.success 
                              ? `${torTestResult.proxyName} - Exit IP: ${torTestResult.torIp} (${torTestResult.latency}ms)`
                              : torTestResult.error
                            }
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <Button
                    onClick={handleTestTor}
                    disabled={isTorTesting}
                    variant="outline"
                    className="w-full"
                    data-testid="button-test-tor"
                  >
                    {isTorTesting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Testing Tor Connection...
                      </>
                    ) : (
                      <>
                        <Shield className="h-4 w-4 mr-2" />
                        Test Tor Connection
                      </>
                    )}
                  </Button>
                  
                  <div className="space-y-2">
                    <Label htmlFor="torProxy">Tor SOCKS Proxy (Optional)</Label>
                    <Input
                      id="torProxy"
                      placeholder="Leave empty for auto-detect"
                      value={currentSettings.torProxyUrl || ''}
                      onChange={(e) => setPendingChanges(prev => ({ ...prev, torProxyUrl: e.target.value }))}
                      data-testid="input-tor-proxy"
                    />
                    <p className="text-xs text-muted-foreground">
                      Use socks5h://host:port so destination DNS is resolved through Tor. Leave empty to auto-detect Tor Browser (port 9150) or Tor service (port 9050).
                    </p>
                  </div>
                  
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertTitle>How to Get Tor Running</AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>Choose one of these options:</p>
                      <ul className="list-disc list-inside text-sm space-y-1 mt-2">
                        <li><strong>Tor Browser</strong> - Download from torproject.org, keep it running in background (uses port 9150)</li>
                        <li><strong>Tor Expert Bundle</strong> - For advanced users who want Tor as a background service (uses port 9050)</li>
                      </ul>
                      {urlClassification !== 'onion' && (
                        <p className="mt-2 text-amber-600 dark:text-amber-400">
                          For maximum privacy, use a .onion address for your node.
                        </p>
                      )}
                    </AlertDescription>
                  </Alert>
                </>
              )}
            </CardContent>
          </Card>
        );
      })()}
      
      {/* Local Network Access - for direct local network connections */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Home className="h-4 w-4" />
            Local Network Access
          </CardTitle>
          <CardDescription>
            Allow connections to local network devices like your home Bitcoin node
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Security toggle for local network access */}
          <div className="flex items-center justify-between p-3 border rounded-lg">
            <div className="space-y-1">
              <Label htmlFor="allow-local-network" className="text-sm font-medium">
                Enable Local Network Access
              </Label>
              <p className="text-xs text-muted-foreground">
                Allow direct connections to local IPs and hostnames
              </p>
            </div>
            <Switch
              id="allow-local-network"
              checked={currentSettings.allowLocalNetwork ?? false}
              onCheckedChange={(checked) => {
                setPendingChanges(prev => ({ ...prev, allowLocalNetwork: checked }));
              }}
              data-testid="switch-allow-local-network"
            />
          </div>
          
          {/* Security warning */}
          <Alert variant={currentSettings.allowLocalNetwork ? "default" : "destructive"}>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm">
              {currentSettings.allowLocalNetwork ? (
                <>
                  <strong>Security Notice:</strong> Local network access is enabled. Only use this on trusted networks 
                  (like your home or office). On public WiFi, this could expose your connection to local attackers.
                </>
              ) : (
                <>
                  Local network access is disabled for security. Enable it only when you need to connect 
                  to a local Bitcoin node and you are on a trusted network.
                </>
              )}
            </AlertDescription>
          </Alert>
          
          {/* Trusted hosts configuration - only shown when enabled */}
          {currentSettings.allowLocalNetwork && (
            <>
              <div className="pt-2 space-y-3">
                <Label className="text-sm font-medium">Trusted Hosts</Label>
                <p className="text-xs text-muted-foreground">
                  Connections to these addresses will bypass Tor for faster direct access.
                </p>
              </div>
              
              {/* Add new host */}
              <div className="flex gap-2">
                <Input
                  placeholder="e.g., 192.168.1.50 or umbrel.local"
                  value={newLocalHost}
                  onChange={(e) => setNewLocalHost(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddLocalHost()}
                  data-testid="input-new-local-host"
                />
                <Button 
                  onClick={handleAddLocalHost}
              disabled={!newLocalHost.trim()}
              data-testid="button-add-local-host"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>
          
          {/* List of trusted hosts */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {(currentSettings.trustedLocalHosts || []).map((host) => (
                <Badge 
                  key={host} 
                  variant="secondary" 
                  className="flex items-center gap-1 pl-2 pr-1 py-1"
                >
                  <span className="font-mono text-xs">{host}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-4 w-4 p-0 hover:bg-destructive/20"
                    onClick={() => handleRemoveLocalHost(host)}
                    data-testid={`button-remove-host-${host}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </Badge>
              ))}
              {(currentSettings.trustedLocalHosts || []).length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No trusted hosts configured. Local network connections will be blocked.
                </p>
              )}
              </div>
            </div>
            
            {/* Reset to defaults button */}
            <Button 
              variant="outline" 
              size="sm"
              onClick={handleResetLocalHosts}
              data-testid="button-reset-local-hosts"
            >
              Reset to Defaults
            </Button>
          </>
          )}
        </CardContent>
      </Card>
      
      {/* Electrum Protocol Settings */}
      {isElectron() && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Electrum Protocol
              <Badge variant="secondary" className="ml-2 text-xs">Fast Sync</Badge>
            </CardTitle>
            <CardDescription>
              Connect directly to your Electrum server for efficient bulk address syncing (10,000+)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div className="space-y-1">
                <Label htmlFor="use-electrum" className="text-sm font-medium">
                  Use Electrum Protocol
                </Label>
                <p className="text-xs text-muted-foreground">
                  Much faster than HTTP API for syncing many addresses
                </p>
              </div>
              <Switch
                id="use-electrum"
                checked={currentSettings.useElectrum ?? false}
                onCheckedChange={(checked) => {
                  setPendingChanges(prev => ({ ...prev, useElectrum: checked }));
                  setElectrumTestResult(null);
                }}
                data-testid="switch-use-electrum"
              />
            </div>
            
            {currentSettings.useTor ? (
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Tor is enabled — Electrum connections route through your Tor SOCKS proxy
                  {currentSettings.torProxyUrl ? ` (${currentSettings.torProxyUrl})` : ' (auto-detected)'}.
                  Onion (.onion) Electrum hosts are supported.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Electrum connections are made directly over the internet — the server (and your ISP) can see your IP address. Enable Tor above to route Electrum through the Tor network instead.
                </AlertDescription>
              </Alert>
            )}

            {currentSettings.useElectrum && (
              <>
                <div className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Label>Server Software</Label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Select what your node is running. This sets recommended defaults but you can adjust port and SSL independently below.
                    </p>
                    <RadioGroup
                      value={currentSettings.electrumServerType || 'electrs'}
                      onValueChange={(v) => {
                        const serverType = v as 'electrs' | 'fulcrum';
                        const defaults = serverType === 'fulcrum'
                          ? { electrumPort: 50002, electrumSSL: true }
                          : { electrumPort: 50001, electrumSSL: false };
                        setPendingChanges(prev => ({
                          ...prev,
                          electrumServerType: serverType,
                          ...defaults,
                        }));
                        setElectrumTestResult(null);
                      }}
                      className="grid grid-cols-2 gap-3"
                      data-testid="radio-electrum-server-type"
                    >
                      <div className="flex items-start space-x-3 p-3 border rounded-lg">
                        <RadioGroupItem value="electrs" id="electrs" className="mt-0.5" data-testid="radio-electrs" />
                        <div className="grid gap-0.5">
                          <Label htmlFor="electrs" className="font-medium cursor-pointer">Electrs</Label>
                          <p className="text-xs text-muted-foreground">Default: port 50001, no SSL</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3 p-3 border rounded-lg">
                        <RadioGroupItem value="fulcrum" id="fulcrum" className="mt-0.5" data-testid="radio-fulcrum" />
                        <div className="grid gap-0.5">
                          <Label htmlFor="fulcrum" className="font-medium cursor-pointer">Fulcrum</Label>
                          <p className="text-xs text-muted-foreground">Default: port 50002, SSL</p>
                        </div>
                      </div>
                    </RadioGroup>
                  </div>

                  <Separator />

                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="electrumHost">Server Host</Label>
                      <Input
                        id="electrumHost"
                        placeholder="192.168.4.118"
                        value={currentSettings.electrumHost || ''}
                        onChange={(e) => {
                          let value = e.target.value;
                          if (value.toLowerCase().startsWith('http://') || value.toLowerCase().startsWith('https://')) {
                            value = value.replace(/^https?:\/\//i, '');
                          }
                          setPendingChanges(prev => ({ ...prev, electrumHost: value }));
                          setElectrumTestResult(null);
                        }}
                        data-testid="input-electrum-host"
                      />
                      <p className="text-xs text-muted-foreground">
                        IP address or hostname only (no http:// prefix)
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="electrumPort">Port</Label>
                      <Input
                        id="electrumPort"
                        type="number"
                        placeholder={currentSettings.electrumServerType === 'fulcrum' ? '50002' : '50001'}
                        value={currentSettings.electrumPort || (currentSettings.electrumServerType === 'fulcrum' ? 50002 : 50001)}
                        onChange={(e) => {
                          setPendingChanges(prev => ({ ...prev, electrumPort: parseInt(e.target.value) || 50001 }));
                          setElectrumTestResult(null);
                        }}
                        data-testid="input-electrum-port"
                      />
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="space-y-1">
                      <Label htmlFor="electrum-ssl" className="text-sm font-medium">
                        Use SSL/TLS
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {currentSettings.electrumServerType === 'fulcrum'
                          ? "Fulcrum usually has SSL enabled, but check your node's settings"
                          : "Electrs typically does not use SSL"
                        }
                      </p>
                    </div>
                    <Switch
                      id="electrum-ssl"
                      checked={currentSettings.electrumSSL ?? false}
                      onCheckedChange={(checked) => {
                        setPendingChanges(prev => ({ 
                          ...prev, 
                          electrumSSL: checked,
                        }));
                        setElectrumTestResult(null);
                      }}
                      data-testid="switch-electrum-ssl"
                    />
                  </div>

                  {/* Pinned (TOFU-trusted) certificate for this server */}
                  {pinnedCertificate && (
                    <div
                      className="p-3 border rounded-lg space-y-2"
                      data-testid="panel-electrum-pinned-cert"
                    >
                      <div className="flex items-center gap-2">
                        <Shield className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm font-medium">Trusted Certificate</p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        This server's certificate fingerprint is pinned. Connections fail if the
                        server ever presents a different certificate.
                      </p>
                      <div className="space-y-1 text-xs">
                        <p className="font-mono break-all" data-testid="text-pinned-cert-fingerprint">
                          {pinnedCertificate.fingerprint}
                        </p>
                        {pinnedCertificate.subject && (
                          <p className="text-muted-foreground">Subject: {pinnedCertificate.subject}</p>
                        )}
                        {pinnedCertificate.trustedAt && (
                          <p className="text-muted-foreground" data-testid="text-pinned-cert-trusted-at">
                            Trusted on {new Date(pinnedCertificate.trustedAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRevokeElectrumCertificate}
                        disabled={isRevokingCertificate}
                        data-testid="button-revoke-electrum-cert"
                      >
                        {isRevokingCertificate ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Removing...
                          </>
                        ) : (
                          <>
                            <X className="h-4 w-4 mr-2" />
                            Remove trust
                          </>
                        )}
                      </Button>
                    </div>
                  )}

                  {/* Contextual tip based on current settings */}
                  {currentSettings.electrumServerType === 'fulcrum' && !(currentSettings.electrumSSL ?? false) && (
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertDescription className="text-sm">
                        Fulcrum often uses SSL on port 50002, but some setups (like Umbrel) may have SSL disabled. 
                        If connection fails, check your node's Fulcrum settings to confirm whether SSL is on or off.
                      </AlertDescription>
                    </Alert>
                  )}
                  
                  {electrumTestResult && (
                    <div className={`p-3 rounded-md ${electrumTestResult.success ? 'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800' : 'bg-destructive/10 border border-destructive/20'}`}>
                      <div className="flex items-center gap-2">
                        {electrumTestResult.success ? (
                          <CheckCircle2 className="h-5 w-5 text-green-600" />
                        ) : (
                          <AlertTriangle className="h-5 w-5 text-destructive" />
                        )}
                        <div>
                          <p className="font-medium">
                            {electrumTestResult.success ? 'Connection Successful' : 'Connection Failed'}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {electrumTestResult.success
                              ? `${electrumTestResult.serverVersion} - Block: ${electrumTestResult.blockHeight?.toLocaleString()} (${electrumTestResult.latency}ms)`
                              : electrumTestResult.error
                            }
                          </p>
                          {electrumTestResult.success && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              <Badge variant="secondary" className="text-xs" data-testid="badge-electrum-transport">
                                {electrumTestResult.transport === 'tor' ? 'Transport: Tor' : 'Transport: Direct'}
                              </Badge>
                              {electrumTestResult.certificate && (
                                <Badge
                                  variant={electrumTestResult.certificate.trust === 'ca' ? 'secondary' : 'outline'}
                                  className="text-xs"
                                  data-testid="badge-electrum-cert-trust"
                                >
                                  {electrumTestResult.certificate.trust === 'ca'
                                    ? 'Certificate: CA verified'
                                    : 'Certificate: trusted fingerprint'}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <Button
                    onClick={handleTestElectrum}
                    disabled={isElectrumTesting || !currentSettings.electrumHost?.trim()}
                    variant="outline"
                    className="w-full"
                    data-testid="button-test-electrum"
                  >
                    {isElectrumTesting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Testing Connection...
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4 mr-2" />
                        Test Electrum Connection
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
      
      {/* Connection Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Connection Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Network Selection */}
          <div className="space-y-2">
            <Label>Bitcoin Network</Label>
            <Select 
              value={currentSettings.network} 
              onValueChange={(v) => handleNetworkChange(v as 'mainnet' | 'testnet')}
            >
              <SelectTrigger data-testid="select-network">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mainnet">Mainnet</SelectItem>
                <SelectItem value="testnet">Testnet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          {/* Timeout Slider */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Request Timeout</Label>
              <span className="text-sm text-muted-foreground">
                {Math.round(currentSettings.requestTimeout / 1000)}s
              </span>
            </div>
            <Slider
              value={[currentSettings.requestTimeout / 1000]}
              onValueChange={handleTimeoutChange}
              min={10}
              max={180}
              step={5}
              className="w-full"
              data-testid="slider-timeout"
            />
            <p className="text-xs text-muted-foreground">
              {currentSettings.useTor 
                ? "Tor connections are slower. Consider 60-120 seconds for reliable syncing."
                : "Time to wait for each API response. Increase for slow connections."
              }
            </p>
          </div>
        </CardContent>
      </Card>
      
      {/* Connection Status / Test */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {testResult?.success ? (
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            ) : testResult ? (
              <WifiOff className="h-4 w-4 text-destructive" />
            ) : (
              <Wifi className="h-4 w-4" />
            )}
            Connection Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {testResult && (
            <div className={`p-3 rounded-md ${testResult.success ? 'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800' : 'bg-destructive/10 border border-destructive/20'}`}>
              <div className="flex items-start gap-2">
                {testResult.success ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {testResult.success ? 'Connected' : 'Connection Failed'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {testResult.success 
                      ? `${testResult.providerName} - Block ${testResult.blockHeight?.toLocaleString()} (${testResult.latency}ms)`
                      : testResult.error
                    }
                  </p>
                  {testResult.testedUrl && (
                    <p className="text-xs text-muted-foreground mt-1 break-all">
                      Tested: {testResult.testedUrl}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
          
          {nodeSettings.lastConnectedAt && !testResult && (
            <p className="text-sm text-muted-foreground">
              Last connected: {new Date(nodeSettings.lastConnectedAt).toLocaleString()}
            </p>
          )}
          
          <Button
            onClick={handleTestConnection}
            disabled={isTesting}
            variant="outline"
            className="w-full"
            data-testid="button-test-connection"
          >
            {isTesting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Testing Connection...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Test Connection
              </>
            )}
          </Button>
        </CardContent>
      </Card>
      
      {/* Save / Reset Buttons */}
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSaveSettings}
          disabled={!hasPendingChanges || isSavingSettings}
          className="flex-1"
          data-testid="button-save-settings"
        >
          {isSavingSettings ? "Saving..." : "Save Settings"}
        </Button>
        <Button
          onClick={handleReset}
          disabled={isSavingSettings}
          variant="outline"
          data-testid="button-reset-settings"
        >
          Reset to Defaults
        </Button>
      </div>
      
      {hasPendingChanges && (
        <p className="text-sm text-center text-amber-600 dark:text-amber-400">
          You have unsaved changes
        </p>
      )}

      {/* Electrum TLS certificate trust prompt (TOFU) */}
      <AlertDialog
        open={electrumTrustPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setElectrumTrustPrompt(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-electrum-cert-trust">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              {electrumTrustPrompt?.errorCode === 'CERT_FINGERPRINT_CHANGED'
                ? 'Server Certificate Changed'
                : 'Untrusted Server Certificate'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {electrumTrustPrompt?.errorCode === 'CERT_FINGERPRINT_CHANGED' ? (
                  <p className="text-destructive font-medium">
                    The certificate presented by {electrumTrustPrompt?.host}:{electrumTrustPrompt?.port} does
                    NOT match the one you previously trusted. This can mean a man-in-the-middle attack.
                    Only re-trust if you have verified the new fingerprint with your server.
                  </p>
                ) : (
                  <p>
                    The certificate presented by {electrumTrustPrompt?.host}:{electrumTrustPrompt?.port} is
                    not signed by a trusted certificate authority. Self-signed certificates are common on
                    Electrum servers — verify the fingerprint with your server (e.g. in its settings or
                    documentation) before trusting it.
                  </p>
                )}
                <div className="rounded-md border p-3 space-y-1.5 font-mono text-xs break-all">
                  <div>
                    <span className="text-muted-foreground">SHA-256 fingerprint: </span>
                    <span data-testid="text-electrum-cert-fingerprint">{electrumTrustPrompt?.certificate.fingerprint}</span>
                  </div>
                  {electrumTrustPrompt?.certificate.expectedFingerprint && (
                    <div>
                      <span className="text-muted-foreground">Previously trusted: </span>
                      <span data-testid="text-electrum-cert-expected-fingerprint">{electrumTrustPrompt.certificate.expectedFingerprint}</span>
                    </div>
                  )}
                  {electrumTrustPrompt?.certificate.subject && (
                    <div>
                      <span className="text-muted-foreground">Subject: </span>
                      {electrumTrustPrompt.certificate.subject}
                    </div>
                  )}
                  {electrumTrustPrompt?.certificate.issuer && (
                    <div>
                      <span className="text-muted-foreground">Issuer: </span>
                      {electrumTrustPrompt.certificate.issuer}
                    </div>
                  )}
                  {electrumTrustPrompt?.certificate.validTo && (
                    <div>
                      <span className="text-muted-foreground">Valid until: </span>
                      {electrumTrustPrompt.certificate.validTo}
                    </div>
                  )}
                </div>
                <p className="text-muted-foreground">
                  Trusting pins this fingerprint to the server. Future connections must present the same
                  certificate — a different one will be rejected.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-electrum-cert-reject">Do Not Trust</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleTrustElectrumCertificate();
              }}
              disabled={isTrustingCertificate}
              data-testid="button-electrum-cert-trust"
            >
              {isTrustingCertificate ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Trusting...
                </>
              ) : (
                'Trust This Certificate'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  );
}
