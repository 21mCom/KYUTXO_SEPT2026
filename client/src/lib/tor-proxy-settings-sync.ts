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

// Dedup key of the last successfully pushed payload, so hook re-renders and
// per-request ensure calls don't spam the endpoint with identical settings.
let lastSyncedKey: string | null = null;

// Cached bootstrap token fetch (browser path only).
let settingsTokenPromise: Promise<string | null> | null = null;

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
  return {
    customProviderUrl: isCustomProvider ? settings.customUrl : undefined,
    trustedLocalHosts: settings.allowLocalNetwork ? settings.trustedLocalHosts ?? [] : [],
    torProxyUrl: settings.torProxyUrl,
  };
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
      const response = await fetch('/api/tor/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tor-settings-token': token,
        },
        body: JSON.stringify(normalized),
      });
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
