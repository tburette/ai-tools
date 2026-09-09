---
name: wordpress-inspector
description: Inspect authorized WordPress administration and Gutenberg interfaces with a dedicated persistent Web Inspector profile. Use for read-only wp-admin checks, Gutenberg health checks, automated or interactive authentication, retrieving for a Gutenberg editor page the HTML source content of a post (page,..) and a screenshot of the editing area, authentication-expiry detection, and local WordPress QA; use web-inspector directly for ordinary public frontend inspection.
---

# WordPress Inspector

Use this skill for read-only inspection of the wp-admin side of a WordPress site, and especially Gutenberg editor pages. It is a thin WordPress adapter over the sibling `web-inspector`; use that skill directly if you need to perform general actions such as clicking around or filling forms.
This tool is designed to be read-only. The only exception is automated authentication, which submits the supplied credentials to the WordPress login form and does not expose any content-mutation controls.

Browser commands use the permanent Web Inspector profile `default` when `--profile` is omitted. Use `--profile <name>` when you need a separate profile, and keep that name unchanged across authentication and subsequent checks. If a command reports `AUTH_REQUIRED`, follow the [Authentication recovery](#authentication-recovery) steps before retrying the original command.  
Keep the same profile name for successive related commands (`authenticate`, `check-admin`, `check-editor`, ...).

Do not run two commands concurrently with the same profile.

`find-post` is the exception: without `--profile` it uses the public REST API and does not open a browser; pass an explicit profile for an authenticated lookup of non-public content. Its `--base-url` remains required.

## Standard editor workflow

1. Use the default profile, or choose one explicit profile name and keep it unchanged for every command in this workflow.
2. Use check-admin to see if you have admin access.
3. If the result is `AUTH_REQUIRED`, follow the [Authentication recovery](#authentication-recovery) steps, then rerun the original command with the same profile.
4. Run `check-editor` or `snapshot-editor` with `--editor-url`; `--base-url` may be omitted when that is an absolute URL, because the adapter infers the origin and WordPress path prefix. Use an explicit `--base-url` for a relative editor URL.
5. Treat `AUTHENTICATED` as the successful authentication/admin result, `EDITOR_HEALTHY` as the successful `check-editor` result, and `EDITOR_SNAPSHOT_CAPTURED` as the successful `snapshot-editor` result. Report any other classification and its diagnostics without attempting mutation.

## Retrieve post ID from frontend URL

`find-post` resolves a slug to a post id and a ready-to-use editor URL. Without a profile it queries the public REST API (fast, no browser, only publicly readable content):

```bash
node scripts/wordpress_inspector.mjs find-post \
  --base-url http://example.test:8888 \
  --slug test-lpu-split-section
```

Pass `--profile` (the same persistent profile used with `authenticate`) to resolve non-public content too, such as drafts and private posts. The authenticated lookup uses a read-only REST GET with `context=edit`, so WordPress can return content the profile's user is allowed to view; it does not use wp-cli or direct database access:

```bash
node scripts/wordpress_inspector.mjs find-post \
  --base-url http://example.test:8888 \
  --slug my-draft-page \
  --profile wp-local
```

It accepts `--post-type page|post` (default `page`). It exits non-zero when nothing matches or the lookup could not complete. Output includes `method` (`public` or `authenticated`) and `classification` (`FOUND`, `NOT_FOUND`, `AUTH_REQUIRED`, `BROWSER_LAUNCH_BLOCKED`, or `TECHNICAL_ERRORS`). Public REST failures include a structured classification, optional `httpStatus`, and diagnostic `warnings`/`limitations`; pass `--profile` when the public API reports `AUTH_REQUIRED` or cannot expose non-public content.

## Dependency and installation

The adapter resolves `../web-inspector` relative to this directory. It can also use a web-inspector in another directory with the environment variable `WEB_INSPECTOR_SKILL_DIR`:

```bash
WEB_INSPECTOR_SKILL_DIR=/path/to/web-inspector \
  node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test \
  --output-dir /tmp/wordpress-inspector/admin
```

If there is no sibling `../web-inspector` and no `WEB_INSPECTOR_SKILL_DIR` report the problem to the user and ask them to install web-inspector.

A Web Inspector spawns with `process.execPath` and argument arrays. Each command writes a WordPress summary beside the underlying Web Inspector `report.json` and screenshot written on disk.

## Managed Codex sandbox

Chromium may be blocked by the execution sandbox even when the default persistent profile is used. The direct browser diagnostic may contain `sandbox_host_linux` or `Operation not permitted`; the WordPress adapter reports this as `BROWSER_LAUNCH_BLOCKED`.

For this environment, the command that launches Chromium must request elevated browser permission (`sandbox_permissions: "require_escalated"` when using Codex `exec_command`).

## Profile setup and authentication

By default, `authenticate` and the subsequent checks use the permanent profile
`default`. Pass `--profile <name>` to use a separate profile, then reuse that
name for authentication and subsequent checks.

When credentials are not available, run the interactive setup command. It opens a dedicated headed Chromium profile at `wp-login.php`; no display-mode flag is required:

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --timeout 300000
```

By default, `authenticate` stores its reports in a newly created random temporary directory under the system temporary directory (for example, `/tmp/wordpress-inspector-Ab12cd`). The final JSON output includes the absolute summary path in its `summary` field. For a predictable location, pass `--output-dir` explicitly:

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --output-dir /tmp/wordpress-inspector/auth
```

For `authenticate`, the specified directory is the artifact root. It contains `wordpress-summary.json`; the automated login attempt, when used, is under `login-attempt/`, and the read-only follow-up probe is under `admin-check/auth-probe/` and `admin-check/web-inspector/`. An explicit directory may reuse or overwrite artifacts from an earlier run, so choose a location whose contents can be replaced.

After launching the command, tell the user that the dedicated login window is open. Ask them to sign in, select **Remember Me** when offered, close the browser window when finished, and then report that login is complete. The runner detects page/context/browser closure and returns immediately; continue only after this command's probe has completed.
An explicitly supplied `--timeout` also bounds this interactive session; if omitted, the session waits for the operator to close it.
The command follows a normally closed session with a wp-admin probe and reports `AUTHENTICATED` or `AUTH_REQUIRED`. Manual `authenticate` is headed by default; `--headed` is accepted but optional, while `--headless` is rejected when no credentials are supplied. The interactive runner records `sessionEndReason: window-closed` for a normal close; timeout or SIGINT/SIGTERM ends with a non-success result and skips the admin probe.

If the authorized login and password are already known, pass both `--username` and `--password` to automate the login. This mode uses the persistent profile headlessly, so it does not open a browser window:

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --username admin \
  --password 'replace-with-the-password'
```

Both options are required together and are valid only for `authenticate`. Automated authentication checks WordPress's standard **Remember Me** control before submitting the form, so the persistent profile can retain the login. `--headless` is optional in this mode; `--headed` is rejected. The final result is based on the follow-up `check-admin` probe, so invalid credentials report `AUTH_REQUIRED`. Two-factor authentication, CAPTCHA, SSO, and customized login forms may still require the interactive flow.

To avoid putting the password in shell history, the same values may be provided with `WORDPRESS_INSPECTOR_USERNAME` and `WORDPRESS_INSPECTOR_PASSWORD` instead of the two options:

```bash
WORDPRESS_INSPECTOR_USERNAME=admin \
WORDPRESS_INSPECTOR_PASSWORD='replace-with-the-password' \
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888
```

The adapter does not write credential values to `wordpress-summary.json` or the Web Inspector reports. A CLI password and the generated Web Inspector action arguments can still be visible to local process inspection, so use the environment form when shell-history exposure matters and protect the persistent profile as a credential store.

## Authentication recovery

If any command (`check-admin`, `check-editor`, or `snapshot-editor`) returns `AUTH_REQUIRED`:
Use the `authenticate` command again with the same `--base-url` and profile choice (the default profile if `--profile` was omitted). If this fails, stop and tell the user.

## check-admin

Check the admin shell:

```bash
node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test:8888 \
  --output-dir /tmp/wordpress-inspector/admin \
  --timeout 30000
```

`check-admin` verifies the wp-admin shell is accessible and you are logged in:

- Login form absent (`#loginform`)
- Login username control absent (`#user_login`)
- Admin shell visible (`#wpcontent`, `#wpbody`, or `#wpadminbar`)
- No blocking browser errors (console errors, failed requests, navigation failures); the raw browser report may still contain harmless warnings or ignored editor-internal requests.

## check-editor

Check the status of some Gutenberg content:

```bash
node scripts/wordpress_inspector.mjs check-editor \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/editor
```

`check-editor` only accepts the Gutenberg routes `post.php?action=edit&post=<positive-id>` and `site-editor.php`. It rejects arbitrary endpoints. The first version does not resolve post IDs, slugs, template IDs, or project-specific WordPress URLs; resolve those yourself (`find-post` may help). The site editor routes (`site-editor.php`) cover templates, template parts (direct `?p=/wp_template_part/...` URLs), navigation, and styles; `check-editor` inspects any of them once direct, editable content is targeted.

When `--base-url` is omitted, `--editor-url` must be an absolute `http` or `https` URL targeting one of those supported routes. The adapter uses its origin as the base URL and, as a best effort for subdirectory installations, keeps the path before `/wp-admin/`; query parameters are not used for inference. It records the inferred value in the summary. Relative editor URLs still work when `--base-url` is supplied.

The editor must be in **visual mode**. If the post/page editor is in **text mode** (showing source code), `check-editor` reports `EDITOR_LOAD_FAILED`.

When all editor health checks pass, `check-editor` reports `EDITOR_HEALTHY`. This includes authentication, editor shell/canvas, invalid-block, recovery, missing-block, fatal-error, and browser-diagnostic checks; it is not only a login check.

`check-editor` performs full Gutenberg editor health checks:

- Login form/username absent (authentication verification)
- Editor shell visible (`.edit-post-visual-editor`, `.edit-site-visual-editor`, or `#editor`)
- Editor canvas visible (`.edit-post-visual-editor iframe`, `.edit-site-visual-editor iframe`, `.editor-styles-wrapper`, `.block-editor-writing-flow`, `.edit-site-visual-editor__editor-canvas`)
- Invalid block warning absent (`.block-editor-warning`)
- Block recovery prompt absent (`.block-editor-block-recovery`, `.block-editor-block-recovery__dialog`)
- Missing block placeholder absent (`.wp-block-missing`)
- Fatal editor error absent (`.editor-error`, `.block-editor-error-boundary`)
- No blocking browser errors (console errors, failed requests, navigation failures); the raw browser report may still contain harmless warnings or ignored editor-internal requests.

## Editor snapshots

Use `snapshot-editor` when you need machine-readable view to the source of a WordPress element that can be edited in Gutenberg :

- post/page html source code of the page (the wordpress HTML source code with all the HTML comments thingy, not the frontend rendered HTML)
- an image of what the entire post/page looks like in the editor
- the block structure as a tree

```bash
node scripts/wordpress_inspector.mjs snapshot-editor \
  --base-url http://example.test:8888 \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/snapshot-editor
```

`snapshot-editor` only works with iframe-based Gutenberg and with the editor in visual mode (not in text mode). If it cannot find an accessible editor iframe, it exits non-zero with `EDITOR_IFRAME_NOT_FOUND`.

`snapshot-editor` uses the same `--base-url` inference as `check-editor`: an absolute `--editor-url` is sufficient, while a relative editor URL requires `--base-url`.

On success, the output directory contains:

```text
<output-dir>/
├── snapshot-editor/
│   ├── report.json
│   ├── editor-shell-1440x1100.png
│   ├── editor-canvas-full.png
│   ├── blocks.json
│   ├── blocks.txt
│   └── source.html
└── snapshot-editor.json
```

- `editor-shell-1440x1100.png` is the Web Inspector screenshot of the editor shell at the default viewport.
- `editor-canvas-full.png` is the stitched screenshot of the complete editor canvas.
- `blocks.json` is the Gutenberg block tree from `wp.data.select('core/block-editor').getBlocks()`.
- `blocks.txt` is a compact ASCII tree of the same blocks. This is a shorter, human-readable view and does not replace `blocks.json`.
- `source.html` is the current post/page edited source returned by `wp.data.select('core/editor').getEditedPostContent()`; it is written as-is. A Site Editor page may not expose the source code editing view (`core/editor` source selector); in that case `snapshot-editor` reports `EDITOR_SOURCE_UNAVAILABLE`.
- `snapshot-editor.json` references these artifact files as `editorCanvasScreenshot`, `blocks`, `blockTreeText`, and `source`, along with record sizes, dimensions, and a source hash. Its `browserReport` field points to `snapshot-editor/report.json`.

### Classifications and artifacts

The check summary (`wordpress-summary.json`) and editor snapshot summary (`snapshot-editor.json`) contain :

- a normalized `targetType` (`authentication`, `wp-admin`, or `gutenberg-editor`)
- base/final URL
- profile name
- checks
- classification (result of the request)
- links to the browser report and screenshots
- named warnings (for example `invalid-block-warning`, `block-recovery-prompt`, `missing-block-placeholder`, or `fatal-editor-error`), and limitations.

Classification values:

- `AUTHENTICATED` — the expected authentication/admin-shell checks passed (`authenticate` and `check-admin`);
- `AUTH_REQUIRED` — WordPress returned a login route/form or equivalent expiry signal;
- `ADMIN_LOAD_FAILED` — authentication was not the primary signal, but the admin shell failed;
- `EDITOR_HEALTHY` — the expected Gutenberg editor health checks passed (`check-editor`);
- `EDITOR_LOAD_FAILED` — the editor shell/canvas or fatal-error checks failed;
- `EDITOR_INVALID_BLOCKS` — the editor rendered but an invalid/missing/recovery indicator was present;
- `EDITOR_SNAPSHOT_CAPTURED` — `snapshot-editor` captured the iframe screenshot, block tree, and source successfully;
- `EDITOR_IFRAME_NOT_FOUND` — `snapshot-editor` requires an accessible iframe-based Gutenberg editor;
- `EDITOR_IFRAME_EMPTY` — the editor iframe was present but had no measurable document content;
- `EDITOR_DATA_UNAVAILABLE` — Gutenberg's block-editor data store was unavailable;
- `EDITOR_SOURCE_UNAVAILABLE` / `EDITOR_SOURCE_INVALID` — the single Gutenberg source selector could not provide a string;
- `BROWSER_LAUNCH_BLOCKED` — the Web Inspector could not launch Chromium because the execution environment blocked the browser process; retry with elevated browser permission;
- `TECHNICAL_ERRORS` — browser or network diagnostics failed.

Authentication expiry is reported separately.

## Safety and local-site workflow

`/tmp` for screenshots and reports unless the user requests another artifact location.
Do not use a personal browser profile. Automated authentication submits one login-form POST; all other inspector operations remain read-only and no WordPress content mutation controls are exercised.

## Validation

From this skill directory, run the fixture-based adapter smoke test:

```bash
node scripts/smoke_test.mjs
```

It uses a temporary local server and profiles, proves default-profile authentication, automated login and credential redaction, healthy/invalid editor classification, iframe snapshot artifacts, no-iframe failure, same-origin enforcement, report redaction, and that automated authentication makes only the expected login-form POST with no other mutation request. It removes its temporary artifacts. Run Web Inspector's own smoke and profile tests separately from `../web-inspector/`.
