---
name: Delight review worktree
description: Create an isolated Git worktree for one delight improvement, prepare its wp-env port, and open VS Code plus an OpenCode review session. Use when asked to review a specific delight number in the Le Paysan Urbain WordPress repository.
---

# Delight review worktree

## Purpose

Prepare a new isolated delight environment to review one improvement from the
local `delight` branch without touching the current worktree or `main`.

This skill does **not** land the improvement on `main`. It creates a branch
containing current `main` plus only the selected delight commit, so the review
sees the change independently of the other delights and in the context of the
current main branch.

It does not require, read or modify an existing `site/delight` worktree or any
other local worktree. Only the committed `delight` branch is used.

## Invocation

Use the installed script:

```bash
"<skill-base>/scripts/create-delight-worktree.sh" 03
```

Accept `03` or `3`. The number must match a file
`docs/improvements/NN-*.md` on the local `delight` branch.

The script finds the WordPress repository from `DELIGHT_REPO_ROOT`, the current
directory, or the installed skill symlink. Run it from inside the project, or
from anywhere through the installed OpenCode or Codex symlink.

Summarize what was created when the command returns:

- worktree path;
- branch name;
- commit under review;
- wp-env port;
- whether VS Code and the OpenCode terminal were launched.

## What the script does

1. Normalizes `NN` to two digits.
2. Finds the commit on the local `delight` branch that first added
   `docs/improvements/NN-*.md`.
3. Refuses to continue if branch `delightNN` or the target directory already
   exists, or if the computed port is already used by a sibling worktree.
4. Creates `../delightNN` on a new branch `delightNN` from local `main`, then
   cherry-picks only the selected commit. If that commit cannot apply
   independently, the worktree and branch are removed and the dependencies are
   reported. The base is local `main`, not `origin/main`; update `main` first if
   the review should include newer work. No other worktree is read or modified.
5. Sets port `8100 + NN` in the new worktree's `.wp-env.json`, changing both
   `port` and `config.DOMAIN_CURRENT_SITE`.
6. Opens VS Code in the worktree and a GNOME Terminal running OpenCode with a
   read-only review prompt.

## Rules and non-goals

- Do not start, reset, cleanup or provision wp-env. The worktree is for code
  review, not a running site.
- Do not stash or modify another worktree. The script only reads the `delight`
  branch and creates `../delightNN`.
- Do not commit the generated `.wp-env.json` port change.
- Do not make fixes, commits or pushes from the review session. The review
  agent must not stage, stash, switch branches or modify files.
- Do not copy this skill into the created worktree. It lives outside the
  WordPress repository, so it is never part of the new worktree.
- Do not delete or reset an existing branch or worktree.
- Only the commit that first added the improvement doc is included. Later fix
  commits made on an existing `delightNN` branch are not part of this worktree.
- The review prompt must remain read-only and ask for an English report.
- If a cherry-pick conflicts, the script aborts, removes only the worktree and
  branch it just created, and reports that this delight depends on another
  change not yet present in `main`.

## Expected files

- `scripts/create-delight-worktree.sh`
