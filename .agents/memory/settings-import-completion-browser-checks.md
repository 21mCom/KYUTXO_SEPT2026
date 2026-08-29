---
name: Settings import completion browser checks
description: How to verify entity-list imports after confirmation without racing the settings live query.
---

**Rule:** After confirming a Settings import, wait for the visible source badge and count to show the imported state before asserting completion.

**Why:** The confirm handler can close the preview before the settings live query refreshes, so persistence may already be correct while the page briefly still displays the old bundled state.

**How to apply:** Use condition-based waits for the post-confirmation badge/count, then verify the persisted snapshot or active list.