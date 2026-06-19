---
name: Native SQLite read-engine (Electron worker_thread)
description: Why KYUTXO's at-scale SQL read path is native better-sqlite3 in a worker_thread, not sqlite-wasm/OPFS — and the invariants that keep it safe.
---

# Native SQLite read-engine

For at-scale SQL reads over the vault, KYUTXO uses NATIVE `better-sqlite3` running
in an Electron `worker_thread`, reached from the renderer over a FIXED IPC channel
set (`window.electronAPI.engine.*`). The pure SQL lives in `engine-core.ts` behind
a tiny `EngineDb` driver contract so it can be unit-tested + benchmarked in plain
Node against the same driver. As of this writing the engine is ISOLATED: only the
Engine Diagnostics page uses it; the live app stays on Dexie.

**Why native, not sqlite-wasm/OPFS:** on the real vault (~2.85M records / ~130k
txns / ~13M participants, ~3.2 GiB db) the WASM/OPFS path corrupted around ~6 GiB
and took ~9.5h to seed. The native path does the same full rebuild in ~2.6 min
(bulk load ~44s at ~297k rows/s, indexes+ANALYZE ~54s, `integrity_check` ok ~57s,
reopen ~104ms) with flat RSS. So: when a screen needs at-scale SQL, reach for the
native engine path — do not revive WASM/OPFS for large data.

**How to apply / invariants:**
- DB is a single file on removable media → `journal_mode=TRUNCATE` (NEVER WAL) +
  `temp_store=MEMORY`. WAL leaves sidecar files that break on USB removal.
- Seed is FULL-REBUILD only (state machine EMPTY→LOADING→INDEXING→READY/ERROR);
  there is no partial-resume. Any interruption/cancel must drop the mirror and
  reset `seeding=false` so a fresh seed can always start (cancel path calls
  `clear()`; `seedBegin` force-resets instead of throwing if already seeding).
- Seed is PUSH-based: the RENDERER owns the Dexie source schema, so it does the
  IndexedDB keyset read + Dexie→row mapping and streams already-mapped batches via
  `seedBatch`. The worker only owns the SQLite side. Keep mappers in the renderer.
- Bundle-isolation rule: the renderer may import from the Node worker module
  **type-only** (`import type`). A value import would drag `better-sqlite3` (a
  native addon) into the web bundle and break the vite build. Verify after changes
  that `better-sqlite3` is absent from `dist/public/assets`.
- IPC surface is a closed enum: fixed channel names + a closed set of query names,
  never arbitrary SQL or file paths. The db path is decided in main from dataDir.
- The worker is bundled separately by `scripts/build-native-engine.mjs` (esbuild,
  better-sqlite3 external) to `electron/engine/engine-worker.bundle.cjs`; run its
  `--self-test` in plain Node to exercise the whole protocol without Electron.
- Known slow spots at real scale: the owned-UTXO anti-join count (~7s) and its
  first page (~9s). Flagged for optimization; not a correctness blocker.
