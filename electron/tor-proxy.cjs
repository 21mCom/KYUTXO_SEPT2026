const DEFAULT_TOR_PROXY = "socks5h://127.0.0.1:9050";
const TOR_BROWSER_PROXY = "socks5h://127.0.0.1:9150";

// ============================================================================
// SECURITY MODEL (mirrors server/tor-proxy.ts)
// ============================================================================
// The renderer asks the main process to fetch URLs on its behalf. To keep this
// from becoming an open relay, all trust decisions live in the MAIN PROCESS:
// destinations are restricted to a built-in allowlist plus the user's
// configured custom provider / trusted local hosts, pushed from the renderer's
// stored settings via the 'tor-update-settings' IPC. Per-request `allowedHost`,
// `trustedLocalHosts`, and `torProxyUrl` parameters are no longer honored.
// Methods/headers are allowlisted and body size, timeout, and concurrency are
// bounded.

// Use node-fetch for Node.js compatibility in Electron main process
let nodeFetch;
async function getFetch() {
  if (!nodeFetch) {
    try {
      // Dynamic import for node-fetch (ESM module)
      nodeFetch = (await import('node-fetch')).default;
    } catch (error) {
      console.error('[KYUTXO] Failed to load node-fetch for Tor proxy:', error.name);
      throw new Error('Tor proxy requires node-fetch module. Please ensure it is installed.');
    }
  }
  return nodeFetch;
}

// Log a proxy/direct failure WITHOUT the raw error message: fetch/socks error
// strings embed proxy and target URLs, which are internal detail. The error
// name is enough to diagnose (AbortError, TypeError, ...).
function logProxyError(context, error) {
  if (error instanceof Error) {
    console.error(`${context}: ${error.name}`);
  } else {
    console.error(`${context}: unknown error`);
  }
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

    // The timeout MUST be cleared on every exit path (including fetch
    // rejection), or repeated failures accumulate live timers/controllers.
    try {
      // Just try to connect - any response means the proxy is working
      const response = await fetch('https://check.torproject.org/api/ip', {
        signal: controller.signal,
        agent,
      });
      return response.ok;
    } finally {
      clearTimeout(timeoutId);
    }
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

// ============================================================================
// RESOURCE BOUNDS
// ============================================================================
const ALLOWED_METHODS = new Set(["GET", "POST"]);
// Only these caller-supplied headers are forwarded upstream.
const ALLOWED_FORWARD_HEADERS = new Set(["content-type", "accept"]);
// Cap on the serialized body forwarded upstream (tx broadcast hex fits well
// under this; anything larger is not a legitimate Esplora call).
const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
// Concurrency limit so a flood of IPC requests can't exhaust sockets/memory.
const MAX_CONCURRENT_PROXIED_REQUESTS = 8;
const MAX_QUEUED_PROXIED_REQUESTS = 64;
const QUEUE_WAIT_TIMEOUT_MS = 30000;

function clampProxyTimeout(timeout) {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeout), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// ============================================================================
// MAIN-PROCESS SETTINGS (pushed by the renderer from stored node settings)
// ============================================================================
let torProxySettings = { trustedLocalHosts: [] };

function getTorProxySettings() {
  return torProxySettings;
}

// Test hook: restore the empty (deny-everything-custom) defaults.
function resetTorProxySettings() {
  torProxySettings = { trustedLocalHosts: [] };
}

function isValidSocksProxyUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") return false;
    if (!parsed.hostname) return false;
    const port = parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    return true;
  } catch {
    return false;
  }
}

// Validate and store settings pushed by the renderer. Rejects the whole update
// if any field is malformed (fail closed).
function updateTorProxySettings(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { success: false, error: "Settings payload must be an object" };
  }

  let customProviderUrl;
  const rawCustom = input.customProviderUrl;
  if (rawCustom !== undefined && rawCustom !== null && rawCustom !== "") {
    if (typeof rawCustom !== "string" || rawCustom.length > 2048) {
      return { success: false, error: "customProviderUrl must be a string URL" };
    }
    try {
      const parsed = new URL(rawCustom);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { success: false, error: "customProviderUrl must be an http(s) URL" };
      }
    } catch {
      return { success: false, error: "customProviderUrl is not a valid URL" };
    }
    customProviderUrl = rawCustom;
  }

  let trustedLocalHosts = [];
  const rawTrusted = input.trustedLocalHosts;
  if (rawTrusted !== undefined && rawTrusted !== null) {
    if (!Array.isArray(rawTrusted)) {
      return { success: false, error: "trustedLocalHosts must be an array of hostnames" };
    }
    if (rawTrusted.length > 64) {
      return { success: false, error: "trustedLocalHosts is limited to 64 entries" };
    }
    for (const entry of rawTrusted) {
      if (typeof entry !== "string") {
        return { success: false, error: "trustedLocalHosts entries must be strings" };
      }
      const trimmed = entry.trim();
      if (!trimmed || trimmed.length > 253 || /[\s/:]/.test(trimmed)) {
        return { success: false, error: `Invalid trusted local host entry: '${String(entry).slice(0, 64)}'` };
      }
      trustedLocalHosts.push(trimmed);
    }
  }

  let torProxyUrl;
  const rawProxy = input.torProxyUrl;
  if (rawProxy !== undefined && rawProxy !== null && rawProxy !== "") {
    if (typeof rawProxy !== "string" || !isValidSocksProxyUrl(rawProxy)) {
      return { success: false, error: "torProxyUrl must be a socks5:// or socks5h:// URL with a port" };
    }
    torProxyUrl = rawProxy;
  }

  torProxySettings = { customProviderUrl, trustedLocalHosts, torProxyUrl };
  return { success: true };
}

// Hostname of the configured custom provider (lowercased), or undefined.
function getConfiguredCustomProviderHost() {
  if (!torProxySettings.customProviderUrl) return undefined;
  try {
    return new URL(torProxySettings.customProviderUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
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

function hostMatches(hostname, allowed) {
  return hostname === allowed || hostname.endsWith('.' + allowed);
}

// SSRF guard. All trust inputs come from main-process settings, never from the
// individual IPC request.
function isAllowedUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    const customHost = getConfiguredCustomProviderHost();

    // .onion destinations: only the user's configured custom provider onion is
    // allowed (their own self-hosted node). Arbitrary onions are rejected.
    if (hostname.endsWith('.onion')) {
      if (customHost && customHost.endsWith('.onion') && hostMatches(hostname, customHost)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Onion host '${hostname}' is not your configured provider. Set it as your custom provider in Node Settings first.`,
      };
    }

    // Check if this is a private/local address
    if (isPrivateAddress(hostname)) {
      const isTrusted = torProxySettings.trustedLocalHosts.some(trusted => {
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

      return {
        allowed: false,
        reason: `Local address '${hostname}' is not in your trusted hosts whitelist. Add it in Node Settings → Trusted Local Hosts.`
      };
    }

    // Public addresses: built-in allowlist + configured custom provider host
    const allowedHosts = [...ALLOWED_API_HOSTS];
    if (customHost && !isPrivateAddress(customHost)) {
      allowedHosts.push(customHost);
    }

    if (!allowedHosts.some(allowed => hostMatches(hostname, allowed))) {
      return { allowed: false, reason: `Host '${hostname}' is not in the allowed list` };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL format" };
  }
}

// ============================================================================
// CONCURRENCY LIMITER (semaphore with a bounded queue)
// ============================================================================
let activeProxiedRequests = 0;
const proxyWaitQueue = [];

async function acquireProxySlot() {
  if (activeProxiedRequests < MAX_CONCURRENT_PROXIED_REQUESTS) {
    activeProxiedRequests++;
    return;
  }
  if (proxyWaitQueue.length >= MAX_QUEUED_PROXIED_REQUESTS) {
    throw new Error("Too many proxied requests in flight. Try again shortly.");
  }
  await new Promise((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(entry.timer);
        resolve();
      },
      timer: setTimeout(() => {
        const idx = proxyWaitQueue.indexOf(entry);
        if (idx >= 0) proxyWaitQueue.splice(idx, 1);
        reject(new Error("Timed out waiting for a free proxy slot. Try again shortly."));
      }, QUEUE_WAIT_TIMEOUT_MS),
    };
    proxyWaitQueue.push(entry);
  });
  activeProxiedRequests++;
}

function releaseProxySlot() {
  activeProxiedRequests--;
  const next = proxyWaitQueue.shift();
  if (next) next.resolve();
}

// ============================================================================
// REQUEST SANITIZATION
// ============================================================================
function sanitizeForwardHeaders(headers) {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
    if (ALLOWED_FORWARD_HEADERS.has(lower)) out[lower] = value.slice(0, 512);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeRequestBody(body) {
  if (body === undefined || body === null) return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

// ============================================================================
// BOUNDED RESPONSE READING (mirrors server/tor-proxy.ts)
// ============================================================================
// Cap on the bytes read from an upstream response. A misbehaving or hostile
// provider could otherwise stream an unbounded body and exhaust process
// memory (response bodies used to be read fully via .json()/.text()).
const MAX_RESPONSE_BODY_BYTES = 25 * 1024 * 1024;

class ResponseTooLargeError extends Error {
  constructor() {
    super(`Upstream response exceeded ${MAX_RESPONSE_BODY_BYTES / (1024 * 1024)} MB`);
    this.name = "ResponseTooLargeError";
  }
}

const RESPONSE_TOO_LARGE_MESSAGE = `Upstream response too large (over ${MAX_RESPONSE_BODY_BYTES / (1024 * 1024)} MB). The request was aborted to protect memory.`;

// Read an upstream response body incrementally, aborting as soon as it grows
// past MAX_RESPONSE_BODY_BYTES instead of buffering it whole. Works with both
// node-fetch (Node Readable) and WHATWG body streams — both are
// async-iterable. Throwing out of for-await destroys/cancels the stream.
async function readBodyBounded(body, maxBytes = MAX_RESPONSE_BODY_BYTES) {
  if (body === null || body === undefined) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new ResponseTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Shared response-body handling: bounded read + content-type-aware parse.
async function readResponseData(response) {
  const contentType = response.headers.get("content-type");
  const raw = await readBodyBounded(response.body);
  const data = contentType && contentType.includes("application/json") ? JSON.parse(raw) : raw;
  return { data, contentType };
}

async function makeProxiedRequest(requestParams) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const fetch = await getFetch();
  const startTime = Date.now();

  // Use the configured proxy URL, or auto-detect if not specified
  const proxyUrl = requestParams.torProxyUrl || await detectWorkingTorProxy();
  const timeout = clampProxyTimeout(requestParams.timeout);

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

    const body = serializeRequestBody(requestParams.body);
    if (body && (requestParams.method === "POST" || requestParams.method === "PUT")) {
      fetchOptions.body = body;
    }

    // The timeout MUST be cleared on every exit path (including fetch
    // rejection), or repeated failures accumulate live timers/controllers.
    try {
      const response = await fetch(requestParams.url, fetchOptions);

      const latency = Date.now() - startTime;

      const { data, contentType } = await readResponseData(response);

      return {
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        data,
        latency,
        contentType: contentType || undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const latency = Date.now() - startTime;

    if (error instanceof ResponseTooLargeError) {
      return { success: false, error: RESPONSE_TOO_LARGE_MESSAGE, latency };
    }

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
        error: "Cannot connect to the Tor proxy. Make sure Tor is running.",
        latency,
      };
    }

    // Raw exception text can embed proxy/target URLs — keep it away from the
    // renderer and out of routine logs.
    logProxyError("[KYUTXO] Tor proxy request failed", error);
    return {
      success: false,
      error: "Proxy request failed",
      latency,
    };
  }
}

// Make a direct HTTP request (no proxy) for trusted local hosts
async function makeDirectRequest(requestParams) {
  const fetch = await getFetch();
  const startTime = Date.now();
  const timeout = clampProxyTimeout(requestParams.timeout);

  console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest START - timeout: ${timeout}ms`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`[KYUTXO] [${new Date().toISOString()}] TIMEOUT TRIGGERED after ${timeout}ms`);
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

    const body = serializeRequestBody(requestParams.body);
    if (body) {
      fetchOptions.body = body;
    }

    // The timeout MUST be cleared on every exit path (including fetch
    // rejection), or repeated failures accumulate live timers/controllers.
    let response;
    try {
      console.log(`[KYUTXO] [${new Date().toISOString()}] Calling fetch()`);
      response = await fetch(requestParams.url, fetchOptions);
      console.log(`[KYUTXO] [${new Date().toISOString()}] fetch() returned - status: ${response.status}, elapsed: ${Date.now() - startTime}ms`);
    } finally {
      clearTimeout(timeoutId);
    }

    const contentType = response.headers.get('content-type') || '';

    console.log(`[KYUTXO] [${new Date().toISOString()}] Reading response body (bounded) - contentType: ${contentType}`);
    const { data } = await readResponseData(response);

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

    if (error instanceof ResponseTooLargeError) {
      return { success: false, error: RESPONSE_TOO_LARGE_MESSAGE, latency };
    }

    if (error.name === 'AbortError') {
      console.log(`[KYUTXO] [${new Date().toISOString()}] makeDirectRequest TIMEOUT - elapsed: ${latency}ms`);
      return {
        success: false,
        error: `Request timed out after ${timeout / 1000}s`,
        latency,
      };
    }

    if (error.message && error.message.includes('ECONNREFUSED')) {
      return {
        success: false,
        error: "Cannot connect to the target host. Make sure the host is reachable.",
        latency,
      };
    }

    // Raw exception text can embed the target URL — keep it away from the
    // renderer and out of routine logs.
    logProxyError("[KYUTXO] Direct request failed", error);
    return {
      success: false,
      error: "Direct request failed",
      latency,
    };
  }
}

// Entry point for the 'tor-request' IPC handler. Enforces the method/header/
// body bounds, the server-side (main-process) allowlist, and the concurrency
// limit before dispatching to the direct or proxied request path.
async function handleTorRequest(params) {
  const requestUrl = params.url;
  if (!requestUrl) {
    return { success: false, error: "URL is required" };
  }

  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  if (!ALLOWED_METHODS.has(method)) {
    return { success: false, error: `Method ${method} is not allowed through the proxy` };
  }

  const serializedBody = serializeRequestBody(params.body);
  if (serializedBody && serializedBody.length > MAX_REQUEST_BODY_BYTES) {
    return { success: false, error: "Request body too large" };
  }

  const urlCheck = isAllowedUrl(requestUrl);
  if (!urlCheck.allowed) {
    return { success: false, error: urlCheck.reason || "URL not allowed" };
  }

  let slotAcquired = false;
  try {
    await acquireProxySlot();
    slotAcquired = true;

    const sanitizedParams = {
      url: requestUrl,
      method,
      headers: sanitizeForwardHeaders(params.headers),
      body: serializedBody,
      timeout: clampProxyTimeout(params.timeout),
    };

    if (urlCheck.isLocal) {
      return await makeDirectRequest(sanitizedParams);
    }

    // SOCKS proxy URL comes from main-process settings (auto-detected when the
    // user hasn't configured one), never from the IPC request.
    return await makeProxiedRequest({
      ...sanitizedParams,
      torProxyUrl: torProxySettings.torProxyUrl,
    });
  } catch (error) {
    // The intentionally-worded queue/node-fetch messages are safe to surface;
    // anything else may embed URLs — log the name only and answer generically.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Too many proxied requests") || message.includes("requires node-fetch")) {
      return { success: false, error: message };
    }
    logProxyError("[KYUTXO] Tor request failed", error);
    return { success: false, error: "Request failed" };
  } finally {
    if (slotAcquired) releaseProxySlot();
  }
}

module.exports = {
  DEFAULT_TOR_PROXY,
  TOR_BROWSER_PROXY,
  ALLOWED_API_HOSTS,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_TIMEOUT_MS,
  MAX_CONCURRENT_PROXIED_REQUESTS,
  MAX_QUEUED_PROXIED_REQUESTS,
  getFetch,
  isProxyReachable,
  detectWorkingTorProxy,
  isPrivateAddress,
  isAllowedUrl,
  clampProxyTimeout,
  getTorProxySettings,
  updateTorProxySettings,
  resetTorProxySettings,
  sanitizeForwardHeaders,
  makeProxiedRequest,
  makeDirectRequest,
  handleTorRequest,
};
