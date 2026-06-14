---
name: Build-time false alarms
description: Signals in the KYUTXO build/dev loop that look like regressions but are pre-existing/transient — don't chase them.
---

# Build-time false alarms

## `tsc --noEmit` has a pre-existing error baseline
Running `npx tsc --noEmit` reports ~20 errors in code unrelated to most changes. Root causes:
- The app's own Bitcoin `Record` type (from the schema) shadows TypeScript's global `Record<K,V>`, so any `Record<string, unknown>` usage errors with "Type 'Record' is not generic" (e.g. in `database.ts`, `legacy-decrypt.ts`).
- `getTableConfigs()` in `client/src/lib/legacy-decrypt.ts` types its return as `TableConfig<LegacyRecord<UnionOfManyTypes>>`; `keyof (A | B)` collapses to the intersection of keys, so the `sensitiveFields` casts error.

**Why:** Vite/esbuild transpiles without type-checking, so these never block `npm run dev` or the build. They are a long-standing baseline.
**How to apply:** After a change, scope tsc to the files you edited (`rg "yourfile" tsc_out`) to decide if *you* introduced anything. Do not "fix" the baseline errors as part of an unrelated task — it risks behavior changes and is out of scope.

## Editing `AuthContext.tsx` throws phantom errors during Fast Refresh
`client/src/contexts/AuthContext.tsx` exports both the `AuthProvider` component and the `useAuth` hook. Vite React Fast Refresh cannot cleanly hot-update such a file, so live edits produce transient console errors: `[vite] ... Could not Fast Refresh ("useAuth" export is incompatible)`, "Invalid hook call", and "useAuth must be used within an AuthProvider".

**Why:** These are HMR transition artifacts, not runtime bugs — a full page reload clears them, and the app loads fine.
**How to apply:** After editing AuthContext, restart the workflow / do a full reload and re-check the console before concluding there's a real bug.
