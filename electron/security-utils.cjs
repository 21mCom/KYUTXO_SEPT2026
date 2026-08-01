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

module.exports = {
  EXTERNAL_OPEN_ALLOWED_HOSTS,
  isExternalOpenAllowed,
  DEV_SERVER_ORIGIN,
  isNavigationAllowed,
  escapeHtml,
  torRequestSchema,
  torProxySettingsSchema,
};
