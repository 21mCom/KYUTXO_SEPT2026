---
name: CI must not push back to main (breaks Replit Sync)
description: Why GitHub Actions writing commits back to main creates a push-rejection loop with Replit's Git Sync, and the safe versioning pattern to avoid it.
---

# CI pushing to main breaks Replit Sync

**Rule:** A GitHub Actions workflow triggered on `push: main` must NEVER `git
commit` + `git push` back to `main`. Derive any per-build value (e.g. a release
version) at build time instead of persisting it to the repo.

**Why:** Replit's "Sync Changes" can only reach GitHub through its managed proxy
(raw `git fetch`/`push` from the agent shell to github.com hangs / is blocked —
do not try to diagnose via shell git to the remote). When CI pushes a commit
back to `main` after every push, GitHub ends up one commit ahead of the local
Replit copy, so the user's next push is rejected as non-fast-forward
("remote has commits you do not have"). Pulling fixes it only until the next
push triggers CI again — a moving-target loop that looks like an unfixable push
rejection. Replit's Git UI exposes no force-push button, so you cannot brute past it.

**How to apply:** For a Windows/electron build that needs a version, compute it
as `<major>.<minor>.<github.run_number>` and write it to package.json only
ephemerally in the runner (`npm version <v> --no-git-tag-version`), used for the
artifact name and the release tag. Remove any "commit version bump" step.
`run_number` is monotonic so release tags stay unique; keep
`permissions: contents: write` (softprops/action-gh-release needs it to create
the tag/release). Deployment note: the fix only takes effect once it's on
GitHub, so the user must win one push — Pull then Push; if rejected once more an
old-workflow run is in flight, wait ~2 min and Pull/Push again.
