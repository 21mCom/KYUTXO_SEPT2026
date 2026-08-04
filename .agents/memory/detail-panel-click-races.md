---
name: Detail-panel click races
description: Async-rendered badges shift layout and steal Playwright coordinate clicks in record detail views
---
In RecordDetailPanel, the conflict-count badge renders asynchronously (after detectSingularFieldConflicts resolves) right next to the Metadata Sources toggle. When it pops in, layout shifts and a Playwright coordinate click aimed at the toggle can land on the badge, navigating to Conflict Resolution.

**Why:** hit this while making the metadata-sources dedup browser check open records via the `/records?id=` deep link — the third (conflict-creating) import intermittently redirected the check to Conflict Resolution.

**Update:** the header conflict badge now renders in a dedicated fixed-min-height slot below the badge row, so its pop-in no longer shifts neighbors. Coordinate clicks in the detail Sheet remain racy anyway: (1) the Metadata Sources toggle contains its own clickable conflicts badge near the button's center, and (2) the Sheet's slide-in CSS transition does not progress between idle headless frames (Playwright boundingBox shows the pre-slide position for seconds), so a coordinate computed early can land mid-slide.

**How to apply:** in browser checks clicking controls in the record detail view, use `locator.dispatchEvent('click')` instead of a coordinate click, and wrap in a retry loop that re-`goto`s the deep link if `page.url()` left the expected page. Also note the deep-link detail view first renders from a direct DB load then remounts when the list load resolves — an expansion clicked just before the swap gets reset, so re-click until the expanded content is actually visible.

**Also: Radix popover options offscreen in headless Chromium.** Popover content can render outside the headless viewport, making a coordinate click retry forever with "element is outside of the viewport". Use `dispatchEvent('click')` on the inner control (e.g. the Checkbox) and assert a state-change testid (selected chip) to confirm the toggle landed.

Related: after heavy client-side scan scenarios on the Transactions page, Playwright's actionability polling can wedge indefinitely — fills hang "waiting for editable", popover children flap attached/detached mid-click. Work around with `dispatchEvent('click'/'mousedown')` (Radix tabs need mousedown) and setting input values via `locator.evaluate` with the native value setter + bubbling 'input' event; and keep proven-green coordinate-click scenarios ordered BEFORE such scan scenarios.
