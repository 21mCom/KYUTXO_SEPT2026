---
name: Runner alert recovery evidence
description: Fail-closed recovery rule for alerts raised when a self-hosted runner leaves work queued.
---

An offline-runner alert may close only after a newer probe for the exact runner
label completes successfully. Cancellation, queue expiry, failure, or the
absence of active queued work is not recovery evidence.

**Why:** A stuck workflow can disappear from queued/in-progress API results
without the runner ever returning. Treating disappearance as recovery silently
removes the only outage notification.

**How to apply:** Track positive, label-specific completion evidence newer than
the alert. Keep the alert open for cancelled, failed, missing, or older probes.