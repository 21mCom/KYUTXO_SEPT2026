---
name: Retryable React lazy imports
description: How to make rejected React lazy route downloads explicitly retryable.
---

Create the initial `lazy(importer)` component outside the rendering component. After an error boundary commits, a Retry action can store a newly created lazy component identity and remount the boundary.

**Why:** Hook state and memo values created beneath an uncommitted Suspense render may be discarded and recreated. Creating the lazy identity there can trigger unintended import attempts, while reusing one rejected lazy identity can only replay React's cached rejection.

**How to apply:** For retryable code-split routes, keep the first lazy identity in the wrapper factory and create each subsequent identity only in the committed retry event.