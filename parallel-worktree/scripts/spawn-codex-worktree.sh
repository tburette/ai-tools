#!/usr/bin/env bash
set -euo pipefail

WORKTREE_PATH="${1:?worktree path required}"
PROMPT="${2:?prompt required}"

if ! command -v gnome-terminal >/dev/null 2>&1; then
	echo "Error: gnome-terminal is not installed or not in PATH." >&2
	exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
	echo "Error: codex is not installed or not in PATH." >&2
	exit 1
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
	echo "Error: worktree does not exist: $WORKTREE_PATH" >&2
	exit 1
fi

if [[ "$(git -C "$WORKTREE_PATH" rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]]; then
	echo "Error: path is not a Git work tree: $WORKTREE_PATH" >&2
	exit 1
fi

CODEX_PARALLEL_PROMPT="$PROMPT" gnome-terminal \
	--working-directory="$WORKTREE_PATH" \
	-- bash -c '
        codex "$CODEX_PARALLEL_PROMPT"
        status=$?
        echo
        echo "============================================================"
        echo "Codex exited with status: $status"
        echo "Worktree: $PWD"
        echo "============================================================"
        echo
        echo "Review the Codex report above. The shell is intentionally left open."
        exec bash
    '
