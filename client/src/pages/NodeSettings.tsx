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
import { isElectron, getElectronAPI, ElectrumTestResult } from "@/lib/electron";
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
import { NodeProviderType, NodeSettings as NodeSettingsType, DEFAULT_TRUSTED_LOCAL_HOSTS } from "@/lib/database";
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
    
    // Check for localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return 'local';
    }
    
    // Check for .local domains (mDNS/Bonjour)
    if (hostname.endsWith('.local')) {
      return 'local';
    }
    
    // Check for private/RFC1918 IP addresses
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      // 10.0.0.0/8
      if (a === 10) return 'local';
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return 'local';
      // 192.168.0.0/16
      if (a === 192 && b === 168) return 'local';
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) return 'local';
    }
    
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
  const { toast } = useToast();
  
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
  
  const [pendingChanges, setPendingChanges] = useState<Partial<NodeSettingsType>>({});
  const [newLocalHost, setNewLocalHost] = useState('');
  
  const currentSettings: NodeSettingsType = {
    ...nodeSettings,
    ...pendingChanges,
    // Ensure trustedLocalHosts always has a value
    trustedLocalHosts: pendingChanges.trustedLocalHosts ?? nodeSettings.trustedLocalHosts ?? [...DEFAULT_TRUSTED_LOCAL_HOSTS],
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
      const result = await testTorConnectivity(currentSettings.torProxyUrl);
      setTorTestResult(result);
      
      if (result.success) {
        toast({
          title: "Tor Connected",
          description: `Connected via ${result.proxyName}. Exit IP: ${result.torIp}`,
        });
        
        // Auto-save the detected working proxy URL so it's used for syncs
        if (result.proxyUrl && result.proxyUrl !== currentSettings.torProxyUrl) {
          try {
            await updateSettings({ torProxyUrl: result.proxyUrl });
            setPendingChanges(prev => {
              const { torProxyUrl, ...rest } = prev;
              return rest;
            });
          } catch (saveError) {
            // If auto-save fails, keep it as a pending change so user can save manually
            setPendingChanges(prev => ({ ...prev, torProxyUrl: result.proxyUrl }));
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
    if (hasCustomProvider && !currentSettings.customUrl?.trim()) {
      toast({
        title: "Missing URL",
        description: "Please enter a server URL for your custom node",
        variant: "destructive",
      });
      return;
    }
    
    try {
      await updateSettings(pendingChanges);
      setPendingChanges({});
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
    
    const host = currentSettings.electrumHost?.trim();
    const port = currentSettings.electrumPort || 50001;
    
    if (!host) {
      toast({
        title: "Missing Host",
        description: "Please enter an Electrum server host",
        variant: "destructive",
      });
      return;
    }
    
    setIsElectrumTesting(true);
    setElectrumTestResult(null);
    
    try {
      const api = getElectronAPI();
      const result = await api.electrumTest({
        host,
        port,
        useSSL: currentSettings.electrumSSL ?? false,
        timeout: currentSettings.requestTimeout || 30000,
      });
      
      setElectrumTestResult(result);
      
      if (result.success) {
        toast({
          title: "Electrum Connected",
          description: `${result.serverVersion} - Block height: ${result.blockHeight?.toLocaleString()}`,
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
  
  const hasPendingChanges = Object.keys(pendingChanges).length > 0;
  
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
      
      {/* Provider Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Data Provider
          </CardTitle>
          <CardDescription>
            Choose where to fetch blockchain data from
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup 
            value={currentSettings.providerType} 
            onValueChange={(v) => handleProviderChange(v as NodeProviderType)}
            className="space-y-3"
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
                      Leave empty to auto-detect Tor Browser (port 9150) or Tor service (port 9050)
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
              Connect directly to Electrs using the Electrum protocol for faster syncing
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div className="space-y-1">
                <Label htmlFor="use-electrum" className="text-sm font-medium">
                  Use Electrum Protocol
                </Label>
                <p className="text-xs text-muted-foreground">
                  More efficient for syncing many addresses (10,000+)
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
            
            {currentSettings.useElectrum && (
              <>
                <div className="space-y-4 pt-2">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="electrumHost">Electrum Server Host</Label>
                      <Input
                        id="electrumHost"
                        placeholder="e.g., 192.168.4.118"
                        value={currentSettings.electrumHost || ''}
                        onChange={(e) => {
                          setPendingChanges(prev => ({ ...prev, electrumHost: e.target.value }));
                          setElectrumTestResult(null);
                        }}
                        data-testid="input-electrum-host"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="electrumPort">Port</Label>
                      <Input
                        id="electrumPort"
                        type="number"
                        placeholder="50001"
                        value={currentSettings.electrumPort || 50001}
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
                        Port 50002 typically uses SSL, port 50001 is unencrypted
                      </p>
                    </div>
                    <Switch
                      id="electrum-ssl"
                      checked={currentSettings.electrumSSL ?? false}
                      onCheckedChange={(checked) => {
                        const newPort = checked ? 50002 : 50001;
                        setPendingChanges(prev => ({ 
                          ...prev, 
                          electrumSSL: checked,
                          electrumPort: prev.electrumPort === 50001 || prev.electrumPort === 50002 ? newPort : prev.electrumPort,
                        }));
                        setElectrumTestResult(null);
                      }}
                      data-testid="switch-electrum-ssl"
                    />
                  </div>
                  
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
                        Testing Electrum Connection...
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4 mr-2" />
                        Test Electrum Connection
                      </>
                    )}
                  </Button>
                  
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertTitle>About Electrum Protocol</AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>The Electrum protocol connects directly to Electrs for efficient address queries:</p>
                      <ul className="list-disc list-inside text-sm space-y-1 mt-2">
                        <li><strong>Port 50001</strong> - Unencrypted TCP (for local network)</li>
                        <li><strong>Port 50002</strong> - Encrypted SSL/TLS</li>
                        <li>Much faster than HTTP API for bulk address syncing</li>
                      </ul>
                    </AlertDescription>
                  </Alert>
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
          disabled={!hasPendingChanges}
          className="flex-1"
          data-testid="button-save-settings"
        >
          Save Settings
        </Button>
        <Button
          onClick={handleReset}
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
      </div>
    </div>
  );
}
