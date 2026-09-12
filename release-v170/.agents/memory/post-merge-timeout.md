---
name: Post-merge db:push timeout
description: Why the post-merge step times out and the correct fix (raise timeout, keep the step).
---

# Post-merge `db:push` is slow and a no-op, but keep it

`scripts/post-merge.sh` runs `npm install`, `npm run db:push` (drizzle-kit), and
`scripts/install-hooks.sh`. The `db:push` step pulls the Postgres schema and
takes roughly 10-23s depending on load, and it reports **"No changes detected"
every time** because this project is an offline-first Electron/IndexedDB app
(Dexie is the real data layer; Postgres/drizzle is near-vestigial template
scaffolding).

**Rule:** If the post-merge step times out, raise the post-merge timeout via
`setPostMergeConfig({ scriptPath: "scripts/post-merge.sh", timeoutMs: ... })`
(set to 120000ms). Do **not** delete the `db:push` step to save time.

**Why:** The default 20000ms timeout was too tight for `db:push`'s variable
10-23s runtime, so merges intermittently failed setup even though nothing was
wrong. Removing `db:push` would be faster but risks silently skipping a real
schema change if a future task ever does add Postgres-backed tables.

**How to apply:** On any "post-merge setup timed out" alert here, first check the
log tail — if it's just `db:push` being slow ("No changes detected"), the fix is
the timeout, not the script. Verify with `runPostMergeSetup()` (expect ~15s,
`success: true`).

**Note:** `getPostMergeConfig()` can return a stale `timeoutMs` right after
`setPostMergeConfig()`; the source of truth is the `[postMerge]` section in
`.replit`. Confirm there if in doubt.
