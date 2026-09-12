---
name: vitest shares the dev-server vite cache (do not delete .vite)
description: Why vitest runs hang in this repo, and how to keep them fast/non-flaky.
---

# vitest + vite optimizeDeps cache

**Rule:** Do NOT delete `node_modules/.vite` (or otherwise cold-bust the vite
optimizeDeps cache) while the `Start application` dev server is running. Run
vitest only with that cache warm.

**Why:** vitest uses vite's `optimizeDeps`, and tests that import the real
`@/lib/database` pull in the heavy bitcoin dependency graph (bitcoinjs-lib,
bip32/bip39, etc.). Cold-optimizing that graph takes a long time and contends
with the dev server (which shares the same `.vite` cache and rebuilds it
simultaneously). The result is vitest hanging right after the `RUN v4.x` banner
with no further output, and detached runs getting killed before they finish — it
looks like a test failure but it is pure cache/cold-start contention, not a real
failure. Warm runs of the same files pass.

**How to apply:**
- If vitest hangs after the `RUN` banner: restart the `Start application`
  workflow to cleanly rebuild `.vite`, wait for it to serve (curl localhost:5000
  → 200), then run vitest. Do not `pkill -f vitest` (it can kill the agent's own
  shell → exit 143).
- Prefer running a *small set* of target test files, not the whole suite — the
  full suite times out here on volume, independent of correctness.
- `/tmp` is NOT shared across separate bash tool invocations; write run logs to a
  `.local/...` workspace path and poll that file instead.
