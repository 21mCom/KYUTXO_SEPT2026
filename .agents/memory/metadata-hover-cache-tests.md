---
name: metadata-hover cache leaks across test cases
description: Why a component test that renders AddressLink/TxidLink must clear the module-level hover cache between cases.
---

# metadata-hover cache leaks across test cases

`resolveIdentifier` in `client/src/lib/metadata-hover.ts` writes resolved
records into a **module-level** `_cache` (keyed by lowercased identifier) that is
NOT reset by `cleanup()` / `vi.clearAllMocks()`. AddressLink/TxidLink with no
`recordId` seed their initial `tooltipRecord` from `getCachedRecord(...)`, so the
orange FileText indicator can appear *before any hover* if a prior test case
already resolved that same identifier.

**Why:** A test file that renders the SAME component (e.g. UTXODetailPanel, which
mounts both an AddressLink and a TxidLink) across multiple `it` cases will have
case 1 populate the cache and case 2 start with the indicator already showing —
the "hidden until hover" assertion then fails. (The UTXOs row test dodges this by
rendering a different row — group=AddressLink only, utxo=TxidLink only — per case.)

A second, subtler symptom: AddressLink/TxidLink's *no-record click* navigates to
`/records?search=...` (via `openRecordPreviewByAddress`). If an earlier "record
exists" case in the same file already cached that identifier, the later "no record"
case starts with a stale `tooltipRecord`, so the click opens a panel instead of
navigating and the navigation assertion fails. (This is exactly how the
ClickableAddress→AddressLink/TxidLink migration broke `PrivacyAudit.peelList`'s two
nav tests, since the old ClickableAddress never touched this cache.)

**How to apply:** When asserting either the hover-resolves-then-indicator flow OR
the no-record-navigates flow, clear the cache between cases. Use
`clearCachedRecords()` (whole-cache reset, exported from `metadata-hover.ts`) in
`beforeEach`/`afterEach`, or `invalidateCachedRecord(id)` per identifier, or use
unique identifiers per case.
