import { Router, Request, Response } from "express";
import { SocksProxyAgent } from "socks-proxy-agent";

const router = Router();

const DEFAULT_TOR_PROXY = "socks5h://127.0.0.1:9050";
const TOR_BROWSER_PROXY = "socks5h://127.0.0.1:9150";

// SECURITY NOTE: This Tor proxy is designed for a desktop Electron application
// where the "client" and "server" run on the same machine controlled by the user.
// The threat model does NOT include protecting against the user themselves.
// 
// SSRF protections implemented:
// 1. Private IP range blocking (localhost, 10.x, 172.16-31.x, 192.168.x, etc.)
// 2. Allowlist for known Bitcoin API providers
// 3. Dynamic allowlist extension via allowedHost for user-configured custom nodes
//
// Known limitations for future enhancement:
// - DNS rebinding not fully mitigated (would require resolving hostnames server-side)
// - allowedHost is client-supplied (acceptable in desktop context, reconsider if server is exposed)

// Allowed hostnames for Bitcoin API requests - prevents SSRF attacks
const ALLOWED_API_HOSTS = [
  // Mempool.space
  "mempool.space",
  // Blockstream
  "blockstream.info",
  // Tor project (for testing)
  "check.torproject.org",
  // Note: .onion addresses are always allowed (user's own nodes)
];

// Check if a hostname matches private/local IP patterns
function isPrivateAddress(hostname: string): boolean {
  const privatePatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./,
    /^\[::1\]$/,
    /^\[fe80:/i,
    /^\[fc00:/i,
    /^\[fd00:/i,
    /\.local$/i,  // mDNS local domains
  ];
  return privatePatterns.some(p => p.test(hostname));
}

function isAllowedUrl(url: string, additionalAllowedHost?: string, trustedLocalHosts: string[] = []): { allowed: boolean; reason?: string; isLocal?: boolean } {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    
    // Allow .onion addresses (user's self-hosted nodes)
    if (hostname.endsWith('.onion')) {
      return { allowed: true };
    }
    
    // Check if this is a private/local address
    const isPrivate = isPrivateAddress(hostname);
    
    if (isPrivate) {
      // For private addresses, check against trusted local hosts whitelist
      if (trustedLocalHosts && trustedLocalHosts.length > 0) {
        const isTrusted = trustedLocalHosts.some(trusted => {
          const trustedLower = trusted.toLowerCase();
          return hostname === trustedLower || 
                 hostname.startsWith(trustedLower + ':') ||
                 hostname.startsWith(trustedLower + '.');
        });
        
        if (isTrusted) {
          console.log(`[KYUTXO] Allowing trusted local host: ${hostname}`);
          return { allowed: true, isLocal: true };
        }
      }
      
      return { 
        allowed: false, 
        reason: `Local address '${hostname}' is not in your trusted hosts whitelist. Add it in Node Settings → Trusted Local Hosts.` 
      };
    }
    
    // Build dynamic allowlist including client-provided host
    const allowedHosts = [...ALLOWED_API_HOSTS];
    if (additionalAllowedHost) {
      try {
        const additionalParsed = new URL(additionalAllowedHost);
        const additionalHostname = additionalParsed.hostname.toLowerCase();
        // Only add if not a private address
        if (!isPrivateAddress(additionalHostname)) {
          allowedHosts.push(additionalHostname);
        }
      } catch {
        // Invalid URL, ignore
      }
    }
    
    // Check against allowlist
    const isAllowed = allowedHosts.some(allowed => 
      hostname === allowed || hostname.endsWith('.' + allowed)
    );
    
    if (!isAllowed) {
      return { 
        allowed: false, 
        reason: `Host '${hostname}' is not in the allowed list. Only Bitcoin API providers are permitted.`
      };
    }
    
    // Only allow HTTPS for non-.onion, non-local hosts
    if (parsed.protocol !== 'https:') {
      return { allowed: false, reason: "Only HTTPS URLs are allowed (except for .onion and local addresses)" };
    }
    
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL format" };
  }
}

// Log a proxy failure server-side WITHOUT the raw error message: fetch/socks
// error strings embed proxy and target URLs, which are internal detail. The
// error name is enough to diagnose (AbortError, TypeError, ...).
function logProxyError(context: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(`${context}: ${error.name}`);
  } else {
    console.error(`${context}: unknown error`);
  }
}

interface ProxyRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  torProxyUrl?: string;
  allowedHost?: string; // Client-specified allowed host for custom providers
  trustedLocalHosts?: string[]; // Whitelist of allowed local IPs/hostnames
}

interface ProxyResponse {
  success: boolean;
  status?: number;
  statusText?: string;
  data?: unknown;
  error?: string;
  latency?: number;
  contentType?: string; // Preserve upstream content-type
}

async function makeProxiedRequest(req: ProxyRequest): Promise<ProxyResponse> {
  const startTime = Date.now();
  const proxyUrl = req.torProxyUrl || DEFAULT_TOR_PROXY;
  const timeout = req.timeout || 60000;

  try {
    const agent = new SocksProxyAgent(proxyUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: RequestInit = {
      method: req.method || "GET",
      headers: req.headers,
      signal: controller.signal,
      // @ts-expect-error - agent is valid for Node.js fetch
      agent,
    };

    if (req.body && (req.method === "POST" || req.method === "PUT")) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(req.url, fetchOptions);
    clearTimeout(timeoutId);

    const latency = Date.now() - startTime;
    
    let data: unknown;
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      latency,
      contentType: contentType || undefined,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return {
          success: false,
          error: `Request timed out after ${timeout / 1000}s. Tor connections can be slow - try increasing the timeout.`,
          latency,
        };
      }
      
      if (error.message.includes("ECONNREFUSED")) {
        return {
          success: false,
          error: "Cannot connect to the Tor proxy. Make sure Tor is running.",
          latency,
        };
      }

      // Raw exception text can embed proxy/target URLs — keep it off the wire.
      logProxyError("[KYUTXO] Tor proxy request failed", error);
      return {
        success: false,
        error: "Proxy request failed",
        latency,
      };
    }

    return {
      success: false,
      error: "Unknown error occurred",
      latency,
    };
  }
}

// Direct request without Tor proxy (for trusted local hosts)
async function makeDirectRequest(req: ProxyRequest): Promise<ProxyResponse> {
  const startTime = Date.now();
  const timeout = req.timeout || 60000;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: RequestInit = {
      method: req.method || "GET",
      headers: req.headers,
      signal: controller.signal,
    };

    if (req.body && (req.method === "POST" || req.method === "PUT")) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(req.url, fetchOptions);
    clearTimeout(timeoutId);

    const latency = Date.now() - startTime;
    
    let data: unknown;
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      latency,
      contentType: contentType || undefined,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return {
          success: false,
          error: `Request timed out after ${timeout / 1000}s`,
          latency,
        };
      }
      
      if (error.message.includes("ECONNREFUSED")) {
        return {
          success: false,
          error: "Cannot connect to the target host. Make sure the host is reachable.",
          latency,
        };
      }

      // Raw exception text can embed the target URL — keep it off the wire.
      logProxyError("[KYUTXO] Direct request failed", error);
      return {
        success: false,
        error: "Direct request failed",
        latency,
      };
    }
    
    return {
      success: false,
      error: "Unknown error occurred",
      latency,
    };
  }
}

router.post("/request", async (req: Request, res: Response) => {
  const { url, method, headers, body, timeout, torProxyUrl, allowedHost, trustedLocalHosts } = req.body as ProxyRequest;

  if (!url) {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  // Validate URL to prevent SSRF attacks
  // allowedHost allows the client to specify their configured provider URL for custom nodes
  // trustedLocalHosts allows direct local network connections
  const urlCheck = isAllowedUrl(url, allowedHost, trustedLocalHosts || []);
  if (!urlCheck.allowed) {
    return res.status(403).json({ 
      success: false, 
      error: urlCheck.reason || "URL not allowed"
    });
  }

  // Use direct request for trusted local hosts (skip Tor proxy)
  if (urlCheck.isLocal) {
    console.log(`[KYUTXO] Making direct request to trusted local host: ${new URL(url).hostname}`);
    const result = await makeDirectRequest({
      url,
      method,
      headers,
      body,
      timeout,
    });
    return res.json(result);
  }

  // Use Tor proxy for remote/onion addresses
  const result = await makeProxiedRequest({
    url,
    method,
    headers,
    body,
    timeout,
    torProxyUrl,
  });

  res.json(result);
});

router.post("/test", async (req: Request, res: Response) => {
  const { torProxyUrl } = req.body as { torProxyUrl?: string };
  
  const proxiesToTest = [
    { name: "Tor Browser", url: TOR_BROWSER_PROXY },
    { name: "Tor Service", url: DEFAULT_TOR_PROXY },
  ];

  if (torProxyUrl) {
    proxiesToTest.unshift({ name: "Custom", url: torProxyUrl });
  }

  for (const proxy of proxiesToTest) {
    try {
      const result = await makeProxiedRequest({
        url: "https://check.torproject.org/api/ip",
        torProxyUrl: proxy.url,
        timeout: 15000,
      });

      if (result.success && result.data) {
        const torCheck = result.data as { IsTor?: boolean; IP?: string };
        if (torCheck.IsTor) {
          return res.json({
            success: true,
            proxyUrl: proxy.url,
            proxyName: proxy.name,
            isTor: true,
            torIp: torCheck.IP,
            latency: result.latency,
            message: `Connected via ${proxy.name}. Exit IP: ${torCheck.IP}`,
          });
        }
      }
    } catch {
      continue;
    }
  }

  res.json({
    success: false,
    error: "Could not connect to Tor. Make sure Tor Browser or Tor service is running.",
    testedProxies: proxiesToTest.map(p => p.url),
  });
});

router.get("/status", async (_req: Request, res: Response) => {
  const proxiesToTest = [
    { name: "Tor Browser", url: TOR_BROWSER_PROXY, port: 9150 },
    { name: "Tor Service", url: DEFAULT_TOR_PROXY, port: 9050 },
  ];

  const results = [];

  for (const proxy of proxiesToTest) {
    try {
      const result = await makeProxiedRequest({
        url: "https://check.torproject.org/api/ip",
        torProxyUrl: proxy.url,
        timeout: 10000,
      });

      if (result.success) {
        const torCheck = result.data as { IsTor?: boolean; IP?: string };
        results.push({
          name: proxy.name,
          url: proxy.url,
          port: proxy.port,
          available: true,
          isTor: torCheck.IsTor || false,
          exitIp: torCheck.IP,
          latency: result.latency,
        });
      } else {
        results.push({
          name: proxy.name,
          url: proxy.url,
          port: proxy.port,
          available: false,
          error: result.error,
        });
      }
    } catch (error) {
      logProxyError(`[KYUTXO] Tor status check (${proxy.name}) failed`, error);
      results.push({
        name: proxy.name,
        url: proxy.url,
        port: proxy.port,
        available: false,
        error: "Status check failed",
      });
    }
  }

  const anyAvailable = results.some(r => r.available && r.isTor);

  res.json({
    torAvailable: anyAvailable,
    proxies: results,
    recommendation: anyAvailable 
      ? `Tor is available via ${results.find(r => r.available && r.isTor)?.name}`
      : "No Tor proxy detected. Please start Tor Browser or install the Tor service.",
  });
});

export default router;
