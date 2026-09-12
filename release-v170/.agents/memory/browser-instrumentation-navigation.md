---
name: Browser instrumentation across navigation
description: How real-browser checks retain or lose injected runtime state across navigation.
---

Runtime instrumentation installed with `page.evaluate`, including module monkeypatches and `window` counters, survives client-side Wouter navigation but not `page.goto` or another full document load.

**Why:** A browser check can appear to exercise a stubbed failure after a full navigation while actually reaching the real provider path, making call-count assertions disappear or validate the wrong boundary.

**How to apply:** Keep durable baselines in the Node check process. After every full document navigation, reinstall any page-side service overrides and reset page-local counters before triggering the behavior under test.