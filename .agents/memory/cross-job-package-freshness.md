---
name: Cross-job package freshness
description: How to preserve stale-package protection when a package is built in one CI job and verified in another.
---

For packaged outputs reused across CI jobs, prove freshness with producer-generated hashes bound to the source revision; do not compare filesystem modification times after artifact download.

**Why:** Checkout and artifact ZIP extraction can reset or reorder timestamps, making an exact verified package look stale or making chronology ambiguous. Hash provenance survives transport and also detects changed renderer, asar, or executable bytes.

**How to apply:** Generate provenance only after the producer's normal freshness and package gates pass. Verify revision and all hashes immediately after download, then activate provenance-aware freshness checks only for subsequent reuse steps—not for tests that run before the artifact exists.