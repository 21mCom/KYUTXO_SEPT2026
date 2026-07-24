---
name: PoF PDF builder structure
description: How the Proof of Funds PDF generator is organized and sample-mode invariants
---

The Proof of Funds PDF is built by per-section modules (`pof-pdf-section-*.ts` under `client/src/pages/proof-of-funds/`) driven by a shared `PdfLayout` (mutable `y` cursor + addLine/addWrapped/checkPageBreak) and a precomputed `PofPdfData` from `computePofPdfData(params, isSample)`.

**Rules to preserve:**
- Sample and real paths share the SAME section order and gates; sample differs only in data (fictitious constants), the SPECIMEN watermark/footer, a placeholder fingerprint label (never a 64-hex hash), and skipping DB/AML lookups and evidence exhibits.
- Any change to what a section renders that materially affects the document must also update the canonical payload in `pof-pdf-data.ts`, or the printed fingerprint preimage no longer covers it.
- Sample AML needs explicit placeholder SOW/SOF strings; sample inline amlResult needs full EntityListDescriptionInput fields (entityListSource etc.).

**Why:** browser guards (sample-pdf, pof-empty-exclusion) assert watermark-on-every-page, no-real-fingerprint-in-specimen, and empty-address exclusion across all optional sections.

**Pre-existing failing suites:** proof-of-funds mixed-format-pdf, bip322-pdf, single-format-pdf, and bc1q-bip322-e2e vitest suites fail identically on the pre-refactor monolith (verified by swapping the original file back in). Root cause: FakeJsPDF mocks lack `internal.getNumberOfPages`, so generation aborts before the appendix rows. Don't treat these as refactor regressions; fix belongs in the test mocks.
