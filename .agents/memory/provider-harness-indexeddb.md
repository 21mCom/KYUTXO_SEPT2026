---
name: Provider-harness IndexedDB requirement
description: Why harness-based component tests crash with "IndexedDB API missing" and how to spot pre-existing vs caused failures.
---

The shared test harness (`@/test/testProviders` → `RecordPreviewProvider` →
`ActivityBusProvider`) runs a Dexie/IndexedDB query at mount. Any test that
mounts the harness but does NOT `import "fake-indexeddb/auto"` at the top of the
file crashes the whole render tree with a DexieError `MissingAPIError: IndexedDB
API missing`, surfaced as "The above error occurred in the <RecordPreviewProvider>".

**Why:** vitest has no global setup file and no `environment` default in
`vitest.config.ts`; each test file self-declares `// @vitest-environment jsdom`
and imports `fake-indexeddb/auto` itself. Files lacking that import only pass
when they happen to share a worker process with a file that already set
`globalThis.indexedDB` — so they are inherently order/parallelism-fragile.

**How to apply:** When triaging a broad full-`vitest run` failure, distinguish
*your* breakage from pre-existing fragility: a failing test file that imports
none of the files you changed runs identical code to HEAD, so its failure is
pre-existing. The "IndexedDB API missing" crash family and the copy-button /
metadata-hover-cache / renderSourceNote-diff assertion families are recurring
pre-existing fragilities in this repo, not necessarily caused by your change.
