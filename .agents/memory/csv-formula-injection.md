---
name: CSV formula-injection sanitization
description: Any user-facing CSV export must neutralize spreadsheet formula sigils or completion code review rejects it.
---

**Rule:** Every CSV export cell built from user/import-controlled text must be apostrophe-prefixed when it begins (even after leading whitespace) with `=`, `+`, `-`, `@`, tab, or CR — before RFC 4180 quoting. Cells serialized from real numbers stay unprefixed (prefixing corrupts negatives).

**Why:** Completion code review rejected a new CSV export whose escaping was RFC-4180-only; opening the file in Excel/Sheets could execute attacker-supplied formulas.

**How to apply:** Reuse the `csvField`/`csvSanitizeCell` helpers in the records CSV export module for any new CSV surface instead of writing ad-hoc escaping; add a hostile-cells test covering every string column.
