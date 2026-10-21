# delight-worktree

The canonical project-specific OpenCode v2 and Codex CLI skill and helper script
for the Le Paysan Urbain WordPress project. The project installs this directory
with symlinks; it is not a duplicate copy.

Its purpose is narrow: given one delight number, it sets up an isolated worktree
containing that single change on top of current `main`, then opens the editor and
a read-only agent review session. It does not review the change itself, fix or
land it, or start WordPress; it only prepares the environment to review one
specific change.

## Project it belongs to

Le Paysan Urbain, a WordPress Multisite project:

- canonical skill: `/home/tburette/dev/ai/ai-tools/delight-worktree`
- repository: `/home/tburette/dev/lepaysanurbain/site/wordpress-lpu`
- generated review worktrees: `/home/tburette/dev/lepaysanurbain/site/delightNN`
- base branch: `main`
- source branch: `delight` (no dedicated `site/delight` worktree required)
- one improvement per commit, documented as
  `docs/improvements/NN-*.md`
- wp-env configuration with a `port` and `DOMAIN_CURRENT_SITE`

## What it does

For a number such as `3` or `03`, it:

1. Finds the commit on `delight` that first added
   `docs/improvements/03-*.md`.
2. Refuses to run if branch `delight03`, directory `delight03`, or port `8103`
   already exists or is in use by a sibling worktree.
3. Creates `site/delight03` on a new branch `delight03` from local `main`.
4. Cherry-picks only that one improvement commit. If it cannot apply
   independently, it aborts the pick and removes the worktree and branch it just
   created.
5. Changes `port` and `DOMAIN_CURRENT_SITE` to `8100 + NN` in the new worktree's
   `.wp-env.json`.
6. Opens VS Code on the new worktree and a GNOME Terminal running
   `opencode --prompt ...` with its working directory set to that worktree.

The script only reads the `delight` branch and creates the new worktree. It does
not read, stash or modify `site/delight` or any other existing worktree.

The generated prompt is read-only: the review must not edit, stage, commit,
push, reset, stash, switch branches, or start/provision wp-env. It asks for an
English report with severity, file/line references, and suggested fixes.

## Why it is not generic

The script contains Le Paysan Urbain-specific assumptions:

- it finds the repository from `DELIGHT_REPO_ROOT`, the current directory, or
  the installed skill symlink, and assumes the checkout layout `site/wordpress-lpu`
  with generated `site/delightNN` siblings;
- it depends on the local branch names `main` and `delight`;
- it maps a number to a commit through `docs/improvements/NN-*.md`;
- it assigns ports with `8100 + NN` and edits the project's `wp-env` JSON keys;
- it launches `code` and a GNOME Terminal with `opencode`;
- it knows the name of the target worktree and directory to create.

This canonical copy is the source of truth for this project-specific skill. Do not
install it globally; it is tied to the Le Paysan Urbain layout and branches.

## Possible generic workflow

The pattern is useful beyond this project:

> Generate a batch of independent changes, then review them one at a time in
> isolated checkouts.

A general version could:

1. Let a generator produce a branch containing N changes, each self-contained
   and independently cherry-pickable, with metadata (title, description, touched
   files, or a review note).
2. Select one change and create a worktree from the current base branch plus
   only that change.
3. Allocate isolated runtime configuration for that worktree (port, database,
   environment file, cache directory).
4. Open the editor and an agent review session with a prompt specialized to the
   change and the project's conventions.
5. Keep the review read-only, collect reports, and land accepted changes one by
   one.
6. Optionally clean up rejected worktrees and report dependency conflicts
   instead of silently resolving them.

To generalize it, parameterize at least:

- repository root, base branch, and source branch;
- how a change is selected (commit range, doc filename, PR label, metadata file);
- worktree location and naming;
- runtime isolation and port allocation;
- editor and terminal/agent launchers;
- review prompt template and report format;
- cleanup policy and collision handling.

The hard parts are not the worktree commands. They are deciding which changes are
truly independent, allocating isolated runtime resources, handling dependency
conflicts, and keeping the review read-only.

## Requirements

- Linux with Bash, Git, `sed`, `grep`, `code`, `gnome-terminal`, and `opencode`.
- A local `delight` branch with the `docs/improvements/NN-*.md` convention. No
  dedicated `site/delight` worktree is needed.
- The writing host may be OpenCode v2 or Codex CLI; the review terminal is always
  launched with `opencode`.
- No wp-env start, reset, cleanup, or provisioning is performed by this skill.

## Files

```text
delight-worktree/
├── README.md
├── SKILL.md
└── scripts/create-delight-worktree.sh
```

## Canonical location and installation

The canonical skill is:

```text
/home/tburette/dev/ai/ai-tools/delight-worktree
```

Install it into the WordPress project with symlinks. OpenCode v2 reads
`.opencode/skills`; Codex reads `.codex/skills`. Both links point at the same
canonical directory, so the hosts cannot drift:

```bash
cd /home/tburette/dev/lepaysanurbain/site/wordpress-lpu
mkdir -p .opencode/skills .codex/skills
ln -s /home/tburette/dev/ai/ai-tools/delight-worktree \
  .opencode/skills/delight-worktree
ln -s /home/tburette/dev/ai/ai-tools/delight-worktree \
  .codex/skills/delight-worktree
```

Keep both symlinks out of `git status` with local `.git/info/exclude` entries:

```bash
cat >> .git/info/exclude <<'EOF'

# Local-only symlinks to the canonical delight review worktree skill
.opencode/skills/delight-worktree
.codex/skills/delight-worktree
EOF
```

Do not replace the symlinks with copies.

The script can be run from anywhere inside the project, or from another directory
through either installed symlink. It finds the repository from
`DELIGHT_REPO_ROOT`, the current directory, or the symlink path. To run the
canonical script from outside the project without using a symlink, set the
repository explicitly:

```bash
DELIGHT_REPO_ROOT=/home/tburette/dev/lepaysanurbain/site/wordpress-lpu \
  /home/tburette/dev/ai/ai-tools/delight-worktree/scripts/create-delight-worktree.sh 03
```

Validate discovery from the project directory:

```bash
# Codex: the skill must appear under the .codex/skills root.
codex debug prompt-input "hello" | grep -F "Delight review worktree"

# OpenCode v2: create a session at this location, then list skills.
opencode serve --port 4799
# In another shell, using the password printed by the server:
OPENCODE_PASSWORD=... opencode api --server http://127.0.0.1:4799 \
  post /api/session --data '{"title":"skill-check","location":{"directory":"'"$PWD"'"}}'
OPENCODE_PASSWORD=... opencode api --server http://127.0.0.1:4799 get /api/skill
```

The OpenCode listing must contain `delight-worktree` with a path under
`.opencode/skills/`. If the first response is empty, wait a few seconds and
retry: the server loads project skills lazily after the session is created. The
Codex listing must contain `(file: r0/delight-worktree/SKILL.md)`, where `r0` is
the project's `.codex/skills` root. Both hosts still launch the review terminal
with `opencode`; Codex is only the invoking host.

## Validation

The script passes `bash -n`. It was checked from `/tmp` through both project
symlinks and with an explicit `DELIGHT_REPO_ROOT`; an unknown improvement fails
before creating anything. Codex CLI 0.163.0 and OpenCode 2.0.31 discover the skill
through the installed symlinks. No live review worktree was created during
validation.
