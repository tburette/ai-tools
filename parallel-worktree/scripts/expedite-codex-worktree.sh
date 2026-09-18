#!/usr/bin/env bash
set -euo pipefail

PROMPT="${1:?prompt required}"
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SPAWN_SCRIPT="$SCRIPT_DIRECTORY/spawn-codex-worktree.sh"

if ! command -v git >/dev/null 2>&1; then
	echo "Error: git is not installed or not in PATH." >&2
	exit 1
fi

if ! command -v mktemp >/dev/null 2>&1; then
	echo "Error: mktemp is not installed or not in PATH." >&2
	exit 1
fi

if ! REPOSITORY_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
	echo "Error: the current directory is not inside a Git worktree." >&2
	exit 1
fi

REPOSITORY_ROOT="$(cd -- "$REPOSITORY_ROOT" && pwd -P)"
REPOSITORY_PARENT="$(dirname -- "$REPOSITORY_ROOT")"

WORKTREE_PATH="$(mktemp -d "$REPOSITORY_PARENT/parallel-task-XXXXXXXX")"
BRANCH_NAME="$(basename -- "$WORKTREE_PATH")"

if ! git -C "$REPOSITORY_ROOT" worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH"; then
	# This only removes the empty reservation if Git did not populate it.
	rmdir -- "$WORKTREE_PATH" 2>/dev/null || true
	exit 1
fi

git -C "$WORKTREE_PATH" status --short --branch

printf '%s\n' \
	"Expedited parallel worktree created." \
	"Branch: $BRANCH_NAME" \
	"Worktree: $WORKTREE_PATH"

"$SPAWN_SCRIPT" "$WORKTREE_PATH" "$PROMPT"
