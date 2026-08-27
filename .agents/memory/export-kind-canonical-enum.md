---
name: Export-kind canonical enum alignment
description: Pattern for reconciling a page-local kind filter with the app's canonical Record.type enum (address/transaction/other) without losing a narrower bucket the UI still needs (e.g. UTXO refs).
---

The app-wide canonical `Record.type` enum is `'address' | 'transaction' | 'other'` (see `client/src/lib/db-types.ts`). Some pages had grown a 4th ad hoc bucket that doesn't exist at the data-model level — e.g. ExportPage's BIP-329/CSV kind filter had `'utxo'` as a peer of `'transaction'`, even though a UTXO is really just a `'transaction'`-typed record whose `inputString` happens to be an outpoint ref (`recordExportKind()` in `client/src/lib/bip329.ts` already derived this via a regex test).

**Rule:** when aligning such a filter to the canonical enum, don't just delete the narrower bucket. Keep the *dropdown* on the canonical 3 values, and add a **sub-toggle** (checkbox) that only appears/applies when the canonical value it narrows is selected (e.g. "UTXO refs only" shown only when kind === "transaction", overriding the effective filter kind to the narrower internal value at the point it's actually applied). Auto-reset the sub-toggle when the user picks a different canonical value, so it can never silently apply to the wrong bucket later.

**Why:** this preserves a real, previously-supported filtering capability (UTXO-only export scoping) while making the page's primary vocabulary consistent with Dashboard/Records everywhere else — the alternative (keeping a 4th enum value) re-introduces the inconsistency the alignment work was meant to fix.

**How to apply:** if you extend `Bip329ExportFilter.kind` or matching predicates for a new narrower bucket, widen the type union at the boundary function (`matchesExportFilter` in bip329.ts) rather than threading a separate boolean through every call site — the shared predicate already does simple equality on `target.kind`, so a widened union costs nothing at the comparison site.
