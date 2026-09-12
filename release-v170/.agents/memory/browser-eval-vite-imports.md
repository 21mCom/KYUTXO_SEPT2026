---
name: page.evaluate dynamic imports must be Vite app paths
description: In browser-check scripts, dynamic import() inside page.evaluate resolves only Vite-served app modules ('/src/...ts'), never bare package specifiers.
---

**Rule:** Inside `page.evaluate`, `await import('some-package')` throws "Failed to resolve module specifier" — Vite dev only resolves imports it serves. Import app modules instead (`await import('/src/lib/foo.ts')`); if a check needs a library primitive the app doesn't export, export a small helper from the app lib and call that.

**Why:** Browser checks must exercise the same code the app ships; bare specifiers bypass Vite's transform and fail at runtime only, so the first browser run is where this surfaces.

**How to apply:** Seed via '/src/lib/data/*-crud.ts', verify via '/src/lib/*.ts' helpers. Also: after any late lib edit made to satisfy a check, re-run typecheck before the browser run — a stale pass can hide an undefined identifier that then throws identically in vitest and Chromium.
