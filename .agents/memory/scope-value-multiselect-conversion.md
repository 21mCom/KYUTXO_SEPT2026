---
name: Scope-value single→multi conversion
description: What breaks when a wallet/seed/owner/tag/category scope Select becomes a multi-select combobox
---

Converting a single-value scope/group Select into a searchable multi-select (e.g. swapping in a shared `MultiSelectCombobox`) is two changes, not one:

1. **State shape**: `scopeValue: string` → `scopeValues: string[]`. Every "no value chosen" gate (disable Scan button, skip auto-recompute effect) must switch from `!scopeValue` to `scopeValues.length === 0`.
2. **Matching semantics in the underlying lib function**: `keys.includes(scopeValue)` becomes OR-matching across the array: `keys.some(k => scopeValues.includes(k))`. This lib function is usually exported and called directly from unit tests (not just through the page) — grep for every direct call site and update the argument from a bare string to a one-element array, or the test breaks on a type/behavior mismatch, not just a UI change.

**Why:** the two lib functions in this codebase that had this shape (`computeDustings` in DustedPage.tsx, `scanAddressPoisoning` in address-poisoning.ts) are both exported and unit-tested directly, so the signature change ripples into test files far from the page component.

**How to apply:** before converting a Select to a multi-select, grep for the lib function name across the repo to find direct test call sites, and grep for the old testid (e.g. `select-scope-value`) in `scripts/check-*.mjs` Playwright browser checks — those interact with Radix `<Select>` via `getByRole('option', ...)`, which does not exist on a Popover+Command-based combobox; they need to open the trigger and click the item's text/`[cmdk-item]` in the list instead.
