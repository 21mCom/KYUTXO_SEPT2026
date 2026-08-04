---
name: Browser-testing the native engine read path
description: How to exercise engine-served reads (evaluateEngineFreshness → engine queries) in a headless-Chromium browser check, where the real Electron engine doesn't exist.
---

The native SQLite read-engine exists only in Electron (`isEngineAvailable()` = `!!window.electronAPI?.engine`), so ordinary browser checks always exercise the Dexie fallback. To test the engine-served path in a real browser, inject a minimal engine bridge via `context.addInitScript` that:

- defines ONLY `window.electronAPI = { engine }` — deliberately **no `isElectron: true` flag**, so `isElectron()` stays false and no other desktop-only code path activates;
- stays inert until the page sets a `localStorage` enable flag (arm it AFTER vault creation/seeding, then reload), so the first session runs as a plain browser;
- reports `status` READY, echoes the app's own `ENGINE_SCHEMA_VERSION` (stamp it into localStorage from a page-side import of engine-core — the init script can't import app modules);
- answers `getRecordsFingerprint` / `getRecordPageByUpdatedAt` straight from the live IndexedDB (index `'updatedAt'` cursor `'prev'` gives updatedAt DESC, id DESC — the engine's order), so the mirror is fingerprint-fresh by construction and the REAL `evaluateEngineFreshness` gate elects it;
- returns `{ ok:false, error }` envelopes for unimplemented queries — production treats that as engine failure → Dexie fallback, safe;
- accepts seedBegin/seedBatch/seedFinish as no-ops so an incidental `seedAll` can't wedge;
- instruments itself (`window.__engineMock.pageCalls` with opts + returned ids) so the check can PROVE reads were engine-served and which rows each window contained.

**Why:** the hidden-matches reveal task required proving Dashboard behavior when the engine (not Dexie) serves the records window; this was the only way in a browser check. See `scripts/check-dashboard-hidden-matches-engine-browser.mjs` for the working recipe.

**How to apply:** reuse for any browser check that must cover an `evaluateEngineFreshness(...)` → `engine*` fast path (Records, Transactions, UTXOs) instead of only the Dexie fallback.

**Transactions scope (2026-08-04):** the bridge also serves the tx list — implement `getTransactionsFingerprint` {count,maxId,maxBlockTime}, `getParticipantsFingerprint` {count,maxId,resolvedPrevoutCount}, `countTransactions`, `getTransactionPage` (entity dims AND-compose as per-dimension txid-set intersections, each satisfiable by a different participant; curatedOnly = linked record type='address' + OWNED_TIERS; order COALESCE(blockTime,0) DESC, id DESC with keyset cursor). Equivalence proof pattern: run the same filter walkthrough twice in one context — phase A bridge inert (Dexie), phase B bridge armed — and compare totals + ordered card testids. Avoid trailing "reset" fills at the end of a walkthrough (a lingering popover focus trap can hang locator.fill); start each phase from a fresh navigation instead. See scripts/check-transactions-entity-filter-engine-browser.mjs.
