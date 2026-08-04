---
name: Workflow-runner phantom rg entries
description: Every workflow start/restart + post-merge reconciliation fails with rg exit 2 "No such file or directory" on .local/skills entries that look healthy from the shell.
---

# Workflow-runner phantom rg entries

**Symptom:** `WorkflowsRestart` (any workflow) and post-merge workflow reconciliation fail with
`Ripgrep exited with code 2: rg: ./.local/skills/<skill>: No such file or directory`,
repeatedly and deterministically, while the same paths look perfectly healthy from ShellExec.
A failed restart still SIGTERMs the old process first — so the dev server ends up DOWN and the
preview breaks until the fault is cleared.

**Rule:** this is a platform-side fault in the workflow runner's own mount namespace (stale/dangling
skill bind-mounts). Nothing filesystem-side can fix it. Do not burn time on repo-side mitigations.

**Why:** verified 2026-08-04 — all of these were tried and ruled out:
- Shell-side rg passes with every flag combo (`--hidden`, `--no-ignore`, `-uu`, `--follow`) → not a real FS problem.
- Paths are real dirs, not symlinks; `git ls-files` shows nothing tracked under `.local/skills` → not a git-snapshot problem.
- Root `.rgignore` is NOT honored by the runner's scan.
- Renaming/removing the underlying dirs does NOT clear the runner's view (its mount table pins the phantom names independently).
- Retrying across ~40 min fails identically → not a provisioning race.

**How to apply:**
1. Recognize the signature (identical rg exit-2 paths across reconciliation AND every workflow restart) and skip straight to the remedy.
2. Check whether the app process died (`curl 127.0.0.1:5000`, `ps`) — warn the user their preview is down.
3. Remedy = container restart to rebuild the runner namespace: get user consent, then `kill 1` from ShellExec (disk persists, task agents unaffected, takes ~a minute). The kill-1 tool call itself errors out — expected.
4. After reboot: restart always-on workflows (Start application, artifact preview server), re-run `runPostMergeSetup()` to confirm reconciliation is green, verify port 5000 serves.
5. If the phantom returns after reboot, it's a Replit platform bug to escalate via support — stop retrying.
