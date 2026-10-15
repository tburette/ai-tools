---
name: wp-env-clone
description: Clone an existing local WordPress wp-env's database and wp-content into another checkout or worktree. Supports replacing an existing target with recovery backups.
---

# Clone wp-env

Copy WordPress data while preserving the target branch's theme/plugin code.
Never provision the content.

## Run

Default source: `/home/tburette/dev/lepaysanurbain/site/wordpress-lpu`.
Default target: the current checkout.
New environments use a free random port unless `--port` is supplied; replacements
retain their existing port and reject a different one. Source and target ports
must differ.

Read the target's applicable `AGENTS.md` and check `git status --short`.
Resolve the helper relative to this skill and run it from the target checkout:

```bash
python3 /absolute/path/to/wp-env-clone/scripts/clone_wp_env.py \
  --source /home/tburette/dev/lepaysanurbain/site/wordpress-lpu
```

If the sandbox is known to block Docker, request elevated execution immediately
(Codex: `sandbox_permissions: "require_escalated"`; OpenCode: shell permissions).

The helper copies the database and `wp-content`, updates `.wp-env.json`, starts
the target, rewrites URLs, and checks each site's HTTP response. Startup prints
elapsed time every 15 seconds. Keep waiting on the running command; don't launch
another clone. Report the URL, result, and snapshot directory.
Additional checks are unnecessary unless diagnosing a failure.

## Replacement and failures

- For an initialized target, use `--replace-existing` only when replacement is
  authorized. It backs up the target database, content, and configuration first.
- Source and replacement target must be running. Start stopped environments with
  `npm run start`. If Docker Desktop is unavailable, ask the user to start it;
  do not switch Docker contexts.
- On failure, keep snapshots and inspect the failed step before retrying: the
  target may already be partially changed. Do not automatically reset, clean up,
  or restore backups. Preserve unrelated edits; `.wp-env.json` is the helper's
  only tracked-file change.

Consult [README.md](README.md) for supported layouts, flags, installation,
recovery, and validation.
