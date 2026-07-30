---
name: vi.mock partial mocks break on circular imports
description: Why an importOriginal-based partial mock of a module in a circular import chain silently binds importers to the REAL export, and how to mock it instead.
---

**Rule:** Never use `vi.mock(path, importOriginal)` partial mocks on a module that sits in a circular import chain (e.g. RecordPreviewContext → RecordDetailPanel → TxidLink → RecordPreviewContext). While the factory awaits `importOriginal()`, the cycle re-enters the module and importers bind to the REAL exports — the mocked hook is simply never called, with no error.

**Why:** A component test spied on `useRecordPreview` via an importOriginal partial mock; the spy showed 0 calls even though the component rendered. Full module mock immediately fixed it.

**How to apply:** For such modules, write a FULL factory mock (no importOriginal) and stub any providers other tests need as passthroughs, e.g. `RecordPreviewProvider: ({children}) => <>{children}</>` so `renderWithProviders` still works. Symptom to recognize: factory logs run, but a log inside the mocked export never fires while the real behavior (e.g. real preview dialog) happens instead.
