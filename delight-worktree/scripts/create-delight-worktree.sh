#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: create-delight-worktree.sh <delight-number>

Example: create-delight-worktree.sh 03

Creates ../delightNN from local main, cherry-picks the single commit that added
docs/improvements/NN-*.md, sets wp-env port 8100+NN, and opens VS Code plus an
OpenCode review session.

The WordPress repository is found from DELIGHT_REPO_ROOT, the current directory,
or the installed skill symlink. No other worktree is read or modified.
EOF
	exit 2
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

info() {
	printf '%s\n' "$*"
}

[[ $# -eq 1 ]] || usage
case "$1" in
	'' | *[!0-9]*) usage ;;
esac

NUM=$((10#$1))
(( NUM >= 1 )) || usage
NN=$(printf '%02d' "$NUM")

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Find the WordPress repository from DELIGHT_REPO_ROOT, the current directory,
# or the installed skill symlink. The canonical script lives in ai-tools, so
# Git must not be asked to resolve the symlinked script path first.
valid_root() {
	local root="$1"
	[[ -f "$root/.wp-env.json" ]] || return 1
	[[ -e "$root/.git" ]] || return 1
	git -C "$root" cat-file -e "delight:docs/improvements" 2>/dev/null ||
		return 1
	git -C "$root" rev-parse --verify --quiet refs/heads/delight >/dev/null ||
		return 1
	printf '%s\n' "$root"
}

repo_from_git_path() {
	local common
	common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
		return 1
	# The parent of the common Git directory is the main checkout, even when
	# the candidate is a linked worktree.
	valid_root "$(dirname "$common")"
}

repo_from_script_parents() {
	local dir="$SCRIPT_DIR"
	while [[ "$dir" != "/" ]]; do
		if [[ -f "$dir/.wp-env.json" && -e "$dir/.git" ]]; then
			valid_root "$dir"
			return
		fi
		dir="$(dirname "$dir")"
	done
	return 1
}

resolve_repo() {
	local candidate root
	for candidate in "${DELIGHT_REPO_ROOT:-}" "$PWD"; do
		[[ -n "$candidate" ]] || continue
		root="$(repo_from_git_path "$candidate")" || continue
		printf '%s\n' "$root"
		return 0
	done
	if root="$(repo_from_script_parents)"; then
		printf '%s\n' "$root"
		return 0
	fi
	return 1
}

REPO_ROOT="$(resolve_repo)" ||
	die "could not find the WordPress repository; run from inside it, use the installed skill symlink, or set DELIGHT_REPO_ROOT"
SITE_DIR="$(dirname "$REPO_ROOT")"
TARGET="$SITE_DIR/delight$NN"
BRANCH="delight$NN"
PORT=$((8100 + NUM))

git -C "$REPO_ROOT" rev-parse --verify --quiet refs/heads/main >/dev/null ||
	die "local main branch not found"
git -C "$REPO_ROOT" rev-parse --verify --quiet refs/heads/delight >/dev/null ||
	die "local delight branch not found"

DOC="$(
	git -C "$REPO_ROOT" ls-tree -r --name-only delight -- docs/improvements |
		grep -E "^docs/improvements/${NN}-.*\.md$" |
		sed -n '1p' || true
)"
[[ -n "$DOC" ]] || die "no docs/improvements/${NN}-*.md on branch delight"

# sed consumes the whole log. Piping into head can fail under pipefail when
# Git receives SIGPIPE after head exits.
COMMIT="$(
	git -C "$REPO_ROOT" log --diff-filter=A --format=%H --reverse delight -- "$DOC" |
		sed -n '1p' || true
)"
[[ -n "$COMMIT" ]] || die "could not find the commit that added $DOC"
SUBJECT="$(git -C "$REPO_ROOT" show -s --format=%s "$COMMIT")"

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
	die "branch already exists: $BRANCH"
fi
if [[ -e "$TARGET" ]]; then
	die "target already exists: $TARGET"
fi

shopt -s nullglob
for cfg in "$SITE_DIR"/*/.wp-env.json; do
	if grep -Eq '"port"[[:space:]]*:[[:space:]]*'"$PORT"'([^0-9]|$)' "$cfg" ||
		grep -Eq 'DOMAIN_CURRENT_SITE[[:space:]]*:[[:space:]]*"[^"]*:'"$PORT"'"' "$cfg"; then
		die "port $PORT is already used by $cfg"
	fi
done
shopt -u nullglob

info "Creating $BRANCH at $TARGET from main."
if ! git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$TARGET" main; then
	die "could not create worktree $TARGET"
fi

info "Cherry-picking only $COMMIT ($SUBJECT)."
if ! git -C "$TARGET" cherry-pick -x "$COMMIT"; then
	git -C "$TARGET" cherry-pick --abort >/dev/null 2>&1 || true
	git -C "$REPO_ROOT" worktree remove --force "$TARGET" >/dev/null 2>&1 || true
	git -C "$REPO_ROOT" branch -D "$BRANCH" >/dev/null 2>&1 || true
	die "the commit does not apply independently onto main. It probably depends on a delight that is not in main yet. No worktree was kept."
fi

NEW_COMMIT="$(git -C "$TARGET" rev-parse HEAD)"

WPENV="$TARGET/.wp-env.json"
[[ -f "$WPENV" ]] || die "missing $WPENV in the new worktree"

sed -i -E 's/^([[:space:]]*"port"[[:space:]]*:[[:space:]]*)[0-9]+/\1'"$PORT"'/' "$WPENV"
sed -i -E 's/("DOMAIN_CURRENT_SITE"[[:space:]]*:[[:space:]]*"[^":]*:)[0-9]+"/\1'"$PORT"'"/' "$WPENV"

grep -Eq '^[[:space:]]*"port"[[:space:]]*:[[:space:]]*'"$PORT"'[[:space:]]*,?[[:space:]]*$' "$WPENV" ||
	die "could not set port $PORT in $WPENV"
grep -Eq '^[[:space:]]*"DOMAIN_CURRENT_SITE"[[:space:]]*:[[:space:]]*"[^"]*:'"$PORT"'"' "$WPENV" ||
	die "could not set DOMAIN_CURRENT_SITE to port $PORT in $WPENV"

REVIEW_PROMPT=$(
	cat <<EOF
You are reviewing delight ${NN} in a dedicated Git worktree. This is a READ-ONLY review.

Context
- Improvement: delight ${NN}
- Branch: ${BRANCH}
- Worktree: ${TARGET}
- Original commit under review: ${COMMIT} (${SUBJECT})
- Cherry-picked commit at the branch tip: ${NEW_COMMIT}
- Improvement doc: ${DOC}
- The worktree is local main plus this one commit. Other delight improvements are deliberately absent.
- .wp-env.json has an intentional uncommitted port change to ${PORT}. Do not commit, revert or otherwise modify it.
- Do not start, reset, provision or clean up wp-env. There is no prepared WordPress environment for this worktree.

Task
1. Read AGENTS.md, the improvement doc, and the commit diff with git show ${COMMIT}.
2. Review the implementation: correctness, native WordPress and Gutenberg conventions, block markup validity, accessibility, responsive behavior, performance, design consistency, and whether the documentation matches the code.
3. Judge only the changes introduced by this commit. Mention interactions with current main where they matter, and say if the improvement appears to depend on another delight that is not present.
4. Report in English, ordered by severity, with file and line references and concrete suggested fixes. If you find no blocking issue, say so and list residual risks.
5. Do not edit, stage, commit, push, reset, stash, switch branches or delete anything. Read-only Git commands and syntax checks are allowed.
EOF
)

info "Port set to $PORT in $WPENV."

if command -v code >/dev/null 2>&1; then
	if ! code -n "$TARGET" >/dev/null 2>&1; then
		printf 'Warning: could not launch VS Code for %s\n' "$TARGET" >&2
	fi
else
	printf 'Warning: code is not installed or not in PATH; open the worktree manually.\n' >&2
fi

if ! command -v opencode >/dev/null 2>&1; then
	printf 'Warning: opencode is not installed or not in PATH; launch the review manually.\n' >&2
elif ! command -v gnome-terminal >/dev/null 2>&1; then
	printf 'Warning: gnome-terminal is not installed; launch the review manually.\n' >&2
else
	# The single-quoted script is intentional: the inner bash expands the
	# environment variables passed above.
	# shellcheck disable=SC2016
	DELIGHT_REVIEW_PROMPT="$REVIEW_PROMPT" \
		DELIGHT_WORKTREE="$TARGET" \
		gnome-terminal \
		--working-directory="$TARGET" \
		-- bash -c '
			unset NO_COLOR
			if [[ -z "${TERM:-}" || "$TERM" == "dumb" ]]; then
				export TERM=xterm-256color
			fi
			export COLORTERM="${COLORTERM:-truecolor}"
			opencode --prompt "$DELIGHT_REVIEW_PROMPT"
			status=$?
			printf "\n============================================================\n"
			printf "OpenCode exited with status: %s\n" "$status"
			printf "Worktree: %s\n" "$DELIGHT_WORKTREE"
			exec bash
		' bash ||
		printf 'Warning: could not launch the GNOME Terminal review session.\n' >&2
fi

info ""
info "Review worktree ready."
info "  Worktree:  $TARGET"
info "  Branch:    $BRANCH"
info "  Commit:    $COMMIT  ($SUBJECT)"
info "  Doc:       $DOC"
info "  Port:      $PORT"
info "  Base:      local main + only this commit"
