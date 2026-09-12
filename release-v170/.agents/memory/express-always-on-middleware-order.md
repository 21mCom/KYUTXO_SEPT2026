---
name: Express always-on middleware ordering
description: Response-wide controls (security headers, CORS, etc.) must be registered BEFORE express body parsers, or parser-rejected requests bypass them.
---

**Rule:** Any Express middleware that must affect EVERY response (e.g. `X-Content-Type-Options: nosniff`) must be `app.use`d before `express.json()` / `express.urlencoded()`. When a body parser rejects a malformed body, Express jumps straight to error dispatch and skips all normal middleware registered after the parser — those 4xx error responses go out without the header.

**Why:** A completion code review rejected the error-redaction work because the `nosniff` middleware sat after the parsers; malformed-JSON 400 responses lacked the header despite the "all responses" claim. The global error middleware does not inherit earlier-skipped middleware.

**How to apply:** In `server/app.ts`, register baseline header middleware first, before body parsers. Cover with a regression test that POSTs malformed JSON through the real app and asserts the header (`server/response-hygiene.test.ts` does this). Same ordering logic applies to any future always-on control (auth tokens, rate limits, logging).
