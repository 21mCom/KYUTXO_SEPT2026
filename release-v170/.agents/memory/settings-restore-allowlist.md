---
name: Settings restore allow-list
description: Why the settings table is not wholesale restored, and how to make a settings preference round-trip through backup.
---

The `settings` table is intentionally NOT cleared and NOT wholesale restored on
backup restore (both the v3 streaming path and the legacy JSON path). Device-local
preferences (theme, column layout, etc.) must survive a restore in place.

**Why:** A restore should not clobber the *current* device's UI/layout settings
with whatever the backup happened to capture. But genuinely *portable* user
preferences (ones that should follow the user across devices) need to round-trip.

**How to apply:** Portable preferences are merged via an explicit allow-list in
`restoreSettingsPreferences` (`client/src/lib/backup/inline-tables.ts`). To make a
new settings field round-trip:
- add it to the `updates` allow-list in `restoreSettingsPreferences` (type-check
  the field before applying so a missing field on older backups is left at its
  current/default value — never blindly spread the backup row).
- it is already exported (whole `settings` row rides inline in the v3 manifest).
- both restore paths call this one shared helper, so do not duplicate field logic
  in `SettingsPage.tsx`; just call the helper.

First field handled this way: `disableOrphanCheck` (the startup missing-data
reminder toggle).
