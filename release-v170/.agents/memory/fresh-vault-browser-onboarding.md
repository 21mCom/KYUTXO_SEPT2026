---
name: Fresh-vault browser onboarding
description: How real-browser checks should reach the authenticated app shell after creating a fresh vault.
---

Fresh-vault browser checks must not assume that submitting the password form immediately renders the authenticated shell. If the network-privacy source step appears, choose a source, save it, wait for the local import step, and continue to the empty vault before asserting shell controls.

**Why:** The shared unlock helper only owns the lock screen and migration overlay. A later first-run wizard can legitimately sit between unlock and the app shell, making otherwise-correct checks time out on authenticated controls.

**How to apply:** After `unlockIfNeeded` in checks that create a fresh vault, conditionally complete the `network-onboarding-source` and `network-onboarding-import` steps. Existing-vault checks should not force or bypass onboarding.