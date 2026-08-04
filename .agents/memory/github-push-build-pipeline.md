---
name: GitHub push & build pipeline
description: How to reliably push this repo to GitHub and trigger the Windows build; gitPush callback pitfall; Windows runner spawn trap.
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

The user's fine-grained PAT has contents read/write (push works). As of Aug 2026 it CAN read `/actions/runs` and job logs (poll run by `head_sha`, fetch `/actions/jobs/<id>/logs`), but Actions write (workflow_dispatch) and PR creation still return 403, and `GITHUB_PERSONAL_ACCESS_TOKEN2` is bad credentials. So the only way to trigger CI is a push to main (which also publishes a release).

## Windows runner spawn trap

The build.yml gate scripts (`node scripts/check-*.js`) run on **windows-2022**. Node `child_process` (`execFileSync`/`spawnSync`) cannot launch `npm`/`npx` there without `shell: process.platform === 'win32'` — npm is `npm.cmd`, which spawns ENOENT without a shell, and Node ≥20.12 refuses `.cmd` spawns entirely unless shell is set. A single unguarded spawn fails the whole Windows build.

**Why:** check-audit.js broke the CI build this way; the failure surfaced only on the GitHub runner, never locally (Linux).

**How to apply:** any "push to GitHub / trigger a build" request: push with the credential-helper recipe, verify by ls-remote SHA match, point the user at the Actions page. Any script added to build.yml that shells out to npm/npx must set `shell: process.platform === 'win32'` (fixed-string args only). Scripts that only run in Replit workflows (Linux) don't need it.

## Native-engine ABI gate in CI

build.yml runs `check-packaged-native-engine.mjs` post-package with `KYUTXO_NATIVE_ENGINE_REQUIRE_ELECTRON=1`: the extracted worker MUST load under the packaged binary via ELECTRON_RUN_AS_NODE (Electron ABI, npmRebuild on) — no system-Node fallback. Locally (Replit) the same check falls back to Node because upstream Electron binaries can't start (missing shared libs); that fallback is ABI-honest only because the local gate build uses `-c.npmRebuild=false`. Never set REQUIRE mode in Replit runs; never remove it from CI/electron-build.sh.

## Merge-churn clobber

Task-agent merges rewrite `.agents/memory/MEMORY.md` and can delete topic files added between their branch point and merge. If this entry's index line vanishes from MEMORY.md, re-append it and re-check this file exists.
