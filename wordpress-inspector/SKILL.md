---
name: wordpress-inspector
description: Inspect WordPress Gutenberg editor pages (post, template, navigation,..); returns complete info : block structure, block markup, take snapshots of the entire editing canvas (iframe), report errors and warnings
---

# WordPress Inspector

Use this skill for read-only inspection of an authorized WordPress `wp-admin`
site, especially Gutenberg editors. It is a thin adapter over the sibling
`web-inspector`; use that skill directly instead for general frontend inspection
or to perform actions such as clicking or filling forms.

Browser commands use the permanent Web Inspector profile `default` when
`--profile` is omitted. Use `--profile <name>` for a separate profile and keep
that name unchanged across related commands.

Never run two commands concurrently with the same profile.

## Recommended workflow

1. Use `default` profile, or use `--profile`. With `--profile` choose one
   explicit profile name and reuse it throughout.
2. Run the desired command. If it returns `AUTH_REQUIRED`, follow
   [Authentication recovery](#authentication-recovery), then rerun the original
   command.
   Treat `AUTHENTICATED`, `EDITOR_HEALTHY`, and `EDITOR_SNAPSHOT_CAPTURED` as the successful results for authentication/admin checks, `check-editor`, and `snapshot-editor` respectively. Report other classifications with their warnings and limitations; do not attempt mutation.

Shared command rules:

- For `check-editor` or `snapshot-editor` commands, run with `--editor-url`.
- Some command create a directory with data use `--output-dir` when a
  predictable path is needed. `--output-dir` is optional. Without it, the
  command uses a new random temporary directory under `/tmp`. The JSON output
  of the tool includes the absolute "summary" path that can be used to find the
  path of the output directory.
  `find-post` prints its JSON result directly and does not write a summary
  artifact.

- `--base-url` is required when an editor commands does not provide
  `--editor-url` (with an absolute path).

## Authentication required recovery

If a command returns `AUTH_REQUIRED`, run `authenticate` again with the same
`--base-url` and profile (or the default profile when `--profile` was omitted).
If authentication fails again with `authenticate`, stop and report the
classification and diagnostics instead of retrying indefinitely.

## Environment and prerequisites

The wordpress-inspector script uses the web-inspector skill. It resolves
`../web-inspector` relative to this directory. To use a copy elsewhere, set
`WEB_INSPECTOR_SKILL_DIR`:

```bash
WEB_INSPECTOR_SKILL_DIR=/path/to/web-inspector \
  node scripts/wordpress_inspector.mjs ...
```

If neither location exists, report that `web-inspector` must be installed.

## Use in Codex with sandbox

In a managed Codex sandbox, Chromium may fail to launch even with the default
profile. The adapter reports this as `BROWSER_LAUNCH_BLOCKED` when diagnostics
contain the sandbox or permission failure. When running in codex in a sandbow
environment, run the command that launches Chromium with elevated browser
permission (`sandbox_permissions: "require_escalated"` when using
`exec_command`).

## Authentication

### Interactive login

When credentials are not available, run `authenticate` without credentials to let the user
authenticate (for the current profile):

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --timeout 300000
```

It opens a dedicated headed Chromium profile at `wp-login.php`. Tell the user
the window is open, ask them to sign in and select **Remember Me** when offered,
After login is performed, WordPress displays its admin shell, the adapter closes
the dedicated window automatically and follows it with a read-only admin probe.
The user may still close the window manually, which also continues to the probe.
The command returns `AUTHENTICATED` or `AUTH_REQUIRED`. Headed mode is implied :
using `--headless` is rejected for this command. A timeout or interrupt returns
a non-success result.

By default, reports go to a new random temporary directory. Use an explicit
directory when the artifacts need a stable location:

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --output-dir /tmp/wordpress-inspector/auth
```

### Automated login

When the authorized credentials are already known, pass both options:

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --username admin \
  --password 'replace-with-the-password'
```

Or better to avoid shell-history exposure, use environment variables instead:

```bash
WORDPRESS_INSPECTOR_USERNAME=admin \
WORDPRESS_INSPECTOR_PASSWORD='replace-with-the-password' \
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888
```

This uses the persistent profile headlessly, checks WordPress's standard
**Remember Me** control, and bases the final result on a follow-up read-only
`check-admin` probe. Invalid credentials return `AUTH_REQUIRED`. `--headed` is
not valid in this mode; `--headless` is optional. Two-factor authentication,
CAPTCHA, SSO, and customized login forms may require the interactive flow.

Credentials are not written to summaries or Web Inspector reports. CLI
arguments and generated action arguments can still be visible to local process
inspection, so prefer the environment form when needed and protect the
persistent profile as a credential store.

## find-post

`find-post` resolves a slug to a post ID and ready-to-use editor URL. Public
lookups use a read-only REST GET and are fast because they do not open a
browser:

```bash
node scripts/wordpress_inspector.mjs find-post \
  --base-url http://example.test:8888 \
  --slug test-lpu-split-section
```

Pass the same authenticated profile used by `authenticate` to resolve drafts or
private content. This path uses the profile's browser session for a read-only
REST GET with `context=edit`; it does not use wp-cli or direct database access:

```bash
node scripts/wordpress_inspector.mjs find-post \
  --base-url http://example.test:8888 \
  --slug my-draft-page \
  --profile wp-local
```

`--post-type` accepts `page` or `post` and defaults to `page`. Output includes
`method` (`public` or `authenticated`), `classification`, the matched post,
and `editorUrl` when found. Public content that is not exposed by REST may
report `NOT_FOUND` or `AUTH_REQUIRED`; use an explicit profile for an
authenticated lookup. Non-success results include diagnostics and exit
non-zero.

## Admin and editor checks

### check-admin

```bash
node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test:8888 \
  --output-dir /tmp/wordpress-inspector/admin \
  --timeout 30000
```

The check verifies that the login screen is absent, the WordPress admin shell
is visible, and browser diagnostics contain no blocking errors. A successful
result is `AUTHENTICATED`.

### check-editor

```bash
node scripts/wordpress_inspector.mjs check-editor \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/editor
```

Supported routes are `post.php?action=edit&post=<positive-id>` and
`site-editor.php`; arbitrary endpoints are rejected. This command does not
resolve slugs, post IDs, template IDs, or project-specific URLs, so use
`find-post` when appropriate. Site Editor URLs may target templates, template
parts, navigation, or styles.

With an absolute `--editor-url` and no `--base-url`, the adapter infers the
origin and, as a best effort for subdirectory installations, the path before
`/wp-admin/`; query parameters are not used. Relative editor URLs require
`--base-url`.

The editor must be in visual mode. Text/source mode reports
`EDITOR_LOAD_FAILED`. The health check covers authentication, the editor shell
and canvas, invalid-block/recovery/missing-block indicators, fatal editor
errors, and blocking browser diagnostics. A healthy result is
`EDITOR_HEALTHY`.

### snapshot-editor

Use this command when you need the editable WordPress HTML source, a screenshot
of the complete editor canvas, and the Gutenberg block tree:

```bash
node scripts/wordpress_inspector.mjs snapshot-editor \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/snapshot-editor
```

It has the same URL inference and visual-mode requirements as `check-editor`,
but requires an accessible iframe-based Gutenberg editor. If no accessible
iframe exists, it reports `EDITOR_IFRAME_NOT_FOUND`; a Site Editor page may not
provide source through the single Gutenberg source selector.

On success, the output directory contains a summary plus the Web Inspector
report, editor-shell and full-canvas screenshots, block data in JSON and text
forms, and the current edited source HTML. The successful classification is
`EDITOR_SNAPSHOT_CAPTURED`; collector failures such as unavailable editor data
or source are reported in the classification and diagnostics.

## Outputs, safety, and validation

Summaries (`wordpress-summary.json` or `snapshot-editor.json`) identify the
target, base/final URL, profile, checks, classification, warnings/limitations,
and relevant report or snapshot artifacts. Important classifications include
`AUTHENTICATED`, `AUTH_REQUIRED`, `EDITOR_HEALTHY`,
`EDITOR_SNAPSHOT_CAPTURED`, and `BROWSER_LAUNCH_BLOCKED`. Other failure
classifications, such as editor-load, iframe, source, or technical failures,
carry the diagnostics needed to decide what to do next. Authentication expiry
is reported separately where applicable.

Use authorized sites only, keep reports and screenshots in `/tmp` unless the
user requests another location, and never use a personal browser profile.
Automated authentication makes the expected login-form POST; all other
operations remain read-only and no WordPress content mutation controls are
exercised.

From this directory, run the fixture-based adapter smoke test:

```bash
node scripts/smoke_test.mjs
```

It uses temporary local servers and profiles and removes its temporary
artifacts. Run Web Inspector's own smoke and profile tests separately from
`../web-inspector/`.
