---
name: GitHub Actions dispatch input safety
description: Security and cleanup rules for manually dispatched workflow contract fixtures.
---

Treat every `workflow_dispatch` input as untrusted even when its declared type is
`choice`. Pass values to shell steps through `env` and validate them against an
explicit allowlist before use; never interpolate an input directly into a shell
program.

**Why:** Choice options constrain the Actions UI but do not validate direct API
dispatches. Direct interpolation can turn a maintenance workflow into a command
injection path.

**How to apply:** For workflows that dispatch disposable child runs, also
correlate children with a unique run ID and rediscover unfinished children
during `finally` cleanup. Do not rely only on the first post-dispatch lookup,
because dispatch can succeed before that lookup fails.