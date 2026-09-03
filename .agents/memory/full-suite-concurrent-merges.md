---
name: Full-suite validation under concurrent merges
description: How to interpret and repair failures when a long serial validation run overlaps other task merges.
---

Treat a long serial full-suite run as a moving target when other task branches are merging into the same workspace. Repair failures that reproduce in a focused run, but do not weaken assertions for a one-off failure that immediately passes unchanged in isolation.

**Why:** A serial suite can take tens of minutes. During that window, newly merged production behavior can invalidate a test file that the run has not loaded yet, while shared test-state timing can also produce a non-reproducible failure. Blindly editing every observed failure risks encoding a race rather than restoring trustworthy coverage.

**How to apply:** Stop after a failure, run the exact file alone, and inspect recent workspace changes. For reproducible failures, align stale mocks and deterministic environment gaps with current production behavior while preserving the asserted outcome. For non-reproducible failures, record the focused pass and rerun without changing assertions.