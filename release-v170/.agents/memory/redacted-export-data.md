---
name: Redacted export data
description: Security rule for building selectable, redacted exports and their human-readable reports.
---

Apply redaction to the structured data model before creating **any** serialized artifact or report. The transform must recurse through nested objects and arrays, and mask derived/duplicated identifiers alongside canonical fields.

**Why:** A shallow field-by-field redaction can leave equivalent data in lowercased identifier indexes, nested vault metadata, or selectively disclosed address arrays. If the HTML report and JSON are built from different models, one can also silently leak values the other hides.

**How to apply:** Build package JSON and HTML from one redacted selection object. Test each redaction option against every package artifact with nested and duplicate representations, and ensure cancellation never reaches the download step.