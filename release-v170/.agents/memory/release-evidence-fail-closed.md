---
name: Release evidence fail-closed
description: Why release workflows must verify retained gate evidence again at the publishing boundary.
---

Treat retained release evidence as a required publish input: require every expected target-specific file and revalidate its success summary immediately before creating the release.

**Why:** A producer matrix can pass while artifact matching or download later yields no files; release actions may also tolerate unmatched globs. Depending only on job status can therefore publish without the promised evidence.

**How to apply:** For release gates that upload logs or reports, make producers fail on command and log-writer errors, then make the publishing job assert the exact file set and report contents before invoking the release action.