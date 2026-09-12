---
name: React disabled buttons swallow forced clicks
description: Why handler-level guards behind a disabled button are unreachable in browser checks
---
React's event system checks the component's `props.disabled` at dispatch time — removing the DOM `disabled` attribute and calling `el.click()` (or Playwright `click({force:true})`) still never fires the onClick handler while props say disabled.

**Why:** A browser check tried to reach a handler-level "No file selected" toast behind a disabled Next button; the forced click silently did nothing, making the toast look broken when it was simply unreachable.

**How to apply:** When a wizard gates progress with `disabled={!canProceed()}`, assert the disabled state + that a forced click cannot change the visible step. Don't assert the handler's fallback toast — it's dead defense-in-depth in the real UI.
