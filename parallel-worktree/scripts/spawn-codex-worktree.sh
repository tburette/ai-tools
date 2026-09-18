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

WORKTREE_PATH="$(cd "$WORKTREE_PATH" && pwd -P)"

# Codex may be launched from a host process that intentionally uses a
# non-interactive terminal environment (for example, NO_COLOR=1 and
# TERM=dumb). GNOME Terminal provides a real color-capable terminal, so do
# not let those inherited settings disable the child Codex TUI.
# TERMINAL_TYPE="${TERM:-xterm-256color}"
# if [[ "$TERMINAL_TYPE" == "dumb" ]]; then
# 	TERMINAL_TYPE="xterm-256color"
# fi

# not needed to have colors on my system
# env -u NO_COLOR \
# 	TERM="$TERMINAL_TYPE" \
# 	COLORTERM="${COLORTERM:-truecolor}" \

CODEX_PARALLEL_PROMPT="$PROMPT" \
	gnome-terminal \
	--working-directory="$WORKTREE_PATH" \
	-- bash -c '
        unset NO_COLOR
        if [[ -z "${TERM:-}" || "$TERM" == "dumb" ]]; then
            export TERM=xterm-256color
        fi
        export COLORTERM="${COLORTERM:-truecolor}"
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
    ' bash "$WORKTREE_PATH"
