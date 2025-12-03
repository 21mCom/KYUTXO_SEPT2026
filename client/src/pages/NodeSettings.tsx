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
  Info
} from "lucide-react";
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
import { NodeProviderType, NodeSettings as NodeSettingsType } from "@/lib/database";
import { 
  testConnectionWithSettings, 
  getProviderDisplayName, 
  getProviderPrivacyInfo 
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
  } | null>(null);
  
  const [pendingChanges, setPendingChanges] = useState<Partial<NodeSettingsType>>({});
  
  const currentSettings: NodeSettingsType = {
    ...nodeSettings,
    ...pendingChanges,
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
      setTestResult({
        success: false,
        error: errorMessage,
        providerName: getProviderDisplayName(currentSettings.providerType),
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
                  <div className="space-y-2">
                    <Label htmlFor="torProxy">Tor SOCKS Proxy</Label>
                    <Input
                      id="torProxy"
                      placeholder="socks5h://127.0.0.1:9050"
                      value={currentSettings.torProxyUrl || ''}
                      onChange={(e) => setPendingChanges(prev => ({ ...prev, torProxyUrl: e.target.value }))}
                      data-testid="input-tor-proxy"
                    />
                    <p className="text-xs text-muted-foreground">
                      SOCKS5 proxy URL for Tor. Default: socks5h://127.0.0.1:9050
                    </p>
                  </div>
                  
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertTitle>Tor Requirements</AlertTitle>
                    <AlertDescription>
                      Tor must be running on your system. The app will route requests through the SOCKS proxy.
                      {urlClassification !== 'onion' && " Use .onion addresses for maximum privacy."}
                    </AlertDescription>
                  </Alert>
                </>
              )}
            </CardContent>
          </Card>
        );
      })()}
      
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
              <div className="flex items-center gap-2">
                {testResult.success ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                )}
                <div>
                  <p className="font-medium">
                    {testResult.success ? 'Connected' : 'Connection Failed'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {testResult.success 
                      ? `${testResult.providerName} - Block ${testResult.blockHeight?.toLocaleString()} (${testResult.latency}ms)`
                      : testResult.error
                    }
                  </p>
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
