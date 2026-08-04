---
name: Optional Record fields in real vaults
description: Real vault rows can lack label/tags/notes entirely; jsdom fixtures that always populate them hide browser-only crashes.
---

**Rule:** Record rows created via createRecord spread the input as-is — a record made without `tags`/`notes`/`label` has those fields UNDEFINED in IndexedDB, not defaulted. Any UI reading `record.tags.length`, `record.label.trim()`, etc. must null-coalesce.

**Why:** The Database Doctor Resolve-duplicate dialog passed all jsdom tests (fixtures always set tags/label) but crashed instantly in a real browser vault ("Cannot read properties of undefined (reading 'length')") because the seeded keeper had no tags field.

**How to apply:** When writing components or tests over VaultRecord metadata, include at least one fixture/seed row that omits optional fields; in browser checks, seed via the real CRUD layer (which reproduces the sparse shape) rather than hand-built full objects.
