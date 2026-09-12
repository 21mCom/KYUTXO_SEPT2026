// Security decision logic for the Electron main process, kept in its own
// module (no `electron` import) so Node-level vitest tests can exercise it
// directly. main.cjs must stay a thin consumer of these helpers.

const { z } = require('zod');

// Hosts the desktop app is allowed to open in the user's external browser.
// Keep this list tight: trusted Bitcoin explorers plus the project repo/docs.
const EXTERNAL_OPEN_ALLOWED_HOSTS = [
  'mempool.space',
  'blockstream.info',
  'github.com',
];

// A URL may be opened externally only when it is a well-formed https: URL
// whose exact hostname is on the allowlist. Anything else (http:, other
// schemes like javascript:, subdomains, malformed input) is denied.
function isExternalOpenAllowed(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' &&
      EXTERNAL_OPEN_ALLOWED_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

// In-window navigation is allowed only to file: URLs (the packaged app loads
// from disk), plus the dev server origin when — and only when — the app is
// running in development mode. Anything else — arbitrary https origins,
// scriptable schemes, malformed input — is denied so a compromised page can't
// navigate the app window to an attacker site. In the packaged app the dev
// origin is NOT trusted: any local process could squat on port 5000.
const DEV_SERVER_ORIGIN = 'http://localhost:5000';

function isNavigationAllowed(rawUrl, { isDev = false } = {}) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'file:') return true;
    return isDev === true && parsed.origin === DEV_SERVER_ORIGIN;
  } catch {
    return false;
  }
}

// Escape a value for safe interpolation into HTML text content. Used by the
// packaged-app fallback error page (main.cjs) so file paths and error
// messages can never inject markup into the app window. Non-string input is
// coerced with String() so callers can pass anything without throwing.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// NOTE: per-request torProxyUrl / allowedHost / trustedLocalHosts were removed
// deliberately — allowlisting and the SOCKS proxy URL are derived from
// main-process settings (see torProxySettingsSchema / 'tor-update-settings'),
// never from individual request input.

// --- IPC error sanitization -------------------------------------------------
// Raw exception messages from Node embed absolute filesystem paths (ENOENT
// '/home/...'), proxy/target URLs, and host:port details. In the packaged app
// these strings cross the IPC bridge and reach the renderer/UI. Mirror the
// server's logServerError/logProxyError pattern: return a stable generic
// message to the renderer while preserving user-actionable hints (timeout,
// connection refused, ...) as fixed strings, and log only the error name +
// errno code main-process-side.

// Ordered classification: first match wins. Each entry maps a family of raw
// errors to ONE stable user-facing string that carries the actionable hint
// without any path/URL/host detail.
const IPC_ERROR_HINTS = [
  {
    match: (name, code, msg) =>
      name === 'AbortError' || code === 'ETIMEDOUT' || /\btime(?:d\s+)?out\b/i.test(msg),
    message: 'Request timed out. The server may be slow or unreachable — try increasing the timeout.',
  },
  {
    match: (_name, code, msg) => code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED'),
    message: 'Connection refused. Make sure the server (or Tor proxy) is running and reachable.',
  },
  {
    match: (_name, code, msg) =>
      code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN'),
    message: 'Host not found. Check the server address.',
  },
  {
    match: (_name, code, msg) =>
      code === 'ECONNRESET' || code === 'EPIPE' || msg.includes('ECONNRESET') || /socket (?:closed|hang ?up)/i.test(msg),
    message: 'Connection closed unexpectedly. Please try again.',
  },
  {
    match: (_name, code, msg) =>
      /certificate|CERT_|SSL|TLS/i.test(code || '') || /certificate|\bSSL\b|\bTLS\b/i.test(msg),
    message: 'Secure connection failed. Check your SSL/TLS settings.',
  },
  {
    match: (_name, code) => code === 'ENOENT',
    message: 'File not found.',
  },
  {
    match: (_name, code) => code === 'EACCES' || code === 'EPERM',
    message: 'Permission denied by the operating system.',
  },
  {
    match: (_name, code) => code === 'ENOSPC',
    message: 'Not enough disk space.',
  },
];

// Convert any thrown value into a stable, generic message safe to send over
// IPC to the renderer. `fallback` names the failed operation without leaking
// detail (e.g. 'Failed to save attachment').
function sanitizeIpcError(error, fallback = 'Operation failed') {
  const name = error && typeof error.name === 'string' ? error.name : '';
  const code = error && typeof error.code === 'string' ? error.code : '';
  const msg = error && typeof error.message === 'string' ? error.message : '';
  for (const hint of IPC_ERROR_HINTS) {
    try {
      if (hint.match(name, code, msg)) return hint.message;
    } catch {
      // A matcher must never break sanitization — fall through to next.
    }
  }
  return fallback;
}

// Log a failure main-process-side WITHOUT the raw error message (which can
// embed paths/URLs/hosts). The error name + errno code are enough to diagnose.
function logMainError(context, error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? error.code : '';
    console.error(`${context}: ${error.name}${code ? ` (${code})` : ''}`);
  } else {
    console.error(`${context}: unknown error`);
  }
}

const torRequestSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  timeout: z.number().int().positive().optional(),
});

// Settings pushed by the renderer (from stored node settings) that drive the
// main-process allowlist and proxy selection for 'tor-request'.
const torProxySettingsSchema = z.object({
  customProviderUrl: z.string().max(2048).nullish(),
  trustedLocalHosts: z.array(z.string().min(1).max(253)).max(64).optional(),
  torProxyUrl: z.string().max(255).nullish(),
});

// ---------------------------------------------------------------------------
// Electrum IPC schemas. Every electrum-* handler validates its renderer
// payload with one of these BEFORE any socket / SOCKS-proxy work, so a
// malformed or hostile renderer payload can never reach the network stack.
// ---------------------------------------------------------------------------

// Host as typed by the user; the client strips protocol prefixes and
// trailing slashes (cleanElectrumHost), so validate the CLEANED form:
// hostname-shaped only (letters, digits, dots, hyphens, underscores) —
// no whitespace, no control chars, no embedded ports/paths/credentials.
const electrumHostSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (raw) => {
      const cleaned = raw
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
      return (
        cleaned.length > 0 &&
        cleaned.length <= 253 &&
        /^[a-zA-Z0-9._-]+$/.test(cleaned)
      );
    },
    { message: 'must be a bare hostname or IP (no port, path, or special characters)' },
  );

const electrumPortSchema = z.number().int().min(1).max(65535);

// Optional SOCKS proxy override for Tor transport. When present and
// non-empty it must be a well-formed socks5:// or socks5h:// URL with a
// hostname; empty string / null / undefined mean "auto-detect".
const electrumTorProxyUrlSchema = z
  .string()
  .max(255)
  .refine(
    (value) => {
      if (value === '') return true;
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') &&
          parsed.hostname.length > 0
        );
      } catch {
        return false;
      }
    },
    { message: 'must be a socks5:// or socks5h:// URL' },
  )
  .nullish();

// Bounded so a hostile payload cannot park sockets/timers for days.
const electrumTimeoutSchema = z.number().int().min(1).max(600000).optional();

// Shape-level Bitcoin address check (base58 / bech32 are both alphanumeric).
// Full semantic validation still happens in addressToScripthash.
const bitcoinAddressSchema = z
  .string()
  .min(14)
  .max(90)
  .regex(/^[a-zA-Z0-9]+$/, 'must be a Bitcoin address');

const txidSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex transaction id');

// Opaque renderer-chosen cancellation group id. Strict shape (short,
// URL-safe alphanumeric) so it can never carry endpoint/path material.
const electrumCancelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be a short alphanumeric id')
  .nullish();

const electrumConnectionSchema = z.object({
  host: electrumHostSchema,
  port: electrumPortSchema,
  useSSL: z.boolean().nullish(),
  timeout: electrumTimeoutSchema,
  useTor: z.boolean().nullish(),
  torProxyUrl: electrumTorProxyUrlSchema,
  cancelId: electrumCancelIdSchema,
});

const electrumIpcSchemas = {
  test: electrumConnectionSchema,
  getHistory: electrumConnectionSchema.extend({ address: bitcoinAddressSchema }),
  getUtxos: electrumConnectionSchema.extend({ address: bitcoinAddressSchema }),
  getTransaction: electrumConnectionSchema.extend({
    txid: txidSchema,
    verbose: z.boolean().nullish(),
  }),
  getBlockHash: electrumConnectionSchema.extend({
    height: z
      .number({ invalid_type_error: 'Invalid block height', required_error: 'Invalid block height' })
      .int('Invalid block height')
      .min(0, 'Invalid block height')
      .max(100000000, 'Invalid block height'),
  }),
  batchGetHistory: electrumConnectionSchema.extend({
    addresses: z.array(bitcoinAddressSchema).min(1).max(10000),
  }),
  batchGetUtxos: electrumConnectionSchema.extend({
    addresses: z.array(bitcoinAddressSchema).min(1).max(10000),
  }),
  trustCertificate: z.object({
    host: electrumHostSchema,
    port: electrumPortSchema,
    certificate: z.object({ fingerprint: z.string().min(1).max(200) }).passthrough(),
  }),
  getCertificateTrust: z.object({
    host: electrumHostSchema,
    port: electrumPortSchema,
  }),
  revokeCertificate: z.object({
    host: electrumHostSchema,
    port: electrumPortSchema,
  }),
  cancel: z.object({
    cancelId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be a short alphanumeric id'),
  }),
};

// Parse a renderer IPC payload; returns { ok: true, data } or
// { ok: false, error } with a compact, user-readable message.
function validateElectrumIpc(schema, rawArgs) {
  const result = schema.safeParse(rawArgs);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const where = issue && issue.path && issue.path.length ? ` (${issue.path.join('.')})` : '';
  const detail = issue ? issue.message : 'malformed payload';
  return { ok: false, error: `Invalid Electrum request${where}: ${detail}` };
}

module.exports = {
  EXTERNAL_OPEN_ALLOWED_HOSTS,
  isExternalOpenAllowed,
  DEV_SERVER_ORIGIN,
  isNavigationAllowed,
  escapeHtml,
  sanitizeIpcError,
  logMainError,
  torRequestSchema,
  torProxySettingsSchema,
  electrumIpcSchemas,
  validateElectrumIpc,
};
