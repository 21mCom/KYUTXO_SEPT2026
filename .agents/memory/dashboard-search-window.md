---
name: Dashboard 5,000-record search window
description: Dashboard client-side search/filter runs over a 5,000-row updatedAt window; any vault-wide count or hint must be paired with a vault-wide fetch sharing the same predicate, or the hint and the reveal disagree.
---

`useFilteredRecords(includeBD, undefined)` loads only `DEFAULT_RECORDS_LIMIT` (5,000) most-recently-updated rows when any client-side search/filter is active; all Dashboard searching happens over that window.

**Why:** a vault-wide hidden-tier count (notice) next to a window-only reveal (toggle flip) produced a blank "No records found" dead end on >5k vaults, and once the toggle was flipped the notice was suppressed so re-searching dead-ended until app restart.

**How to apply:** any vault-wide count/hint on the Dashboard must ship with a sibling row-fetch that shares ONE predicate builder (page level) and ONE scan implementation (data level, e.g. `scanHiddenTierMatches` behind `countHiddenTierMatches`/`getHiddenTierMatches`), union the rows into the filtered pipeline deduped by id, and re-run whenever search/filters change while the toggle is on — never rely on the loaded window to contain the matches.
