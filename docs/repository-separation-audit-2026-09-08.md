# Repository separation audit — 2026-09-08

## Scope and evidence

This audit compared the complete reachable local history with every branch and
tag reported by both GitHub repositories. It also inspected the repositories'
available Actions workflows, workflow runs, downloadable artifacts, releases,
and repository event feeds through the GitHub API.

GitHub's repository event feed and Actions listings are retention-limited. The
commit, branch, tag, and release comparisons are not dependent on that feed.

## Proven boundary

- Last legitimate shared commit: `36d59cabec5042fd6649d56b744ae4eca60b85a7`
  (`2026-09-03T12:08:49Z`, “Gate desktop releases on native power smoke runners”).
- First September-only commit: `4cb190bed5b90ee16fc84bcb51477d9395dd34b5`
  (`2026-09-03T12:50:30Z`, “Stage tested SQLCipher protected-storage foundation
  and typed Electron IPC”).
- The September repository was created with `main` at that first September-only
  commit on `2026-09-03T13:07:19Z`.
- Git ancestry proves the September repository's existing `main` is an ancestor
  of the current local `main`.

This boundary is based on ancestry and the independently created September
repository, not on a guessed date. June commits and releases through
`v1.1.46` (`45ee1489416af8463a9663005b56ac74e6b21fbe`, published
`2026-09-02T14:15:11Z`) predate the boundary and remain classified as legitimate
June history.

## Chronological impact

### 2026-09-03 — intended September delivery

The September repository received `main` at `4cb190b`. Its push and two manual
workflow runs were cancelled, but six downloadable package artifacts were
created there. These are correctly located and are not June contamination.

### 2026-09-08 — mistaken June delivery

At `2026-09-08T06:24:06Z`, June `main` moved from
`f2b7ec76fd21905fce0dcfe5d133feaa530df614` to
`19f961b7bf91e35fdc814d6a002c0e300a897e55`.

That update introduced the complete September range:

```text
4cb190bed5b90ee16fc84bcb51477d9395dd34b5^..19f961b7bf91e35fdc814d6a002c0e300a897e55
```

The range contains **159 commits**, beginning with the first September-only
commit and ending with “Keep fast-index streaming responsive with cooperative
batches.” The exact chronological list is reproducible with:

```sh
git log --reverse --format='%H %aI %s' \
  4cb190bed5b90ee16fc84bcb51477d9395dd34b5^..19f961b7bf91e35fdc814d6a002c0e300a897e55
```

GitHub started June workflow run `34194497449` for that mistaken `main` update.
That run and every artifact it produces are September-project material in the
June repository. At the audit snapshot the run had not reached a conclusion and
the API reported no associated artifacts yet; its final run page is therefore
the authoritative boundary for any late-created downloadable artifacts.

No June branch other than `main` points into the September-only line. The
existing `task-1848-native-engine-ci` branch is outside that line.

No June tag points at or descends from `4cb190b`. Therefore none of June's 35
tags is classified as September contamination.

No June release targets a September-only commit. Therefore none of June's 35
releases or their attached Portable executables is classified as September
contamination.

## Current separation

- Normal fetch/push destination: `21mCom/KYUTXO_SEPT2026`.
- June is retained only as a comparison remote with an explicitly disabled push
  URL.
- Local and Actions guards reject package, release, and ordinary hook-checked
  pushes unless the destination is exactly `21mCom/KYUTXO_SEPT2026`.
- No June ref, tag, release, workflow run, or artifact was changed by this audit.

## June cleanup choices

Choose one exact option before any June mutation:

1. **Non-destructive corrective commit (preferred for shared history).**
   Revert the net tree change introduced by the mistaken September range on top
   of current June `main`, preserving the audit trail. Existing commit objects
   and the affected workflow run remain visible. This is safest for existing
   clones, but requires confirming the intended June tree before creating the
   corrective commit.
2. **Restore June `main` with history rewriting.**
   Force-update June `main` to the verified pre-mistake commit
   `f2b7ec76fd21905fce0dcfe5d133feaa530df614`. This removes the mistaken range
   from the branch's reachable history but disrupts clones and open work, and
   commit objects may remain recoverable on GitHub for a time.
3. **Leave June history unchanged and label the incident.**
   Preserve the current branch and add repository documentation explaining that
   the September range is not a June release line. This avoids disruption but
   does not restore product separation in June's source tree.

For the affected workflow run and any late-created artifacts, cleanup is a
separate choice: retain them as audit evidence, or explicitly delete run
`34194497449` after recording its final conclusion and artifact inventory.
Deleting the run removes its logs and downloadable Actions artifacts; it does
not alter Git history. There are no affected September-only June tags or
releases to delete.