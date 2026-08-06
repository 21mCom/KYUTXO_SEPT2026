---
name: CDP CPU throttling for fast-op browser checks
description: Making fast streaming operations observable (progress/cancel) in real-browser checks
---

When a streaming/chunked operation is too fast in headless Chromium to observe its progress UI or to cancel mid-run, do NOT keep inflating the seed data (seeding cost dominates the check). Instead:

- Enable `Emulation.setCPUThrottlingRate` via a CDP session just before the run (6–8x ≈ weak laptop), reset to 1 after. This is also more representative of the machines the yield cadence protects.
- **Warm re-runs are much faster than the first run** (JIT + caches): a cancel that worked timed against the first run will race completion on the second. Click cancel the instant the running stage renders, use `dispatchEvent('click')` (no actionability retries straddling completion), and retry with escalating throttle rates (e.g. 8/14/20) if results appear before the cancel lands.
- For progress evidence, don't rely on Node-side polling round-trips (they miss fast transitions); install an in-page MutationObserver on the progress element and read the frame log after completion.
- Hand large in-page Blobs to file inputs via DataTransfer + change event so multi-MB buffers never cross the CDP wire.

**Why:** backup-compare scale check: 12k records/15k tx/30k participants compared in ~1s unthrottled — zero progress samples and un-cancellable.
