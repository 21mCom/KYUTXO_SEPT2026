---
name: E2E export-check exactness
description: What code review demands from browser checks that verify copy/export/download features.
---

Rule: a browser check for a copy/CSV/download feature must (1) build ground truth from the rendered rows and compare the clipboard/file contents EXACTLY (order, every row, every cell), and (2) prove sanitization (e.g. CSV formula-sigil apostrophe-prefixing) by feeding hostile values through the live serializer in-page (`page.evaluate` + dynamic import of `/src/lib/...ts`), since benign fixtures never contain sigils.

**Why:** code review rejected a check that asserted only line count/first row/regex shape — duplicated or substituted rows and removed escaping would all still pass.

**How to apply:** any new browser check asserting exported artifacts. Note the apostrophe prefix goes BEFORE leading whitespace (`' =x'` → `"' =x"`), and cells containing quotes get RFC 4180 wrapped after prefixing.
