#!/usr/bin/env bash
set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
	echo "Error: git is not installed or not in PATH." >&2
	exit 1
fi

if ! REPOSITORY_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
	echo "Error: the current directory is not inside a Git worktree." >&2
	exit 1
fi

REPOSITORY_ROOT="$(cd "$REPOSITORY_ROOT" && pwd -P)"
CURRENT_DIRECTORY="$(pwd -P)"
PARENT_DIRECTORY="$(dirname "$CURRENT_DIRECTORY")"
STATUS_OUTPUT="$(git -C "$REPOSITORY_ROOT" status --short)"
LOCAL_BRANCHES="$(git -C "$REPOSITORY_ROOT" for-each-ref --format='%(refname:short)' refs/heads | sort)"
WORKTREE_LIST="$(git -C "$REPOSITORY_ROOT" worktree list)"
PARENT_ENTRIES="$(find "$PARENT_DIRECTORY" -mindepth 1 -maxdepth 1 -printf '%f\t%y\n' | sort)"

if [[ -z "$LOCAL_BRANCHES" ]]; then
	LOCAL_BRANCHES="(none)"
fi

if [[ -z "$PARENT_ENTRIES" ]]; then
	PARENT_ENTRIES="(none)"
fi

printf '%s\n' \
	"Parallel worktree preflight (read-only)" \
	"========================================" \
	"" \
	"Current directory: $CURRENT_DIRECTORY" \
	"Repository root: $REPOSITORY_ROOT" \
	"Current directory parent: $PARENT_DIRECTORY" \
	"" \
	"Uncommitted changes (no output means the working tree is clean):" \
	"$STATUS_OUTPUT" \
	"" \
	"Local branch names (the chosen slug must not duplicate one of these):" \
	"$LOCAL_BRANCHES" \
	"" \
	"Existing worktrees (each line shows path, commit, and branch):" \
	"$WORKTREE_LIST" \
	"" \
	"Entries in the current directory's parent (name<TAB>type; d=directory, f=file, l=symlink):" \
	"$PARENT_ENTRIES" \
	"" \
	"Slug selection rules:" \
	"  - Choose a short, filesystem-safe slug using lowercase letters, numbers, and hyphens." \
	"  - Use the exact slug as the local branch name; do not prepend codex/." \
	"  - The new worktree directory will be: ../<slug> (resolved parent: $PARENT_DIRECTORY)." \
	"  - Avoid names already listed as local branches, worktrees, or parent entries." \
	"  - If a collision is found, choose a new slug or add a unique suffix such as -2 or -3."
