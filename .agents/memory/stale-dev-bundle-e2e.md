---
name: Stale dev-bundle e2e false failures
description: Why an e2e (testing skill / Playwright) failure can be a stale Vite/PWA bundle, not a source bug, and how to confirm.
---

When an e2e test via the testing skill fails on a behavior that unit tests AND
careful code reading both prove correct, suspect a **stale dev bundle** before
concluding there is a source defect.

**Why:** This repo is an offline-first PWA served by the Vite dev server. The
running dev server can hold a stale module graph (or a service-worker-cached
bundle) so the browser executes pre-fix JS even though the source on disk is
already fixed. Reproduced concretely with the Skipped-Addresses dismiss flow:
e2e showed "dismiss one row clears the whole card", but the data-layer unit
tests (sync-protection-crud) passed, the Dexie path was provably correct, and
`db` is a plain Dexie subclass with no hooks/middleware/encryption. The instant
a source file was edited (which forces Vite to fully reload), the exact same
e2e passed — dismiss-one left the other row intact, dismiss-all/blacklist/retry
all worked.

**How to apply:** If e2e contradicts green unit tests + clean code review,
make a trivial edit to the relevant source file (or restart the "Start
application" workflow) to force a fresh build, then re-run the e2e before
spending time hunting a non-existent bug. Each testing-skill run uses a fresh
browser context, so a fresh context alone does NOT guarantee a fresh bundle —
the dev server itself must rebuild.

**Same trap, different tool — the `typecheck` workflow:** the registered
`typecheck` validation step (`npm run check` = `tsc`) can report a phantom
failure citing code you ALREADY deleted (e.g. errors on a just-removed block)
right after an edit, due to a stale incremental `tsconfig.tsbuildinfo` /
snapshot. Ground truth = a fresh local run: `rm -f tsconfig.tsbuildinfo && npx
tsc`. If that's EXIT 0 and the file content confirms the fix, the workflow log
is stale — re-trigger it rather than "fixing" already-correct code.
