---
name: Radix toast vs Playwright strict mode
description: Asserting toast text in real-browser checks trips strict mode
---
Radix/shadcn toasts render their text twice (visible toast + aria-live announcement), so a bare `page.getByText('Toast Title')` waitFor fails silently under Playwright strict mode (the catch swallows the strict-mode violation and looks like "toast never appeared").

**Why:** cost a full browser-check debug cycle — every other assertion passed, only the toast "missed".

**How to apply:** always use `.first()` (or a testid) when asserting toast text in browser checks. Also: to prove a cancel lands mid-stream, gate the cancel click on a streamed phase label (e.g. `/^Analyzing /`), not just any progress text — early manifest phases ("Verifying backup...") fire before any batch streams.
