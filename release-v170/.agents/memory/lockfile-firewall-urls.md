---
name: Lockfile firewall URLs
description: npm installs on Replit write internal firewall URLs into package-lock.json that break external CI
---
Any `npm install` inside Replit rewrites `resolved` URLs in package-lock.json to `http://package-firewall.replit.local/...`, which only resolves inside Replit and breaks `npm ci` elsewhere (a CI gate checks for this).

**Why:** the workspace routes npm through an internal package firewall proxy.

**How to apply:** after any install, run `node scripts/fix-lockfile-urls.mjs` — it rewrites affected `resolved` fields to the canonical `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz` form (scoped packages keep the scope in `<name>`, drop it in `<basename>`), re-runs the lockfile check, and verifies the rewritten URLs fetch from the registry.
