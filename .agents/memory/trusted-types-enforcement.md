---
name: Trusted Types enforcement
description: Production CSP enforces require-trusted-types-for; app sinks use the kyutxo-app policy, third-party sinks rely on an eagerly-installed default policy with an exact-string allowlist.
---

**Rule:** The packaged app's CSP sends `require-trusted-types-for 'script'`. Every HTML-parsing sink must be covered BEFORE the first React commit:

1. App-owned sinks go through `trustedHtml()` (policy `kyutxo-app`).
2. Third-party raw-string sinks (Radix ScrollArea/Select inject static `<style>` CSS via `dangerouslySetInnerHTML`) are covered by a `default` policy whose allowlist is EXACT-string.

**Why:**
- Policies must be installed eagerly at module load (imported from main.tsx). Installing lazily on first `trustedHtml()` call is too late — Radix's style sinks fire during the first commit and the whole React tree unmounts with a TypeError. This failure is invisible in jsdom/vitest and in dev without the CSP header.
- With a default policy installed, a blocked raw sink throws the POLICY's error, not the browser's native TypeError — probes must treat any throw as "blocked".
- A Radix upgrade that changes the injected strings breaks the packaged app; the exact-match allowlist fails closed and the browser check catches it.

**Directive syntax gotcha:** the `trusted-types` policy-name allowlist directive takes BARE names — `trusted-types kyutxo-app default`. Quoting `'default'` is invalid syntax: Chromium ignores the value, treats the directive as an empty allowlist, and blocks creation of the `default` policy — the Radix style sinks then crash the tree exactly like the eager-install failure.

**How to apply:** New `dangerouslySetInnerHTML`/document.write sinks must route through `trustedHtml()`; new third-party raw sinks need a default-policy allowlist entry. Verify with `node scripts/check-trusted-types-browser.mjs`, which injects the enforcing CSP header into dev-server document responses (dev sends no CSP). Note: after vault creation, a second `page.goto` reloads into the vault-lock screen — assert on the SPA's current route instead.
