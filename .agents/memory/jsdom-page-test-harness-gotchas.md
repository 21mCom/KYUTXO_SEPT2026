---
name: jsdom page-test harness gotchas
description: Repo-specific pitfalls when writing new component/page vitest files (environment, cleanup, matchers, partial mocks).
---

Rules for new `.test.tsx` files in this repo:

- Add `// @vitest-environment jsdom` at the top — the default vitest environment is node, so `render` fails with "document is not defined".
- Testing-library auto-cleanup is NOT enabled; call `cleanup()` in `beforeEach` or repeated renders produce "multiple elements found" errors across tests.
- jest-dom matchers (`toBeDisabled`, `toBeInTheDocument`, …) are not registered — "Invalid Chai property". Assert plain DOM properties (`(el as HTMLButtonElement).disabled`).
- Wholesale `vi.mock` of widely-imported modules (`@/lib/blockchain-api`, `@/lib/bitcoin`) breaks the shared provider harness (transaction-sync → RecordDetailPanel import chain). Use `importOriginal` and override only the named exports the test needs.

**Why:** each of these failed loudly with misleading errors while adding AddressChecker component tests (July 2026).
**How to apply:** any new component/page test rendered via `renderWithProviders`.
