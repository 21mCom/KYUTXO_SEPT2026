// Client half of the per-launch API token (see server/launch-token.ts).
// The server injects the token into the served HTML as a <meta> tag; this
// module reads it and wraps window.fetch so every same-origin /api request
// carries the token header. Requests from other origins can't read the meta
// tag (same-origin policy) and can't set the custom header without a CORS
// preflight the server never grants.

const LAUNCH_TOKEN_HEADER = "x-kyutxo-launch-token";
const LAUNCH_TOKEN_META = "kyutxo-launch-token";
const INSTALLED_FLAG = "__kyutxoLaunchTokenFetchInstalled";

export function getLaunchToken(): string | null {
  if (typeof document === "undefined") return null;
  return (
    document
      .querySelector(`meta[name="${LAUNCH_TOKEN_META}"]`)
      ?.getAttribute("content") ?? null
  );
}

function isLocalApiUrl(url: string): boolean {
  if (url === "/api" || url.startsWith("/api/")) return true;
  try {
    const parsed = new URL(url, window.location.href);
    return (
      parsed.origin === window.location.origin &&
      (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/"))
    );
  } catch {
    return false;
  }
}

export function installLaunchTokenFetch(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  const win = window as unknown as Record<string, unknown>;
  if (win[INSTALLED_FLAG]) return;

  const token = getLaunchToken();
  if (!token) {
    // Packaged Electron loads the UI from file:// and talks to attachment/Tor
    // backends over IPC instead of HTTP, so there is no token to attach.
    return;
  }
  win[INSTALLED_FLAG] = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isLocalApiUrl(url)) {
        const request = new Request(input, init);
        if (!request.headers.has(LAUNCH_TOKEN_HEADER)) {
          request.headers.set(LAUNCH_TOKEN_HEADER, token);
        }
        return originalFetch(request);
      }
    } catch {
      // Fall through to the unmodified fetch on any URL parsing issue.
    }
    return originalFetch(input, init);
  };
}
