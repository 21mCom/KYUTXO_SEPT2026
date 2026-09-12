---
name: Portable-pref preview/restore parity
description: How backup portable-preference preview and restore stay in sync, and why preview must run before any destructive work.
---

Backup restore merges a small allow-list of portable preferences into current
settings (orphan-check toggle, cancel-confirm threshold, privacy history limit,
entity-list snapshot). The rest of the settings table is device-local and never
restored.

**Rule:** the pre-restore preview and the actual restore must be driven by the
SAME single source of truth (a PORTABLE_PREFERENCES descriptor list in
`client/src/lib/backup/inline-tables.ts`: key + label + extract + format +
validity check). `previewSettingsPreferences(rows)` and
`restoreSettingsPreferences` both iterate it, so a field that previews as "from
backup" is exactly the field that gets applied. If you add/remove a portable
pref, change only the descriptor list.

**Why:** users could not see which prefs a backup would silently overwrite; and
two parallel hand-maintained lists drift. Validity rules matter — only finite
numbers, booleans, and non-empty well-formed entity-list snapshots count as
"from backup"; everything else is "kept (this device)".

**Test parity:** two runtime suites hard-code the descriptor list and fail on
any new pref until updated: the preview suite's `KEYS` array
(settings-preferences-preview.runtime.test.ts) and the parity suite's
`formatDeviceValue` switch PLUS its "applies every pref" backupRow, which must
carry a usable value for EVERY key (settings-preferences-preview-parity
.runtime.test.ts). The SettingsPage preview page-tests assert subsets only and
survive additions.

**How to apply:** in the restore dialog, peek the manifest and (for v3) derive
the key + parseInline to compute the preview BEFORE clearing the vault. This
doubles as the wrong-password check: a bad password fails at parseInline,
non-destructively, instead of after the vault is already wiped. Legacy (pre-v3)
backups currently skip the preview.
