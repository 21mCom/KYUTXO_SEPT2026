// Regression guard for the stale-settings-token recovery path.
//
// The Tor proxy settings push (POST /api/tor/settings) is authorized by a
// per-process bearer token that the server regenerates on every start. The
// client caches the token forever once fetched, so after a REAL server
// restart the 428-recovery loop in esplora-base would re-push with the OLD
// token, get a 403, and the recovery would fail anyway. syncTorProxySettings
// must treat a 403 on the push as "token is stale": re-fetch the token and
// retry the push once.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./electron', () => ({
  isElectron: () => false,
  getElectronAPI: () => {
    throw new Error('not electron');
  },
}));

type SyncModule = typeof import('./tor-proxy-settings-sync');

const PAYLOAD = {
  customProviderUrl: 'http://127.0.0.1:3999',
  trustedLocalHosts: ['127.0.0.1'],
  torProxyUrl: undefined,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('syncTorProxySettings stale-token recovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sync: SyncModule;

  beforeEach(async () => {
    // Fresh module state (token cache + dedup key are module-level).
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    sync = await import('./tor-proxy-settings-sync');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('re-fetches the token and retries once when the push is rejected with 403', async () => {
    // 1st sync succeeds with token A and warms the token cache.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'token-A' })) // GET settings-token
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // POST settings
    expect(await sync.syncTorProxySettings(PAYLOAD)).toBe(true);

    // Server "restarts": token A is now stale. The 428-recovery caller forces
    // a re-push; the push must survive the 403 by refreshing the token.
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { success: false, error: 'bad token' })) // POST with stale token-A
      .mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'token-B' })) // GET settings-token (refresh)
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // retried POST

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await sync.syncTorProxySettings(PAYLOAD, { force: true });
    expect(ok).toBe(true);
    expect(consoleWarn).not.toHaveBeenCalled();

    const calls = fetchMock.mock.calls;
    expect(calls.length).toBe(3);
    // First call: push with the stale cached token (no token fetch up front).
    expect(calls[0][0]).toBe('/api/tor/settings');
    expect((calls[0][1] as RequestInit).headers).toMatchObject({
      'x-tor-settings-token': 'token-A',
    });
    // Then the token refresh, then the retried push with the fresh token.
    expect(calls[1][0]).toBe('/api/tor/settings-token');
    expect(calls[2][0]).toBe('/api/tor/settings');
    expect((calls[2][1] as RequestInit).headers).toMatchObject({
      'x-tor-settings-token': 'token-B',
    });
  });

  it('uses the refreshed token for later syncs (cache actually replaced)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'token-A' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    expect(await sync.syncTorProxySettings(PAYLOAD)).toBe(true);

    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { success: false }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'token-B' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    expect(await sync.syncTorProxySettings(PAYLOAD, { force: true })).toBe(true);

    // Next forced sync must go straight to the push with token-B (no refetch).
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    expect(await sync.syncTorProxySettings(PAYLOAD, { force: true })).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tor/settings');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      'x-tor-settings-token': 'token-B',
    });
  });

  it('returns false (does not loop) when the retried token fetch also fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'token-A' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    expect(await sync.syncTorProxySettings(PAYLOAD)).toBe(true);

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { success: false })) // stale push
      .mockResolvedValueOnce(jsonResponse(500, { success: false })); // token refresh fails
    expect(await sync.syncTorProxySettings(PAYLOAD, { force: true })).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(consoleWarn).toHaveBeenCalled();
  });

  it('still fails after one retry when the fresh token is also rejected (no infinite loop)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'token-A' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    expect(await sync.syncTorProxySettings(PAYLOAD)).toBe(true);

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { success: false }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'token-B' }))
      .mockResolvedValueOnce(jsonResponse(403, { success: false })); // still rejected
    expect(await sync.syncTorProxySettings(PAYLOAD, { force: true })).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(3); // exactly one retry, no loop
    expect(consoleWarn).toHaveBeenCalled();
  });
});
