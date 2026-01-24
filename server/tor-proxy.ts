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

function isAllowedUrl(url: string, additionalAllowedHost?: string): { allowed: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    
    // Allow .onion addresses (user's self-hosted nodes)
    if (hostname.endsWith('.onion')) {
      return { allowed: true };
    }
    
    // Block private IP ranges and localhost
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
    ];
    
    for (const pattern of privatePatterns) {
      if (pattern.test(hostname)) {
        return { allowed: false, reason: "Internal network addresses are not allowed" };
      }
    }
    
    // Build dynamic allowlist including client-provided host
    const allowedHosts = [...ALLOWED_API_HOSTS];
    if (additionalAllowedHost) {
      try {
        const additionalParsed = new URL(additionalAllowedHost);
        const additionalHostname = additionalParsed.hostname.toLowerCase();
        // Only add if it passes private IP check
        const isPrivate = privatePatterns.some(p => p.test(additionalHostname));
        if (!isPrivate) {
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
    
    // Only allow HTTPS for non-.onion hosts
    if (parsed.protocol !== 'https:') {
      return { allowed: false, reason: "Only HTTPS URLs are allowed (except for .onion)" };
    }
    
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL format" };
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
          error: `Cannot connect to Tor proxy at ${proxyUrl}. Make sure Tor is running.`,
          latency,
        };
      }
      
      return {
        success: false,
        error: error.message,
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
  const { url, method, headers, body, timeout, torProxyUrl, allowedHost } = req.body as ProxyRequest;

  if (!url) {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  // Validate URL to prevent SSRF attacks
  // allowedHost allows the client to specify their configured provider URL for custom nodes
  const urlCheck = isAllowedUrl(url, allowedHost);
  if (!urlCheck.allowed) {
    return res.status(403).json({ 
      success: false, 
      error: urlCheck.reason || "URL not allowed"
    });
  }

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
      results.push({
        name: proxy.name,
        url: proxy.url,
        port: proxy.port,
        available: false,
        error: error instanceof Error ? error.message : "Unknown error",
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
