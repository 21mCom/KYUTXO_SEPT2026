---
name: GitHub workflow-scope push rejection (masked as PUSH_REJECTED)
description: Why pushing commits that touch .github/workflows/ fails through Replit's GitHub login, and how to actually land them.
---

# Pushing `.github/workflows/*` needs the `workflow` scope

**Rule:** Any git push whose history adds or modifies a file under
`.github/workflows/` is rejected by GitHub unless the *credential* doing the push
carries the `workflow` scope (classic PAT) or `Workflows: write` (fine-grained /
GitHub App). Replit's built-in GitHub login (an OAuth App) does **not** carry it.

**Why:** GitHub refuses with
`refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`.
Replit's Git UI swallows this and shows the generic
`PUSH_REJECTED — the remote has commits that aren't in the local repository`,
which sends you chasing a non-existent divergence. The tell: every other object
uploads fine and only the `! [remote rejected] main -> main (... workflow ...)`
line fails. Note this is per-history — removing the workflow file in a *new* commit
does NOT help, because the earlier commits that introduced it are still in the
push; you'd have to rewrite history (or never have it) to push without the scope.

**How to apply:**
- The reliable fix that keeps history + CI: have the USER push from their own
  Shell with a token that has the scope. Classic PAT with `repo` + `workflow`:
  `git push https://<TOKEN>@github.com/<org>/<repo>.git main --force`
  (inline URL keeps the token out of `origin`). If the org blocks classic PATs,
  use a fine-grained PAT with Contents: write + Workflows: write.
- After the token push, the user clicks Replit's Git-pane refresh so Replit
  re-fetches (read-only fetch works without the scope) and the "N↑" clears.
- The agent CANNOT do this: agent shell can't reach github.com (hangs) AND the
  platform blocks the agent from any write under `.git/` (`git remote set-url`,
  even `rm .git/config.lock` are refused as "destructive git operations"). The
  user's interactive Shell has neither restriction — route all real git remote
  surgery and pushes through the user.
