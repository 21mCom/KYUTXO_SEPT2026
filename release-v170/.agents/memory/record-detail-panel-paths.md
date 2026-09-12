---
name: RecordDetailPanel render paths
description: The detail panel renders from two independent sources; one rebuilds the record by hand and silently drops fields.
---

# RecordDetailPanel has two independent render paths

`RecordDetailPanel` is mounted in two places:

1. **Records page inline view** (`client/src/pages/Records.tsx`) — passes `selectedRecord`,
   which comes from `convertRecord(dbRecord)` and carries all fields.
2. **Global preview** (`client/src/contexts/RecordPreviewContext.tsx`) — mounted once at app
   root, opened by `openRecordPreview` / `openRecordPreviewByAddress`. **Clicking an
   AddressLink/TxidLink anywhere (including a records-list row) opens THIS one**, not the
   Records.tsx inline view.

**The trap:** the context builds its own `panelRecord: RecordForPanel` by manually copying
~25 fields one-by-one. Any record field NOT listed there is silently absent in the panel,
even though the DB row has it. This caused the behavior badge to read "Not Synced" for a
synced-but-empty address: the builder dropped `statsComputedAt` + `cached*` stats, so
`classifyBehavior({synced: record.statsComputedAt != null})` saw undefined. The records-list
row was correct (it reads the full converted record), only the panel was wrong — a confusing
"same record, two different badges" symptom.

**Why:** manual field projection has no compile-time guarantee it stays in sync with the
`DbRecord` shape; new fields are easy to forget.

**How to apply:** the per-field manual builders are GONE. All three render paths
(RecordPreviewContext's two builders, Records.tsx `convertRecord`, and ClickableAddress)
now go through one spread-based converter `toPanelRecord` in `client/src/lib/recordToPanel.ts`
(returns `PanelRecord = Omit<DbRecord,"id"> & {id:string}`), so any new DB field flows
through automatically — do NOT reintroduce hand-copied field lists. To diagnose "panel shows
stale/missing data", check `toPanelRecord` first. Note: instrumenting Records.tsx
`selectedRecord` will NOT fire when the panel was opened via a link — that path is
RecordPreviewContext.

**Testing note:** KYUTXO has NO service worker (only a manifest link) — stale-bundle is not
the cause here; the Vite dev server serves fresh code. `window.__DIAG`/console probes placed
in the wrong render path simply never fire, which is itself a signal you're on the wrong path.
