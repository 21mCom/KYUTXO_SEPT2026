---
name: Windows Electron runtime compatibility
description: Why the Windows desktop runtime must remain on the proven Electron line until the real renderer is launched in CI.
---

The Windows portable app must stay on the last runtime line proven to render the application, while replacing vulnerable installer internals independently rather than accepting a broad runtime jump.

**Why:** A security-motivated Electron 39-to-43 upgrade passed dependency, build, and packaged native-engine checks but produced a blank window even with a fresh portable profile. The migration and legacy-vault paths remained healthy in Chromium, proving the failure was packaged-runtime-specific.

**How to apply:** Treat any Electron major upgrade as blocked until the Windows workflow launches the actual packaged executable with an isolated profile and confirms the login/setup UI renders. Keep the hardened ZIP extractor compatibility layer when using Electron 39; never restore the vulnerable legacy extractor.