---
name: Records page deferred counts
description: Why the Records page must fetch+render the first page before starting any count query, and how superseded loads must avoid spawning count work.
---

# Records page: defer counts until after the first page renders

The Records list load fetches one page of rows AND needs several counts (grand
total, per-type total, hidden blockchain-discovered count for the badge). Those
counts must NEVER be started before the page rows are fetched and handed to
`setRecords` for the *winning* load version.

## The rule
- Start every count ONLY after `setRecords(...)` runs for the current version —
  i.e. after the `if (loadVersionRef.current !== version) return;` guard that
  precedes render. A load superseded before render returns early and starts NO
  count work.
- Coalesce counts into one pass per winning load (e.g. one
  `Promise.all([total, blockchainCount])` that derives both the visible total and
  the badge) so the same count never runs twice.
- Guard every count *setter* with `loadVersionRef.current === version` so a slow
  count from a stale version can't overwrite fresh state.

## Why (re-learned twice)
- **Awaiting** a count before the page fetch left the page permanently stuck on
  "Loading records…" on huge vaults: the count was slow, a record write arrived
  mid-count and superseded the load, which restarted and counted again, so
  `setRecords` was never reached and `isLoading` never cleared.
- Even un-awaited, **starting** counts before the row fetch puts expensive count
  queries on the IndexedDB thread ahead of the critical fetch, and every
  superseded load spawns uncancellable counts — amplifying DB pressure during
  reload storms on large vaults.

## How to apply
- Any new count/aggregate the Records load needs goes into the post-render
  deferred-count routine, never inline before the fetch.
- Never log the raw search text in diagnostics (it can be an address/txid) — log
  its length only.
