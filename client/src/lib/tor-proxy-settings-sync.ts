import { isElectron, getElectronAPI, type TorUpdateSettingsParams } from './electron';
import type { NodeSettings } from './database';

// The Tor proxy (Express route in the browser, Electron main process in the
// desktop app) derives its destination allowlist and SOCKS proxy URL from
// settings pushed here — never from per-request input. The client pushes the
// relevant slice of its stored node settings on load and whenever they change.
//
// Browser pushes are authorized by a per-process bearer token that the server
// only issues to loopback clients (GET /api/tor/settings-token), so a caller
// reaching the server over the LAN cannot rewrite the proxy's trust state.
// Electron pushes go over IPC, which is inherently local.

export type TorProxySettingsPayload = TorUpdateSettingsParams;

export type CanonicalTorProxyUrlResult =
  | { ok: true; value: string | undefined; migrated: boolean }
  | { ok: false; error: string };

export function canonicalizeTorProxyUrl(value: string | undefined): CanonicalTorProxyUrlResult {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: true, value: undefined, migrated: false };

  try {
    const schemeMatch = /^(socks5h?):\/\//i.exec(trimmed);
    if (!schemeMatch) {
      throw new Error('unsupported proxy scheme');
    }
    // Browsers do not parse socks5 as an authority-based special scheme:
    // hostname/port are empty and "//host:port" becomes the pathname. Parse
    // the authority through HTTP after strictly validating the real scheme.
    const parsed = new URL(`http://${trimmed.slice(schemeMatch[0].length)}`);
    if (
      !parsed.hostname ||
      !parsed.port ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search ||
      parsed.hash
    ) {
      return {
        ok: false,
        error: 'Enter a SOCKS5 proxy as socks5h://host:port. The socks5h scheme is required so DNS resolves through Tor.',
      };
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        error: 'Enter a SOCKS5 proxy as socks5h://host:port with a valid port.',
      };
    }
    const withoutRootSlash = trimmed.replace(/\/$/, '');
    if (schemeMatch[1].toLowerCase() === 'socks5') {
      return {
        ok: true,
        value: withoutRootSlash.replace(/^socks5:/i, 'socks5h:'),
        migrated: true,
      };
    }
    return { ok: true, value: withoutRootSlash, migrated: withoutRootSlash !== trimmed };
  } catch {
    return {
      ok: false,
      error: 'Enter a SOCKS5 proxy as socks5h://host:port. The socks5h scheme is required so DNS resolves through Tor.',
    };
  }
}

// Dedup key of the last successfully pushed payload, so hook re-renders and
// per-request ensure calls don't spam the endpoint with identical settings.
let lastSyncedKey: string | null = null;

// Cached bootstrap token fetch (browser path only).
let settingsTokenPromise: Promise<string | null> | null = null;

// The token is per-server-process: a REAL server restart regenerates it, so a
// 403 on the settings push means our cached token is stale. Drop the cache so
// the next getBrowserSettingsToken() fetches a fresh one.
function invalidateBrowserSettingsToken(): void {
  settingsTokenPromise = null;
}

async function getBrowserSettingsToken(): Promise<string | null> {
  if (!settingsTokenPromise) {
    settingsTokenPromise = (async (): Promise<string | null> => {
      try {
        const response = await fetch('/api/tor/settings-token');
        if (!response.ok) {
          console.warn(
            `[KYUTXO] Tor proxy settings token unavailable (HTTP ${response.status}) — custom node settings cannot be synced from this client.`,
          );
          return null;
        }
        const data = (await response.json()) as { token?: unknown };
        return typeof data?.token === 'string' ? data.token : null;
      } catch (error) {
        console.warn('[KYUTXO] Failed to fetch Tor proxy settings token:', error);
        return null;
      }
    })();
    // A failed fetch is retried on the next sync attempt rather than cached
    // forever (e.g. server still starting up).
    settingsTokenPromise.then((token) => {
      if (token === null) settingsTokenPromise = null;
    });
  }
  return settingsTokenPromise;
}

// Clear the dedup cache so the next sync re-pushes even an unchanged payload.
// Used when the server reports it lost its settings (restart).
export function invalidateTorProxySettingsSync(): void {
  lastSyncedKey = null;
}

// Build the payload from stored node settings. The custom provider host is
// only allowlisted while a custom provider is actually selected, and trusted
// local hosts are only pushed when local-network access is enabled.
export function torProxySettingsFromNodeSettings(settings: NodeSettings): TorProxySettingsPayload {
  const isCustomProvider =
    settings.providerType === 'custom-electrs' || settings.providerType === 'custom-mempool';
  const normalizedProxy = canonicalizeTorProxyUrl(settings.torProxyUrl);
  return {
    customProviderUrl: isCustomProvider ? settings.customUrl : undefined,
    trustedLocalHosts: settings.allowLocalNetwork ? settings.trustedLocalHosts ?? [] : [],
    // Invalid legacy values fail closed in the runtime settings validator.
    // A valid socks5:// value is safely upgraded to socks5h:// before use.
    torProxyUrl: normalizedProxy.ok ? normalizedProxy.value : settings.torProxyUrl,
  };
}

function pushBrowserSettings(
  normalized: object,
  token: string,
): Promise<Response> {
  return fetch('/api/tor/settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tor-settings-token': token,
    },
    body: JSON.stringify(normalized),
  });
}

// Push settings to the proxy. Returns true when the proxy accepted them.
// Failures leave the dedup cache untouched so the next call retries; callers
// can treat this as best-effort because a stale/missing allowlist fails closed
// (requests get a clear 403/428) rather than open.
export async function syncTorProxySettings(
  payload: TorProxySettingsPayload,
  options?: { force?: boolean },
): Promise<boolean> {
  const normalized = {
    customProviderUrl: payload.customProviderUrl || undefined,
    trustedLocalHosts: payload.trustedLocalHosts ?? [],
    torProxyUrl: payload.torProxyUrl || undefined,
  };
  const key = JSON.stringify(normalized);
  if (!options?.force && key === lastSyncedKey) return true;

  try {
    if (isElectron()) {
      const result = await getElectronAPI().torUpdateSettings(normalized);
      if (result && result.success === false) {
        throw new Error(result.error || 'Tor proxy rejected settings');
      }
    } else {
      const token = await getBrowserSettingsToken();
      if (!token) return false;
      let response = await pushBrowserSettings(normalized, token);
      if (response.status === 403) {
        // The bearer token is regenerated on every server start, so a 403 here
        // most likely means the server restarted and our cached token is
        // stale. Re-fetch the token and retry ONCE — otherwise the 428
        // recovery loop in esplora-base can never survive a real restart.
        invalidateBrowserSettingsToken();
        const freshToken = await getBrowserSettingsToken();
        if (!freshToken) return false;
        response = await pushBrowserSettings(normalized, freshToken);
      }
      if (!response.ok) {
        throw new Error(`Tor proxy settings sync failed: HTTP ${response.status}`);
      }
    }
    lastSyncedKey = key;
    return true;
  } catch (error) {
    console.warn('[KYUTXO] Failed to sync Tor proxy settings:', error);
    return false;
  }
}
