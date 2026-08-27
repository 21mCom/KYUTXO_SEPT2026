---
name: Widening a filter field from string to string[]
description: Consumers that hand-replicate filter semantics with === break silently on array values; MultiSelectCombobox popovers stay open after a selection.
---

**Rule:** When a filter option field is widened from `string` to `string | string[]` (e.g. to support multi-select), audit every consumer that re-implements the filter's matching logic independently — not just the primary read path. Test-harness code that hand-replicates SQL/filter semantics with strict `===` (e.g. a browser-check's own "was this row engine-served" proof assertions) silently stops matching once the field carries an array, and the failure looks exactly like a real engine/production regression, not a stale test helper.

**Why:** A widened type still passes `===` for the pre-existing single-value case, so unit tests using single values keep passing; only fixtures that actually exercise multi-select (or a browser-check driving a real UI multi-select) hit the mismatch. Add an array-aware helper (`dimIs(value, target)`: checks `Array.isArray(value) ? value.includes(target) : value === target`) everywhere a consumer compares against the widened field, including test/check scripts.

**MultiSelectCombobox testing gotcha:** the popover intentionally stays open after selecting an option (so the user can pick several without reopening). A test that clicks the trigger button between selections will TOGGLE it closed instead of reopening it, and the next `findByRole('option', ...)` times out looking like a render hang. Select multiple options via successive clicks on the option rows only — never re-click the trigger in between.
