const DEFAULT_TOR_PROXY = "socks5h://127.0.0.1:9050";
const TOR_BROWSER_PROXY = "socks5h://127.0.0.1:9150";

// Use node-fetch for Node.js compatibility in Electron main process
let nodeFetch;
async function getFetch() {
  if (!nodeFetch) {
    try {
      // Dynamic import for node-fetch (ESM module)
      nodeFetch = (await import('node-fetch')).default;
    } catch (error) {
      console.error('[KYUTXO] Failed to load node-fetch for Tor proxy:', error.message);
      throw new Error('Tor proxy requires node-fetch module. Please ensure it is installed.');
    }
  }
  return nodeFetch;
}

// Cache the last detected working Tor proxy to avoid repeated detection
let cachedWorkingProxy = null;
let cacheTimestamp = 0;
const PROXY_CACHE_DURATION = 60000; // 1 minute cache

// Quick test if a proxy is reachable (doesn't verify it's Tor, just that it accepts connections)
async function isProxyReachable(proxyUrl, timeoutMs = 5000) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const fetch = await getFetch();
  
  try {
    const agent = new SocksProxyAgent(proxyUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    // Just try to connect - any response means the proxy is working
    const response = await fetch('https://check.torproject.org/api/ip', {
      signal: controller.signal,
      agent,
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Auto-detect working Tor proxy, trying Tor Browser first
async function detectWorkingTorProxy() {
  const now = Date.now();
  
  // Return cached result if still valid
  if (cachedWorkingProxy && (now - cacheTimestamp) < PROXY_CACHE_DURATION) {
    return cachedWorkingProxy;
  }
  
  // Try Tor Browser first (port 9150), then Tor service (port 9050)
  if (await isProxyReachable(TOR_BROWSER_PROXY, 3000)) {
    cachedWorkingProxy = TOR_BROWSER_PROXY;
    cacheTimestamp = now;
    console.log('[KYUTXO] Auto-detected Tor Browser proxy at port 9150');
    return TOR_BROWSER_PROXY;
  }
  
  if (await isProxyReachable(DEFAULT_TOR_PROXY, 3000)) {
    cachedWorkingProxy = DEFAULT_TOR_PROXY;
    cacheTimestamp = now;
    console.log('[KYUTXO] Auto-detected Tor service at port 9050');
    return DEFAULT_TOR_PROXY;
  }
  
  // No proxy found - return default and let it fail with a clear error
  console.log('[KYUTXO] No Tor proxy detected, using default 9050');
  return DEFAULT_TOR_PROXY;
}

// Allowed hostnames for Bitcoin API requests - prevents SSRF attacks
const ALLOWED_API_HOSTS = [
  "mempool.space",
  "blockstream.info",
  "check.torproject.org",
];

// Check if a hostname matches private/local IP patterns
function isPrivateAddress(hostname) {
  const privatePatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./,
    /\.local$/i,  // mDNS local domains
  ];
  return privatePatterns.some(p => p.test(hostname));
}

function isAllowedUrl(urlString, additionalAllowedHost, trustedLocalHosts = []) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    
    // Allow .onion addresses (Tor hidden services)
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
                 // Allow if the trusted host is a prefix (e.g., "192.168.1" matches "192.168.1.50")
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
    
    // For public addresses, check against allowed API hosts
    const allowedHosts = [...ALLOWED_API_HOSTS];
    if (additionalAllowedHost) {
      try {
        const additionalParsed = new URL(additionalAllowedHost);
        const additionalHostname = additionalParsed.hostname.toLowerCase();
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
      return { allowed: false, reason: `Host '${hostname}' is not in the allowed list` };
    }
    
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL format" };
  }
}

async function makeProxiedRequest(requestParams) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const fetch = await getFetch();
  const startTime = Date.now();
  
  // Use provided proxy URL, or auto-detect if not specified
  const proxyUrl = requestParams.torProxyUrl || await detectWorkingTorProxy();
  const timeout = requestParams.timeout || 60000;

  try {
    const agent = new SocksProxyAgent(proxyUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions = {
      method: requestParams.method || "GET",
      headers: requestParams.headers,
      signal: controller.signal,
      agent,
    };

    if (requestParams.body && (requestParams.method === "POST" || requestParams.method === "PUT")) {
      fetchOptions.body = JSON.stringify(requestParams.body);
    }

    const response = await fetch(requestParams.url, fetchOptions);
    clearTimeout(timeoutId);

    const latency = Date.now() - startTime;
    
    let data;
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
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
    
    if (error.name === "AbortError") {
      return {
        success: false,
        error: `Request timed out after ${timeout / 1000}s. Tor connections can be slow - try increasing the timeout.`,
        latency,
      };
    }
    
    if (error.message && error.message.includes("ECONNREFUSED")) {
      return {
        success: false,
        error: `Cannot connect to Tor proxy at ${proxyUrl}. Make sure Tor is running.`,
        latency,
      };
    }
    
    return {
      success: false,
      error: error.message || "Unknown error occurred",
      latency,
    };
  }
}

// Make a direct HTTP request (no proxy) for trusted local hosts
async function makeDirectRequest(requestParams) {
  const fetch = await getFetch();
  const startTime = Date.now();
  const timeout = requestParams.timeout || 30000;

  console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest START - URL: ${requestParams.url}, timeout: ${timeout}ms`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`[KYUTXO] [${new Date().toISOString()}] TIMEOUT TRIGGERED after ${timeout}ms for: ${requestParams.url}`);
      controller.abort();
    }, timeout);

    // Add browser-like headers to help with nginx reverse proxies (like Umbrel's)
    const defaultHeaders = {
      'User-Agent': 'KYUTXO/1.2.1 (Electron)',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
    };

    const fetchOptions = {
      method: requestParams.method || "GET",
      headers: { ...defaultHeaders, ...requestParams.headers },
      signal: controller.signal,
    };
    
    if (requestParams.body) {
      fetchOptions.body = typeof requestParams.body === 'string' 
        ? requestParams.body 
        : JSON.stringify(requestParams.body);
    }

    console.log(`[KYUTXO] [${new Date().toISOString()}] Calling fetch() for: ${requestParams.url}`);
    const response = await fetch(requestParams.url, fetchOptions);
    console.log(`[KYUTXO] [${new Date().toISOString()}] fetch() returned - status: ${response.status}, elapsed: ${Date.now() - startTime}ms`);
    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') || '';
    let data;
    
    console.log(`[KYUTXO] [${new Date().toISOString()}] Reading response body - contentType: ${contentType}`);
    if (contentType.includes('application/json')) {
      data = await response.json();
      console.log(`[KYUTXO] [${new Date().toISOString()}] JSON parsed - items: ${Array.isArray(data) ? data.length : 'object'}, elapsed: ${Date.now() - startTime}ms`);
    } else {
      data = await response.text();
      console.log(`[KYUTXO] [${new Date().toISOString()}] Text read - length: ${data.length} chars, elapsed: ${Date.now() - startTime}ms`);
    }

    const latency = Date.now() - startTime;
    console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest SUCCESS - total latency: ${latency}ms`);

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        statusText: response.statusText,
        data,
        latency,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      data,
      latency,
      contentType,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error.name === 'AbortError') {
      console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest TIMEOUT - elapsed: ${latency}ms, URL: ${requestParams.url}`);
      return {
        success: false,
        error: `Request timed out after ${timeout / 1000}s`,
        latency,
      };
    }
    
    console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest ERROR - ${error.message}, elapsed: ${latency}ms, URL: ${requestParams.url}`);
    return {
      success: false,
      error: error.message || "Direct request failed",
      latency,
    };
  }
}

module.exports = {
  DEFAULT_TOR_PROXY,
  TOR_BROWSER_PROXY,
  ALLOWED_API_HOSTS,
  getFetch,
  isProxyReachable,
  detectWorkingTorProxy,
  isPrivateAddress,
  isAllowedUrl,
  makeProxiedRequest,
  makeDirectRequest,
};
