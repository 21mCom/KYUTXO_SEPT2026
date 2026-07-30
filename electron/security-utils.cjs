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

// In-window navigation is allowed only to the dev server origin or file:
// URLs (the packaged app loads from disk). Anything else — arbitrary https
// origins, scriptable schemes, malformed input — is denied so a compromised
// page can't navigate the app window to an attacker site.
const DEV_SERVER_ORIGIN = 'http://localhost:5000';

function isNavigationAllowed(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === DEV_SERVER_ORIGIN ||
      parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

const torRequestSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  timeout: z.number().int().positive().optional(),
  torProxyUrl: z.string().optional(),
  allowedHost: z.string().optional(),
  trustedLocalHosts: z.array(z.string()).optional(),
});

module.exports = {
  EXTERNAL_OPEN_ALLOWED_HOSTS,
  isExternalOpenAllowed,
  DEV_SERVER_ORIGIN,
  isNavigationAllowed,
  torRequestSchema,
};
