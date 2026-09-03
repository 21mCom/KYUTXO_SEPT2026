---
name: Verified backup provenance
description: Trust and filesystem-capability rules for local scheduled backup promotion, health, and rotation.
---

An archive is “verified” only when the application has completed semantic restore-preview verification and the main process has recorded provenance that still matches the archive’s capability, filename, size, and live digest. A user-creatable checksum sidecar alone is never proof of verification.

**Why:** A forged or stale archive can be self-consistent with its own sidecar. Treating it as verified can let retention preserve the forged file while deleting the only genuinely verified copy.

**How to apply:** Keep destination paths behind persistent main-process capabilities. Make promotion user-visible only after renderer verification plus main-process reread/ZIP validation, roll back all visible files if provenance persistence fails, and feed Vault Health/rotation only provenance-backed listings.