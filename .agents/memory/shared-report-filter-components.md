---
name: Shared report date/address filters
description: DateRangeFilter and SearchableEntityPicker are the reusable controls for scoping report/analysis pages by date or by address/entity — reuse their prop API and testid conventions instead of building a page-specific variant.
---

## DateRangeFilter (`client/src/components/DateRangeFilter.tsx`)

- Modes: `"any" | "range" | "exact"`. Value shape: `{ mode, from?, to?, date? }` (yyyy-MM-dd strings).
- `ANY_DATE_RANGE_FILTER` is the default "no scoping" value.
- `dateRangeFilterToUnixRange(value)` converts to inclusive Unix-**second** bounds (`{ start?, end? }` or `undefined` for "any") — matches `blockTime` convention used across the app's blockchain tables.
- `isDateRangeFilterActive(value)` for "is a filter currently narrowing the view" checks (e.g. to decide whether to show a "Clear" affordance or count as an active filter).
- The component itself renders **native `<input type="date">` From/To fields, always visible** (no Calendar/Popover), plus an "Exact date" checkbox that collapses them to one field. This shape was chosen deliberately during the original build to keep `fireEvent.change` on plain date inputs working across a large pre-existing test suite (FundTrail) — don't redesign it back to a calendar without checking how many tests assume native inputs.
- Testids: `input-${testId}-from`, `input-${testId}-to`, `input-${testId}-date` (exact mode), `checkbox-${testId}-exact`, `button-${testId}-clear`, `text-${testId}-summary`, `label-${testId}`.
- For pages whose exportable/report rows don't carry a `blockTime` (e.g. plain address/other records), fall back to `record.updatedAt ?? record.createdAt` (ms) — document that choice at the call site since it's an approximation, not a strict block-time scope.

## SearchableEntityPicker (`client/src/components/SearchableEntityPicker.tsx`)

- Discriminated union: `multiple={true}` → `value: string[]`/`onChange: (string[]) => void` (chips, bulk paste, Enter-to-commit, `validateFreeText` enforced on commit). Omit `multiple` → `value: string`/`onChange: (string) => void` (single-select; **onChange fires per-keystroke like a plain input, no commit gating** — `validateFreeText` is NOT enforced in single mode, pair it with your own validation state if you need one).
- `options: EntityPickerOption[]` = `{ value, label?, sublabel?, badge?, searchText? }`; `allowFreeText` permits values outside `options`.
- Testids: `input-${testId}` (the text field — what tests should `fireEvent.change` on), `button-${testId}-open` (popover), `input-${testId}-search` (in-popover search), `${testId}-option-${value}`, multi-only: `${testId}-selected`, `${testId}-chip`, `${testId}-remove`.
- Restricted single-select (no free text, pick-from-list-only, e.g. an owner/wallet secondary filter) still accepts `fireEvent.change` directly in tests even though free text is logically "not allowed" — the restriction only gates the multi-select commit path, not single mode's onChange.

## Where these are used (as of the report-filter standardization work)

StatementReport, FundTrail, AnnualActivityReport, NetworkAnalysis (address/entity picker + date range where relevant); ExportPage and UtxoProvenance got DateRangeFilter only. Provenance's own command-picker was the *inspiration* for SearchableEntityPicker but was intentionally left untouched (it's the reference pattern, already good). WalletOverview/UtxoProvenance/NetworkAnalysis/Provenance deliberately do NOT get a new "include discovered addresses" toggle — each already has an equivalent mechanism or is curated-only by design.
