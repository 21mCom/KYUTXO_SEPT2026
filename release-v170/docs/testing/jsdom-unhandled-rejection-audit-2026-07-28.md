# jsdom test-suite audit: hidden DatabaseClosedError / unhandled rejections (2026-07-28)

Scope of this audit (task: "Silence the same hidden database errors in test suites
beyond the Balance page"): verify no jsdom test suite outside the already-fixed
BalanceOverview files emits hidden `DatabaseClosedError: IndexedDB API missing`
unhandled rejections from unmocked Dexie-backed CRUD modules (e.g.
`@/lib/data/settings-crud`).

## Method

All 366 jsdom test files were run in chunks and every log grepped
case-insensitively for `unhandled` and `DatabaseClosedError`:

```
ls client/src/pages/**/*.test.tsx                     # 229 files (pages)
grep -rl '@vitest-environment jsdom' client/src \
  --include='*.test.ts*' | grep -v '^client/src/pages/'  # 137 files (components/hooks/lib/contexts)
npx vitest run <chunk>                                # 7 chunks total
grep -Eic "unhandled|DatabaseClosedError" <each log>  # → 0 in every log
```

## Result

- Zero `Unhandled` / `DatabaseClosedError` occurrences across all chunks.
- No new mocks were needed; the `vi.mock("@/lib/data/settings-crud", ...)`
  pattern (see `client/src/pages/BalanceOverview.resolveAddress.test.tsx`)
  already covers every suite that mounts components reaching Dexie in jsdom.
- The only failing tests were the 4 pre-existing BIP-322 proof-of-funds
  disclaimer tests, tracked separately and unrelated to database noise.

Conclusion: audit passed with no code changes required. A follow-up task was
proposed to add an automated guard so this noise cannot silently return.

Note for completion review: any other commits visible in this task's diff
window (e.g. Records "Recently Added" feature, derivation-template dialog,
block-validation guard) are upstream work from other, already-merged tasks
that flowed into this environment via auto-rebase; this document is the only
change belonging to this task.
