# wp-env-clone

A personal Codex CLI and OpenCode skill for cloning the running
`/home/tburette/dev/lepaysanurbain/site/wordpress-lpu` environment into the current
checkout. The Python helper is host-independent and takes an explicit source;
the personal default belongs to the skill instructions, not the reusable code.

## Use

Ask either host to “clone wordpress-lpu into this worktree” or invoke
`$wp-env-clone`. The helper has the same interface in either host:

```bash
python3 /home/tburette/dev/ai/ai-tools/wp-env-clone/scripts/clone_wp_env.py \
  --source /home/tburette/dev/lepaysanurbain/site/wordpress-lpu
```

Run from the **target** checkout. Override defaults explicitly:

```bash
python3 /home/tburette/dev/ai/ai-tools/wp-env-clone/scripts/clone_wp_env.py \
  --source /path/to/source --target /path/to/worktree --port 9385
```

`--dry-run` performs read-only preflight and prints a proposed URL. A subsequent
run may choose a different random port unless you pass `--port`.
`--replace-existing` permits replacement of an already initialized, running
target and saves recovery snapshots first. It retains that target's port.
Explicit options take precedence over the skill defaults.

## Prerequisites and supported layout

- Linux shell, Python 3.10+, globally installed `wp-env` (tested with 11.7.0),
  Docker Compose v2, npm, rsync, and curl. No Python packages or local
  `@wordpress/env` installation are needed. Never use npx to install wp-env.
- Docker Desktop/current Docker context working and the source environment
  running. Request elevated execution in a host sandbox that blocks Docker.
  Do not switch contexts to repair an unavailable daemon.
- Both checkouts have `.wp-env.json`, `testsEnvironment: false`, the mapping
  `"wp-content": "./.wp-env-data/wp-content"`, and compatible core, plugin,
  theme sources, and multisite topology. The target has an `npm run start`
  script. Its branch's actual theme/plugin files may differ intentionally.
- Source/target are separate, non-nested directories with ordinary persistent
  content directories. The source URL uses HTTP(S) at the hostname root;
  local DNS/hosts entries resolve it and any farm subdomains on the new port.
- Single sites and multisite networks using the same hostname/subdomain layout
  are supported. Domain-mapped networks, `.wp-env.override.json`, per-environment
  `env` overrides, test environments, and alternate content mappings require a
  separately reviewed workflow; this helper rejects them rather than guessing.

The skill is a standard `SKILL.md` with optional Codex UI metadata, and its
runtime invokes ordinary shell commands without Codex/OpenCode APIs. Component
tests exercise that shared CLI; discovery can be checked through each host's
installed symlink. No browser, account connector, or host-specific adapter is
required.

## Outputs and side effects

The helper exports the entire source database to a private directory under
`TARGET/.wp-env-data/clone-<UTC>-<suffix>/source.sql`, copies source `wp-content`
into the target, edits the target `.wp-env.json`, and runs `npm run start`.
It imports the SQL, replaces the source hostname and port with the target's
across all prefixed tables using WP-CLI's serialized-value support, flushes the
target cache, and requires HTTP 200 for every returned site URL.

While `npm run start` runs, the helper writes a message such as
`WordPress startup still running (15s elapsed).` to stderr every 15 seconds.
Native command output continues normally. Messages stop when the command exits
or fails; they confirm that the helper is still waiting, not that WordPress is
making progress. They do not trigger a timeout, restart, or retry.

For a fresh target it selects an available random port from 9000–9999, excluding
the source port. It writes the matching `WP_HOME`, `WP_SITEURL`, and (for
multisite) `DOMAIN_CURRENT_SITE`, and disables automatic port substitution.
The availability check cannot reserve the port against another process racing
to bind it; startup failure is reported, not silently retried on another port.

It preserves the target's Git branch, repository theme/plugin files, and all
other tracked files. It does not provision, reset, clean up, restore a backup,
export core files, or modify the source environment's data/configuration. Reads
are from a live source, so database and files are not an atomic snapshot.
Symlinks inside content are preserved; their external targets are not copied.

As with a normal WP-CLI import, backed-up tables replace their namesakes, and
extra target tables are not dropped. File copying overwrites matching paths
and leaves target-only paths. Post GUIDs retain their original identities;
their stored URLs are deliberately excluded from replacement. These details
matter when replacing an existing target; a fresh checkout is the default use.
WordPress/plugin startup and HTTP checks can execute their usual local hooks
and scheduled work. No contact form is submitted by this tool.

## Recovery and failures

Snapshots can contain users, submissions, personal data, and configuration
secrets. Snapshot directories have mode 0700 and SQL files 0600, and live outside
the public `wp-content` mount. Keep `.wp-env-data` Git-ignored, restrict access,
and retain the printed paths until the clone is accepted.

An existing target replacement also saves `target-before.sql`,
`target-wp-content.tar.gz`, and `target.wp-env.json` **before** overwriting its
content/configuration/database. The archive contains the host's persistent
content, not repository theme/plugin mounts; those are never copied by this
helper. The original target configuration is saved for fresh targets too.

On an error, the helper returns nonzero and leaves its progress and snapshots
available. A database import can fail partway through; never blindly retry or
assume a failed run did nothing. Read the failed step and current target status.
Recovering a previous database/content archive requires explicit restore
authorization. There is no automatic rollback or cleanup, and no restore is
performed as part of validation.
Docker Desktop's “mounts denied” error means the checkout is outside its shared
directories (often `/tmp`); use an authorized checkout in a shared directory.
Do not change Docker contexts or rerun provisioning to repair that error.

## Install

After validating the source, and with user approval for host-owned directories,
create links as used by the sibling skills:

```bash
ln -s /home/tburette/dev/ai/ai-tools/wp-env-clone ~/.codex/skills/wp-env-clone
ln -s /home/tburette/dev/ai/ai-tools/wp-env-clone ~/.config/opencode/skills/wp-env-clone
```

Do not replace an existing different link/directory without resolving its
ownership. Reload/restart a host if it cached its available skill list. Edit
this repository's source, not a copied installation or a host cache.

## Validate

```bash
python3 wp-env-clone/scripts/test_clone_wp_env.py
python3 /home/tburette/.codex/skills/.system/skill-creator/scripts/quick_validate.py wp-env-clone
```

The component smoke tests use fake Docker/wp-env/npm/curl executables and real
rsync in temporary directories. They check observable file and SQL transport,
port/configuration changes, command ordering, replacement recovery, and failure
boundaries without accessing Docker or the user's WordPress data. Live testing,
when performed, is reported separately; the fakes alone do not establish
WordPress or agent-host integration.
In a sandbox that prohibits sockets, run these tests with elevated permission
for their local port availability checks; they still do not invoke real Docker.

All 17 isolated smoke tests pass, including elapsed-time reporting and reporter
shutdown after successful and failed commands. A live clone was validated on
2026-10-15 with wp-env 11.7.0 / WordPress 7.1.3 and imported all 80 exported tables. All four sites
and a copied JPEG returned HTTP 200. The temporary environment was stopped.
Codex CLI's `skills/list` and OpenCode's `--pure debug skill` both discovered the
installed skill through their symlinks.
