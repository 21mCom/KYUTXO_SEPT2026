---
name: SOCKS URL parsing in browsers
description: Cross-runtime rule for safely parsing and canonicalizing SOCKS proxy URLs.
---

Chromium does not treat `socks5` or `socks5h` as special authority-based URL schemes. For an authority-only SOCKS URL, browser `URL` can leave hostname and port empty and place the entire `//host:port` portion in pathname, while Node parses hostname and port as expected.

**Why:** A migration validated by Node tests silently failed in the real browser because the renderer rejected the same valid stored SOCKS URL.

**How to apply:** Strictly recognize the SOCKS scheme first, then parse the remaining authority by temporarily prefixing a known special scheme such as HTTP. Keep real-browser coverage for any renderer-side SOCKS canonicalization.