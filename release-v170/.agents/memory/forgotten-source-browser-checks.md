---
name: Forgotten-source browser checks
description: Non-obvious browser harness behavior when proving forgotten network-source persistence and desktop-only controls.
---

After Forget source, reopening an existing vault intentionally returns to the network-source onboarding step. Assert that setup-required step first, then choose “stay offline” before navigating back to Node Settings to inspect retained connection details and disabled controls.

**Why:** Expecting the Node Settings offline alert immediately after reopen misreads the intended onboarding redirect. Also, installing an Electron bridge before reload selects packaged protected storage rather than the browser-backed vault, so its persisted settings appear to vanish.

**How to apply:** For browser-backed persistence checks, reopen without an Electron bridge, verify the source onboarding state, complete the offline choice, and reopen Node Settings. If desktop-only controls must be inspected, inject an `isElectron: true` bridge only after the browser vault is open and trigger a React rerender without reloading.