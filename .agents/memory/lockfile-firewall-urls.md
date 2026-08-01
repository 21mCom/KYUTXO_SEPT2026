---
name: lockfile firewall URLs (lockfile-urls CI gate)
description: Why installing any npm package can break the lockfile-urls CI check, and how to fix it.
---

# package-lock.json firewall URLs break the `lockfile-urls` CI gate

Installing npm packages in this repl goes through Replit's package firewall, which
writes `resolved` URLs like `http://package-firewall.replit.local/npm/<pkg>/-/<pkg>-x.y.z.tgz`
into `package-lock.json`. The repo has a CI workflow `lockfile-urls`
(`scripts/check-lockfile-urls.js`) that FAILS on any `package-firewall.replit.local`
URL because those only resolve inside Replit and break external CI (`npm ci` on GitHub).

**Rule:** after ANY package install, rewrite those URLs before completing:
`sed -i 's#http://package-firewall.replit.local/npm/#https://registry.npmjs.org/#g' package-lock.json`
then re-run `node scripts/check-lockfile-urls.js` (expect exit 0).

**Why:** the gate exists so the lockfile stays portable to external CI. Editing
`package-lock.json` is allowed and expected here; only `package.json` (and the vite/
drizzle config files) are off-limits.

**How to apply:** any task that runs the package manager (new deps, font packages,
etc.) must do this rewrite as part of the change, or the workflow goes red.

## Malformed rewrite trap (2026-08)

A naive host-only rewrite of firewall URLs (which the OLD check-lockfile-urls fix-hint itself suggested) produces `https://registry.npmjs.org/<name>-<ver>.tgz` — missing the `/-/` segment — which 404s exactly like the firewall URL but passes a firewall-string-only gate, then kills post-merge `npm install` AND `npm ci` on the GitHub runner. Canonical form: `https://registry.npmjs.org/<name>/-/<basename>-<ver>.tgz` (scoped: name keeps `@scope/`, basename drops it). Reliable repair: derive name from the lockfile key after the last `node_modules/` + entry.version, rewrite `resolved`, then `npm install` to prove fetchability. The gate now also fails on npmjs URLs lacking `/-/`.
