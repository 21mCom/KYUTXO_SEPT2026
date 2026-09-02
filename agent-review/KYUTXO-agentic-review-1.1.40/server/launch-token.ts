import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Per-launch secret that authenticates the app UI to the local API server.
// The server binds loopback-only, but any local process (a malicious web page
// in another tab, another local app) can still reach 127.0.0.1 — so every
// /api request must present this random token as a header. The token is
// injected into the served HTML as a <meta> tag; same-origin JS reads it and
// attaches it to API fetches, while cross-origin pages can neither read it
// (same-origin policy) nor set the custom header without a CORS preflight
// this server never grants.
//
// KYUTXO_LAUNCH_TOKEN env var may override the random token (e.g. if a
// wrapper process needs to pre-share it); otherwise it is generated fresh
// on every launch.
export const LAUNCH_TOKEN =
  process.env.KYUTXO_LAUNCH_TOKEN || randomBytes(32).toString("base64url");

export const LAUNCH_TOKEN_HEADER = "x-kyutxo-launch-token";
export const LAUNCH_TOKEN_META = "kyutxo-launch-token";

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireLaunchToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const presented = req.get(LAUNCH_TOKEN_HEADER);
  if (presented && tokensEqual(presented, LAUNCH_TOKEN)) {
    next();
    return;
  }
  res.status(401).json({ message: "Unauthorized" });
}

// --- DNS-rebinding defense -------------------------------------------------
// A malicious website can point its own hostname at the attacker's server,
// then flip the DNS record to 127.0.0.1. The victim's browser then treats
// attacker.com as same-origin with this local server: the page can fetch the
// served HTML, read the launch-token <meta> tag, and replay it against /api —
// bypassing the token entirely. The one thing the attacker cannot forge is
// the Host header the browser sends (it stays attacker.com), so rejecting
// unexpected Host values closes the hole.

// Strict host:port grammar: the optional port suffix must be ":" followed by
// digits only. Anything else (":5000.attacker.com", ":attacker.com", empty
// ":") makes the whole value invalid — return the original string so it can
// never match an allowlisted hostname.
const PORT_SUFFIX = /^:\d{1,5}$/;

function stripHostPort(host: string): string {
  // Bracketed IPv6 literal, e.g. [::1]:5000.
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return host;
    const rest = host.slice(close + 1);
    if (rest !== "" && !PORT_SUFFIX.test(rest)) return host;
    return host.slice(0, close + 1);
  }
  const colon = host.indexOf(":");
  if (colon === -1) return host;
  if (!PORT_SUFFIX.test(host.slice(colon))) return host;
  return host.slice(0, colon);
}

export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = stripHostPort(host.trim()).toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  ) {
    return true;
  }
  // Replit's preview proxy connects with its own *.replit.dev hostname, and
  // published (autoscale) deployments are served from a *.replit.app
  // hostname; both are only honored when actually running inside a Replit
  // environment (mirrors the Vite allowedHosts scoping in index-dev.ts).
  // These are registered public-suffix domains, so an attacker cannot point
  // an arbitrary DNS name at them without controlling a Replit deployment.
  if (
    process.env.REPL_ID &&
    (hostname.endsWith(".replit.dev") || hostname.endsWith(".replit.app"))
  ) {
    return true;
  }
  return false;
}

// Rejects any request whose Host header is not a loopback name (or the
// Replit dev domain when applicable). Mounted for every response so rebound
// hostnames can neither read the token-bearing HTML nor reach the API.
export function rejectUnknownHosts(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isAllowedHost(req.headers.host)) {
    next();
    return;
  }
  res.status(403).json({ message: "Forbidden" });
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function launchTokenMetaTag(token: string = LAUNCH_TOKEN): string {
  return `<meta name="${LAUNCH_TOKEN_META}" content="${escapeHtmlAttr(token)}" />`;
}

// Injects the launch token <meta> tag into a served HTML document so the
// client bootstrap can authenticate its own API requests.
export function injectLaunchToken(
  html: string,
  token: string = LAUNCH_TOKEN,
): string {
  const tag = launchTokenMetaTag(token);
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n    ${tag}`);
  }
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return `${html.slice(0, headClose)}${tag}\n  ${html.slice(headClose)}`;
  }
  return `${tag}\n${html}`;
}
