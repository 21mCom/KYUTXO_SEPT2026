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
