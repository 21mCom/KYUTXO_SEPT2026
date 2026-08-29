---
name: React DayPicker jsdom selection
description: Reliable date-cell selection in jsdom when outside-month days duplicate visible day numbers.
---

In jsdom, React DayPicker day cells may not expose a verbose aria-label or date-valued attribute. Select from `button[name="day"]`, exclude the `day-outside` class when matching visible day text, and assert the trigger shows the intended formatted date after the click.

**Why:** Calendars render adjacent-month days, so matching only the visible day number can silently select the wrong month and produce misleading empty filter results.

**How to apply:** For page tests that drive the shared Calendar, keep fixture dates in the displayed month, reject outside-month cells, and verify the selected date through the control that receives it.