---
name: npm audit remediation
description: How high/critical audit vulns were closed in this repo without breaking the toolchain.
---

Rule: fix transitive vulns by upgrading direct parents or targeted `overrides`; never `npm audit fix --force` (it downgrades electron-builder to v22).

**Why:** npm audit's "fix" for the electron-builder chain is a major DOWNGRADE; the real fix was a global override `"brace-expansion": "^5.0.8"` (v5 ships a CJS default-function export, so minimatch@3 consumers still work) which cleared ~16 highs at once. undici was fixed with a jsdom-scoped override (`"jsdom": {"undici": "^7.28.0"}`) so node-gyp's undici@6 stays untouched.

**How to apply:**
- vite 5→7 works with existing config/plugins, but requires `@types/node >= 20.19` (ERESOLVE otherwise) and `@tailwindcss/vite@latest` + `vitest@>=4.1.10` (older vitest bundles vulnerable vite 8.0.x).
- jspdf 3→4 is drop-in here (jspdf-autotable@5 peers ^2||^3||^4); verify with sample-pdf-browser-check.
- drizzle-orm 0.45.x is safe: only shared/schema.ts uses it.
- After ANY npm install: sed package-firewall.replit.local URLs back to registry.npmjs.org (lockfile-urls gate).
- Moderates cleared without majors: global override `"uuid": "^11.1.1"` fixes the vite-plugin-top-level-await + google-cloud/teeny-request chains (uuid 9/10→11 is API-compatible for v4()); scoped override `"@esbuild-kit/core-utils": {"esbuild": "^0.25.12"}` fixes drizzle-kit's esbuild.
- Gotcha: a scoped override can leave the old nested copy installed ("invalid ... overridden" in npm ls) — remove the nested subtree from node_modules and the lockfile, then reinstall.
- Firewall URL rewrite: npm writes both http and https package-firewall URLs, and a greedy `[^"]*` sed eats the package-name path segment, producing 404 tarball URLs — rewrite only the host+`/npm/` prefix and verify every `resolved` URL still contains `/-/`.
