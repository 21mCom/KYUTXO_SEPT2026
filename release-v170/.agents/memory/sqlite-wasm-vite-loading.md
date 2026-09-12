---
name: sqlite-wasm Vite wasm loading
description: Why @sqlite.org/sqlite-wasm fails to init in Vite dev and how to load the wasm reliably in dev + prod.
---

# sqlite-wasm wasm loading under Vite

A worker that calls `sqlite3InitModule()` from `@sqlite.org/sqlite-wasm` with no
config works in production builds (Vite emits the `.wasm` as an asset) but FAILS
in `npm run dev` with:

```
WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 44 4f
```

`3c 21 44 4f` is ASCII `<!DO` — the dev server answered the `.wasm` request with
`index.html` (the SPA fallback) because the default loader fetched a relative
path the dev server doesn't serve. The compile then chokes on HTML bytes.

**Fix:** resolve the wasm through Vite's `?url` import and feed it via
`locateFile`, so it gets a real served URL in BOTH dev and prod:

```ts
import sqlite3WasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
// the bundled .d.ts types init() as 0-arg; cast to pass the Emscripten config
const initWithConfig = sqlite3InitModule as unknown as (
  cfg?: { locateFile?: (p: string) => string },
) => Promise<Sqlite3Static>;
sqlite3 = await initWithConfig({
  locateFile: (p: string) => (p.endsWith('.wasm') ? sqlite3WasmUrl : p),
});
```

**Why:** Node/vitest finds the wasm in node_modules automatically (so pure-core
unit tests pass and hide this), and prod bundling emits the asset — so the bug
only ever surfaces in the dev server / real browser. Always verify sqlite-wasm
in an actual browser, not just vitest + `npm run build`.

**Persistence note (OPFS SAH Pool):** `navigator.storage.persisted()` returning
`false` (label "Durable storage granted: no") is NOT the same as "data is not
persisted". SAH Pool data survives close/reopen within the origin regardless
(proven empirically by a reopen row-count check). `persisted()` only reflects
the browser's *eviction-proof* durability grant, which test Chromium / a fresh
origin won't grant without user engagement. Electron generally does. Keep the
two concepts (storage MODE vs durability GRANT) separately labeled in any UI.
