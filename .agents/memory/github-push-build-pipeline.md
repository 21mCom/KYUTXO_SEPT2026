---
name: GitHub push & build pipeline
description: How to reliably push this repo to GitHub and trigger the Windows build; gitPush callback pitfall.
---

# GitHub push & Windows build

The GitHub remote (`origin`) builds the packaged Windows app via `.github/workflows/build.yml` — it triggers automatically on any push to `main`/`master` (plus `workflow_dispatch`); commits whose message contains `[skip ci]` are skipped.

## Push path that works

- The `gitPush` callback (git-remote skill) can return `{branch: null, remote: null, provider: null}` **without erroring and without actually pushing**. Always verify with `ls-remote` afterward.
- Direct `git fetch/push origin` can fail with "Invalid username or token" — the stored remote/credentials go stale.
- Reliable recipe (token never printed):
  ```bash
  git -c credential.helper='!f() { echo "username=x-access-token"; echo "password=${GITHUB_PERSONAL_ACCESS_TOKEN}"; }; f' \
    push https://github.com/<owner>/<repo>.git main:main
  ```
  Verify first with the same credential-helper trick on `ls-remote refs/heads/main`, and check `git merge-base --is-ancestor <remoteSha> HEAD` before pushing (never force).

**Why:** the callback's silent no-op cost a false "pushed" report once; ls-remote comparison caught it.

## Token scope caveat

The user's fine-grained PAT has contents read/write (push works) but NOT Actions/checks read — `/actions/runs` and `/commits/<sha>/check-runs` return 403. Build status must be watched on github.com/<owner>/<repo>/actions, not polled from here.

**How to apply:** any "push to GitHub / trigger a build / make a release" request: push with the credential-helper recipe, verify by ls-remote SHA match, then point the user at the Actions page for build progress.
