---
name: db-error-noise vitest guard
description: Global vitest setup hook fails tests on hidden Dexie errors; what trips it and how tests must respond.
---
A global vitest setupFile (wired in vitest.config.ts, guarded by a canary-running check script + validation workflow) fails any test that leaks:
- an unhandled promise rejection (process-level), or
- console.error/warn output matching DatabaseClosedError / Dexie unhandled-rejection / "indexedDB API missing".

**Why:** unmocked Dexie CRUD calls from mounted components (e.g. getSettings) reject fire-and-forget in jsdom; the noise used to be non-fatal and masked real failures.

**How to apply:** if a new test fails with `[db-error-noise]`, mock the CRUD module (see BalanceOverview.resolveAddress.test.tsx pattern) or explicitly await/handle the rejection — don't loosen the hook. Rejection detection is macrotask-delayed; the hook flushes a setTimeout(0) in afterEach/afterAll. The guard script self-tests by writing a temp canary test into client/src/test/ and expecting vitest to fail it.
