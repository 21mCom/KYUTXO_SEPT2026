---
name: Failed release tag handling
description: Policy for tags whose release workflow fails before publication.
---

Remove an unpublished version tag when its tag-triggered workflow fails. Do not leave it as a candidate for publication or reuse it without validation; recreate the annotated tag only after the replacement commit passes the complete ordinary and release-specific gates.

**Why:** A successful packaging artifact or ordinary workflow does not prove the tag-triggered release suite, native-power checks, or publication safeguards passed.

**How to apply:** Before recreating the same version tag, confirm there is no Release for the failed tag, delete the failed ref, validate the replacement commit, then create a new annotated tag at that exact commit.