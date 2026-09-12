import { Router, Request, Response } from "express";
import { SocksProxyAgent } from "socks-proxy-agent";
import { randomBytes, timingSafeEqual } from "node:crypto";

const router = Router();

const DEFAULT_TOR_PROXY = "socks5h://127.0.0.1:9050";
const TOR_BROWSER_PROXY = "socks5h://127.0.0.1:9150";

// ============================================================================
// SECURITY MODEL
// ============================================================================
// This endpoint is a relay: it fetches arbitrary URLs on behalf of whoever can
// reach the HTTP server. To keep it from becoming a semi-open relay (especially
// while the server is LAN-reachable), all trust decisions are made SERVER-SIDE:
//
// 1. Destinations are restricted to a server-side allowlist: known Esplora
//    providers, check.torproject.org, and the user's configured custom provider
//    (pushed to the server via POST /api/tor/settings from stored settings).
//    Callers can NO LONGER extend the allowlist per request — the old
//    `allowedHost` / `trustedLocalHosts` request fields are ignored.
// 2. .onion destinations are only allowed when they match the configured
//    custom provider host (the user's own node), not arbitrary onions.
// 3. Private/local addresses require the host to appear in the configured
//    trusted-local-hosts list (also pushed via /api/tor/settings).
// 4. The SOCKS proxy URL comes from server-side settings, never per request.
// 5. Resource exhaustion bounds: methods and headers are allowlisted, request
//    bodies and timeouts are capped, and concurrency is limited.
//
// Known limitations:
// - DNS rebinding is not fully mitigated (would require resolving hostnames
//   server-side and pinning the resolved IP).

// Allowed hostnames for Bitcoin API requests - prevents SSRF attacks
const ALLOWED_API_HOSTS = [
  // Mempool.space
  "mempool.space",
  // Blockstream
  "blockstream.info",
  // Tor project (for testing)
  "check.torproject.org",
];

// ============================================================================
// RESOURCE BOUNDS
// ============================================================================
const ALLOWED_METHODS = new Set(["GET", "POST"]);
// Only these caller-supplied headers are forwarded upstream. Anything else
// (auth tokens, cookies, arbitrary headers) is stripped.
const ALLOWED_FORWARD_HEADERS = new Set(["content-type", "accept"]);
// Cap on the serialized body forwarded upstream (tx broadcast hex fits well
// under this; anything larger is not a legitimate Esplora call).
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
// Cap on the incoming proxied-request envelope itself.
export const MAX_INCOMING_CONTENT_LENGTH = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
// Cap on the bytes read from an upstream response. A misbehaving or hostile
// provider could otherwise stream an unbounded body and exhaust process
// memory (response bodies used to be read fully via .json()/.text()).
export const MAX_RESPONSE_BODY_BYTES = 25 * 1024 * 1024;
// Concurrency limit so the endpoint can't exhaust sockets/memory.
export const MAX_CONCURRENT_PROXIED_REQUESTS = 8;
export const MAX_QUEUED_PROXIED_REQUESTS = 64;
const QUEUE_WAIT_TIMEOUT_MS = 30_000;

export function clampProxyTimeout(timeout?: number): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeout), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// ============================================================================
// SERVER-SIDE SETTINGS (pushed by the client from stored node settings)
// ============================================================================
export interface TorProxySettings {
  customProviderUrl?: string; // Full URL of the configured custom Esplora provider
  trustedLocalHosts: string[]; // User-configured trusted local IPs/hostnames
  torProxyUrl?: string; // socks5(h):// URL of the user's Tor proxy
}

let torProxySettings: TorProxySettings = { trustedLocalHosts: [] };

let settingsInitialized = false;
export function getTorProxySettings(): TorProxySettings {
  return torProxySettings;
}

// Test hook: restore the empty (deny-everything-custom) defaults.
export function resetTorProxySettings(): void {
  torProxySettings = { trustedLocalHosts: [] };
  settingsInitialized = false;
}

export function canonicalizeSocksProxyUrl(value: string): string | undefined {
  try {
    const schemeMatch = /^(socks5h?):\/\//i.exec(value);
    if (!schemeMatch) return undefined;
    const parsed = new URL(`http://${value.slice(schemeMatch[0].length)}`);
    if (!parsed.hostname) return undefined;
    const port = parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) return undefined;
    const withoutRootSlash = value.replace(/\/$/, "");
    return schemeMatch[1].toLowerCase() === "socks5"
      ? withoutRootSlash.replace(/^socks5:/i, "socks5h:")
      : withoutRootSlash;
  } catch {
    return undefined;
  }
}

function sanitizeTrustedLocalHosts(input: unknown): { ok: true; hosts: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, hosts: [] };
  if (!Array.isArray(input)) return { ok: false, error: "trustedLocalHosts must be an array of hostnames" };
  if (input.length > 64) return { ok: false, error: "trustedLocalHosts is limited to 64 entries" };
  const hosts: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") return { ok: false, error: "trustedLocalHosts entries must be strings" };
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 253 || /[\s/:]/.test(trimmed)) {
      // Fixed text: user-supplied entries are never reflected back in responses.
      return { ok: false, error: 'Invalid trusted local host entry: entries must be non-empty hostnames or IP addresses under 254 characters.' };
    }
    hosts.push(trimmed);
  }
  return { ok: true, hosts };
}

// Validate and store settings pushed by the client. Rejects the whole update
// if any field is malformed (fail closed).
export function updateTorProxySettings(input: unknown): { success: boolean; error?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { success: false, error: "Settings payload must be an object" };
  }
  const raw = input as Record<string, unknown>;

  let customProviderUrl: string | undefined;
  if (raw.customProviderUrl !== undefined && raw.customProviderUrl !== null && raw.customProviderUrl !== "") {
    if (typeof raw.customProviderUrl !== "string" || raw.customProviderUrl.length > 2048) {
      return { success: false, error: "customProviderUrl must be a string URL" };
    }
    try {
      const parsed = new URL(raw.customProviderUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { success: false, error: "customProviderUrl must be an http(s) URL" };
      }
    } catch {
      return { success: false, error: "customProviderUrl is not a valid URL" };
    }
    customProviderUrl = raw.customProviderUrl;
  }

  const trusted = sanitizeTrustedLocalHosts(raw.trustedLocalHosts);
  if (!trusted.ok) return { success: false, error: trusted.error };

  let torProxyUrl: string | undefined;
  if (raw.torProxyUrl !== undefined && raw.torProxyUrl !== null && raw.torProxyUrl !== "") {
    const canonicalProxy =
      typeof raw.torProxyUrl === "string" ? canonicalizeSocksProxyUrl(raw.torProxyUrl.trim()) : undefined;
    if (!canonicalProxy) {
      return { success: false, error: "torProxyUrl must be a socks5h:// URL with a hostname and port" };
    }
    torProxyUrl = canonicalProxy;
  }

  torProxySettings = { customProviderUrl, trustedLocalHosts: trusted.hosts, torProxyUrl };
  settingsInitialized = true;
  return { success: true };
}

// Hostname of the configured custom provider (lowercased), or undefined.
function getConfiguredCustomProviderHost(): string | undefined {
  const url = torProxySettings.customProviderUrl;
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

// Check if a hostname matches private/local IP patterns
function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : NaN);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : undefined;
}

function parseIpv6(hostname: string): number[] | undefined {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":") || value.includes("%")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const tokens = side.split(":");
    const groups: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const ipv4 = parseIpv4(token);
      if (ipv4) {
        if (index !== tokens.length - 1) return undefined;
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return undefined;
        groups.push(parseInt(token, 16));
      }
    }
    return groups;
  };
  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] ?? "");
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const zeroCount = 8 - left.length - right.length;
  return zeroCount >= 1 ? [...left, ...Array(zeroCount).fill(0), ...right] : undefined;
}

export function isPrivateAddress(rawHostname: string): boolean {
  const hostname = rawHostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  const ipv6 = parseIpv6(hostname);
  if (!ipv6) return false;
  if (ipv6.slice(0, 5).every((group) => group === 0) && ipv6[5] === 0xffff) {
    return isPrivateAddress(`${ipv6[6] >> 8}.${ipv6[6] & 0xff}.${ipv6[7] >> 8}.${ipv6[7] & 0xff}`);
  }
  return ipv6.every((group) => group === 0) ||
    (ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1) ||
    (ipv6[0] & 0xfe00) === 0xfc00 ||
    (ipv6[0] & 0xffc0) === 0xfe80;
}

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith('.' + allowed);
}

// SSRF guard. All trust inputs come from server-side settings, never from the
// individual request.
export function isAllowedUrl(url: string): { allowed: boolean; reason?: string; isLocal?: boolean } {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const customHost = getConfiguredCustomProviderHost();
    const settings = getTorProxySettings();

    // .onion destinations: only the user's configured custom provider onion is
    // allowed (their own self-hosted node). Arbitrary onions are rejected.
    if (hostname.endsWith('.onion')) {
      if (customHost && customHost.endsWith('.onion') && hostMatches(hostname, customHost)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "This onion host is not your configured provider. Set it as your custom provider in Node Settings first.",
      };
    }

    // Check if this is a private/local address
    if (isPrivateAddress(hostname)) {
      const isTrusted = settings.trustedLocalHosts.some(trusted => {
        const trustedLower = trusted.toLowerCase();
        return hostname === trustedLower ||
               hostname.startsWith(trustedLower + ':') ||
               hostname.startsWith(trustedLower + '.');
      });

      if (isTrusted) {
        return { allowed: true, isLocal: true };
      }

      return {
        allowed: false,
        reason: "This local address is not in your trusted hosts whitelist. Add it in Node Settings → Trusted Local Hosts."
      };
    }

    // Build the server-side allowlist: known providers + configured custom provider
    const allowedHosts = [...ALLOWED_API_HOSTS];
    if (customHost && !isPrivateAddress(customHost)) {
      allowedHosts.push(customHost);
    }

    if (!allowedHosts.some(allowed => hostMatches(hostname, allowed))) {
      return {
        allowed: false,
        reason: "Host is not in the allowed list. Only Bitcoin API providers are permitted."
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

// ============================================================================
// CONCURRENCY LIMITER (semaphore with a bounded queue)
// ============================================================================
let activeProxiedRequests = 0;
const proxyWaitQueue: Array<{
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}> = [];

class ProxyQueueError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "ProxyQueueError";
  }
}

async function acquireProxySlot(): Promise<void> {
  if (activeProxiedRequests < MAX_CONCURRENT_PROXIED_REQUESTS) {
    activeProxiedRequests++;
    return;
  }
  if (proxyWaitQueue.length >= MAX_QUEUED_PROXIED_REQUESTS) {
    throw new ProxyQueueError("Too many proxied requests in flight. Try again shortly.", 429);
  }
  await new Promise<void>((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(entry.timer);
        resolve();
      },
      reject: (err: Error) => {
        clearTimeout(entry.timer);
        reject(err);
      },
      timer: setTimeout(() => {
        const idx = proxyWaitQueue.indexOf(entry);
        if (idx >= 0) proxyWaitQueue.splice(idx, 1);
        reject(new ProxyQueueError("Timed out waiting for a free proxy slot. Try again shortly.", 429));
      }, QUEUE_WAIT_TIMEOUT_MS),
    };
    proxyWaitQueue.push(entry);
  });
  activeProxiedRequests++;
}

function releaseProxySlot(): void {
  activeProxiedRequests--;
  const next = proxyWaitQueue.shift();
  if (next) next.resolve();
}

// ============================================================================
// REQUEST SANITIZATION
// ============================================================================
function sanitizeForwardHeaders(headers: unknown): Record<string, string> | undefined {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
    if (ALLOWED_FORWARD_HEADERS.has(lower)) out[lower] = value.slice(0, 512);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeRequestBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  return serialized;
}

// ============================================================================
// BOUNDED RESPONSE READING
// ============================================================================
export class ResponseTooLargeError extends Error {
  constructor() {
    super(`Upstream response exceeded ${MAX_RESPONSE_BODY_BYTES / (1024 * 1024)} MB`);
    this.name = "ResponseTooLargeError";
  }
}

const RESPONSE_TOO_LARGE_MESSAGE = `Upstream response too large (over ${MAX_RESPONSE_BODY_BYTES / (1024 * 1024)} MB). The request was aborted to protect memory.`;

// Read an upstream response body incrementally, aborting as soon as it grows
// past MAX_RESPONSE_BODY_BYTES instead of buffering it whole. Works with both
// node-fetch (Node Readable) and WHATWG (undici Response) body streams — both
// are async-iterable. Throwing out of for-await destroys/cancels the stream.
async function readBodyBounded(
  body: unknown,
  maxBytes: number = MAX_RESPONSE_BODY_BYTES,
): Promise<string> {
  if (body === null || body === undefined) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<unknown>) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new ResponseTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Shared response-body handling: bounded read + content-type-aware parse.
async function readResponseData(response: {
  headers: { get(name: string): string | null };
  body?: unknown;
}): Promise<{ data: unknown; contentType: string | null }> {
  const contentType = response.headers.get("content-type");
  const raw = await readBodyBounded(response.body);
  const data = contentType?.includes("application/json") ? JSON.parse(raw) : raw;
  return { data, contentType };
}

function safeResponseMetadata(
  ok: boolean,
  contentType: string | null,
): { statusText: string; contentType: string } {
  return {
    statusText: ok ? "OK" : "Upstream request failed",
    contentType: contentType?.toLowerCase().includes("application/json")
      ? "application/json"
      : "text/plain",
  };
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

// node-fetch (not the global undici fetch) is REQUIRED here: only node-fetch
// honors the `agent` option. Undici silently ignores `agent` and would connect
// directly, sending "Tor-proxied" traffic over clearnet.
type FetchImpl = (url: string, init?: object) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: unknown;
}>;
let cachedNodeFetch: FetchImpl | undefined;
async function getNodeFetch(): Promise<FetchImpl> {
  if (!cachedNodeFetch) {
    cachedNodeFetch = (await import("node-fetch")).default as unknown as FetchImpl;
  }
  return cachedNodeFetch;
}

interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
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

export async function makeProxiedRequest(req: ProxyRequest & { torProxyUrl?: string }): Promise<ProxyResponse> {
  const startTime = Date.now();
  const proxyUrl = canonicalizeSocksProxyUrl(req.torProxyUrl || DEFAULT_TOR_PROXY);
  const timeout = clampProxyTimeout(req.timeout);

  try {
    if (!proxyUrl) {
      return { success: false, error: "Tor proxy settings require remote DNS resolution.", latency: 0 };
    }
    const fetchImpl = await getNodeFetch();
    const agent = new SocksProxyAgent(proxyUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: Record<string, unknown> = {
      method: req.method || "GET",
      headers: req.headers,
      signal: controller.signal,
      agent,
      redirect: "error",
    };

    const body = serializeRequestBody(req.body);
    if (body && (req.method === "POST" || req.method === "PUT")) {
      fetchOptions.body = body;
    }

    // The timeout MUST be cleared on every exit path (including fetch
    // rejection), or repeated failures accumulate live timers/controllers.
    try {
      const response = await fetchImpl(req.url, fetchOptions);

      const latency = Date.now() - startTime;

      const { data, contentType } = await readResponseData(response);
      const safeMetadata = safeResponseMetadata(response.ok, contentType);

      return {
        success: response.ok,
        status: response.status,
        statusText: safeMetadata.statusText,
        data,
        latency,
        contentType: safeMetadata.contentType,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const latency = Date.now() - startTime;

    if (error instanceof Error) {
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
export async function makeDirectRequest(req: ProxyRequest): Promise<ProxyResponse> {
  const startTime = Date.now();
  const timeout = clampProxyTimeout(req.timeout);

  try {
    const fetchImpl = await getNodeFetch();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: Record<string, unknown> = {
      method: req.method || "GET",
      headers: req.headers,
      signal: controller.signal,
      redirect: "error",
    };

    const body = serializeRequestBody(req.body);
    if (body && (req.method === "POST" || req.method === "PUT")) {
      fetchOptions.body = body;
    }

    // The timeout MUST be cleared on every exit path (including fetch
    // rejection), or repeated failures accumulate live timers/controllers.
    try {
      const response = await fetchImpl(req.url, fetchOptions);

      const latency = Date.now() - startTime;

      const { data, contentType } = await readResponseData(response);
      const safeMetadata = safeResponseMetadata(response.ok, contentType);

      return {
        success: response.ok,
        status: response.status,
        statusText: safeMetadata.statusText,
        data,
        latency,
        contentType: safeMetadata.contentType,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const latency = Date.now() - startTime;

    if (error instanceof Error) {
      if (error instanceof ResponseTooLargeError) {
        return { success: false, error: RESPONSE_TOO_LARGE_MESSAGE, latency };
      }

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

// ============================================================================
// ROUTES
// ============================================================================

// Issues the per-process settings token, but only to loopback clients — this
// is what makes /settings an authorized local channel rather than a
// LAN-writable trust API.
router.get("/settings-token", (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({
      success: false,
      error: "Tor proxy settings can only be managed from the local machine.",
    });
  }
  res.json({ success: true, token: SETTINGS_BOOTSTRAP_TOKEN });
});

// The client pushes the relevant slice of its stored node settings here (on
// load and whenever they change). All allowlisting and proxy decisions for
// /request are derived from this server-held state, never per-request input.
router.post("/settings", (req: Request, res: Response) => {
  if (!hasValidSettingsToken(req)) {
    return res.status(403).json({
      success: false,
      error: "Missing or invalid settings token. Tor proxy settings can only be managed by the local application.",
    });
  }
  const result = updateTorProxySettings(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true });
});

// Test-only hook (disabled in production builds): drop the pushed settings to
// simulate a server restart, so a real-browser check can drive the client's
// 428 → invalidate → re-push → retry-once recovery loop without bouncing the
// dev-server process. Guarded by the same loopback-only settings token as
// /settings, and hidden (404) when NODE_ENV=production.
//
// Optional `rotateToken: true` in the body ALSO regenerates the per-process
// settings bootstrap token, modelling a REAL restart (which mints a fresh
// token). This lets the browser check exercise the client's stale-token path:
// 428 → re-push with the old token → 403 → token refetch → re-push → retry.
router.post("/settings/reset", (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ success: false, error: "Not found" });
  }
  if (!hasValidSettingsToken(req)) {
    return res.status(403).json({
      success: false,
      error: "Missing or invalid settings token. Tor proxy settings can only be managed by the local application.",
    });
  }
  resetTorProxySettings();
  const rotate = (req.body as Record<string, unknown> | undefined)?.rotateToken === true;
  if (rotate) {
    SETTINGS_BOOTSTRAP_TOKEN = randomBytes(32).toString("hex");
  }
  res.json({ success: true, rotated: rotate });
});

router.post("/request", async (req: Request, res: Response) => {
  // Bound the incoming envelope (the global JSON parser applies its own cap
  // too; this gives a clean, explicit 413 for the proxy route).
  const contentLength = parseInt(req.headers["content-length"] || "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_INCOMING_CONTENT_LENGTH) {
    return res.status(413).json({ success: false, error: "Request too large" });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { url, timeout } = body as { url?: string; timeout?: number };
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
  // NOTE: legacy per-request `allowedHost`, `trustedLocalHosts`, and
  // `torProxyUrl` fields are deliberately ignored — trust is server-side now.

  if (!url || typeof url !== "string") {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  if (!ALLOWED_METHODS.has(method)) {
    return res.status(405).json({ success: false, error: `Method ${method} is not allowed through the proxy` });
  }

  const serializedBody = serializeRequestBody(body.body);
  if (serializedBody && serializedBody.length > MAX_REQUEST_BODY_BYTES) {
    return res.status(413).json({ success: false, error: "Request body too large" });
  }

  const headers = sanitizeForwardHeaders(body.headers);

  // Validate URL to prevent SSRF attacks (server-side allowlist only)
  const urlCheck = isAllowedUrl(url);
  if (!urlCheck.allowed) {
    // If the local application hasn't pushed settings yet (e.g. right after a
    // server restart), tell it apart from a genuine rejection so it can sync
    // settings and retry once.
    if (!settingsInitialized) {
      return res.status(428).json({
        success: false,
        errorCode: "TOR_SETTINGS_NOT_INITIALIZED",
        error: "Tor proxy settings have not been synced by the local application yet.",
      });
    }
    return res.status(403).json({
      success: false,
      error: urlCheck.reason || "URL not allowed"
    });
  }

  let slotAcquired = false;
  try {
    await acquireProxySlot();
    slotAcquired = true;

    const proxiedReq: ProxyRequest = {
      url,
      method,
      headers,
      body: serializedBody,
      timeout: clampProxyTimeout(typeof timeout === "number" ? timeout : undefined),
    };

    // Use direct request for trusted local hosts (skip Tor proxy)
    if (urlCheck.isLocal) {
      console.log("[KYUTXO] Making direct request to trusted local host");
      const result = await makeDirectRequest(proxiedReq);
      return res.json(result);
    }

    // Use Tor proxy for remote/onion addresses; SOCKS URL comes from
    // server-side settings, never from the request.
    const result = await makeProxiedRequest({
      ...proxiedReq,
      torProxyUrl: getTorProxySettings().torProxyUrl,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ProxyQueueError) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    throw error;
  } finally {
    if (slotAcquired) releaseProxySlot();
  }
});

router.post("/test", async (_req: Request, res: Response) => {
  const proxiesToTest: { name: string; url: string; port?: number }[] = [
    { name: "Tor Browser", url: TOR_BROWSER_PROXY, port: 9150 },
    { name: "Tor Service", url: DEFAULT_TOR_PROXY, port: 9050 },
  ];

  // Test the configured custom proxy first (from server-side settings).
  const configuredProxy = getTorProxySettings().torProxyUrl;
  if (configuredProxy && configuredProxy !== TOR_BROWSER_PROXY && configuredProxy !== DEFAULT_TOR_PROXY) {
    proxiesToTest.unshift({ name: "Custom", url: configuredProxy });
  }

  for (const proxy of proxiesToTest) {
    try {
      const result = await makeProxiedRequest({
        url: "https://check.torproject.org/api/ip",
        torProxyUrl: proxy.url,
        timeout: 10000,
      });

      if (result.success) {
        const torCheck = result.data as { IsTor?: boolean; IP?: string };
        if (torCheck.IsTor) {
          return res.json({
            success: true,
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
    testedProxies: proxiesToTest.map(p => p.name),
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
          port: proxy.port,
          available: true,
          isTor: torCheck.IsTor || false,
          exitIp: torCheck.IP,
          latency: result.latency,
        });
      } else {
        results.push({
          name: proxy.name,
          port: proxy.port,
          available: false,
          error: result.error,
        });
      }
    } catch (error) {
      logProxyError(`[KYUTXO] Tor status check (${proxy.name}) failed`, error);
      results.push({
        name: proxy.name,
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

function hasValidSettingsToken(req: Request): boolean {
  const presented = req.headers["x-tor-settings-token"];
  if (typeof presented !== "string" || presented.length !== SETTINGS_BOOTSTRAP_TOKEN.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(presented), Buffer.from(SETTINGS_BOOTSTRAP_TOKEN));
}

function isLoopbackRequest(req: Request): boolean {
  const addr = req.socket.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// `let` (not const) solely so the dev-only /settings/reset hook can rotate it
// when simulating a full server restart; production never mutates it.
let SETTINGS_BOOTSTRAP_TOKEN = randomBytes(32).toString("hex");
