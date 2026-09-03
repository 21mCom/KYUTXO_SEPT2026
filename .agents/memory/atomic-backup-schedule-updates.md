---
name: Atomic backup schedule updates
description: Why every backup policy, status, drill, and capacity-history update must merge atomically.
---

All writers to scheduled-backup state must merge only their intended fields against the current settings row inside one read-modify-write transaction. Retained destination state is keyed by opaque capability token; successful backup status updates preserve capacity history while clearing only the resolved failure fields.

**Why:** Desktop health checks, scheduled backup completion/failure, restore drills, and settings edits can overlap. Reading settings and later replacing the whole schedule silently loses newer histories, failures, or verification status.

**How to apply:** Route new backup-schedule mutations through the atomic settings mutator. Policy edits preserve state for retained capability tokens and discard state for destinations the user removes.