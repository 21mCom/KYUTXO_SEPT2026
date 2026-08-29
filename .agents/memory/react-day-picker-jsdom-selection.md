---
name: React DayPicker test selection
description: Reliable date-cell selection and nested-popover handling in jsdom and real-browser checks.
---

React DayPicker day cells may not expose a verbose aria-label or date-valued attribute in either jsdom or the real browser. Select from `button[name="day"]`, exclude the `day-outside` class when matching visible day text, and assert the trigger shows the intended formatted date after the click. In browser checks, compare the visible month caption before choosing the day and navigate months when needed.

When the Calendar is a nested Radix popover, closing it and its parent via Escape can leave the parent in its exit animation. Wait until a stable child of the parent popover is detached before clicking the parent trigger again.

**Why:** Calendars render adjacent-month days, so matching only the visible day number can silently select the wrong month. A still-closing parent popover can also make a reopen helper briefly see stale controls and then toggle the trigger closed, causing later locators to time out.

**How to apply:** For tests that drive the shared Calendar, match the caption and a non-outside day, then verify the selected date through the receiving control. After nested calendar interactions, close both popovers and wait for the parent content to detach before reopening it.