---
name: wordpress-inspector
description: Inspect authorized WordPress administration and Gutenberg interfaces with a dedicated persistent Web Inspector profile. Use for read-only wp-admin checks, Gutenberg health checks, retrieve for a gutenberg editor page the html source content of a post (page,..) and a screenshot of the editing area, authentication-expiry detection, and local WordPress QA; use web-inspector directly for ordinary public frontend inspection.
---

# WordPress Inspector

Use this skill for read-only inspection of the wp-admin side of a WordPress site, and especially Gutenberg editor pages. It is a thin WordPress adapter over the sibling `web-inspector`, use that skill directly if you need to perform action such as clicking around, filling forms,..
This tool is designed to be read-only.

Use one stable, explicit profile name for the whole workflow, it is needed to keep the credentials. If a command reports `AUTH_REQUIRED`, follow the [Authentication recovery](#authentication-recovery) steps before retrying the original command.

## Standard editor workflow

1. Choose one profile name and keep it unchanged for every command in this workflow.
2. Use check-admin to see if you have admin access.
3. If the result is `AUTH_REQUIRED`, follow the [Authentication recovery](#authentication-recovery) steps, then rerun the original command with the same profile.
4. Run `check-editor` or `snapshot-editor` with the explicit `--base-url`, `--editor-url`, and `--profile`.
5. Treat `AUTHENTICATED` or `EDITOR_SNAPSHOT_CAPTURED` as the successful authentication/snapshot result. Report any other classification and its diagnostics without attempting mutation.

## Retrieve post ID from frontend URL

`find-post` resolves a slug to a post id and a ready-to-use editor URL. Without a profile it queries the public REST API (fast, no browser, only publicly readable content):

```bash
node scripts/wordpress_inspector.mjs find-post \
  --base-url http://example.test:8888 \
  --slug test-lpu-split-section
```

Pass `--profile` (the same persistent profile used with `authenticate` ) to resolve non-public content too such as drafts andprivate posts:

```bash
node scripts/wordpress_inspector.mjs find-post \
  --base-url http://example.test:8888 \
  --slug my-draft-page \
  --profile wp-local
```

It accepts `--post-type page|post` (default `page`). It exits non-zero when nothing matches or the lookup could not complete. Output includes `method` (`public` or `authenticated`) and `classification` (`FOUND`, `NOT_FOUND`, `AUTH_REQUIRED`, or `TECHNICAL_ERRORS`).

For info, there is another way if you have access to wp-cli:

- extract the slug from the url (eg. http://lepaysanurbain.test:8888/test-lpu-split-section/ => test-lpu-split-section)
- resolve the id using a wp-cli query, (example using wp-env):

```
  wp-env run cli wp -- post list \
   --post_type=page \
   --name=test-lpu-split-section \
   --field=ID
```

## Dependency and installation

The adapter resolves `../web-inspector` relative to this directory. It can also use a web-inspector in another directory with the environment variable `WEB_INSPECTOR_SKILL_DIR`:

```bash
WEB_INSPECTOR_SKILL_DIR=/path/to/web-inspector \
  node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test \
  --profile wp-local
```

If there is no sibling `../web-inspector` and no `WEB_INSPECTOR_SKILL_DIR` report the problem to the user and ask them to install web-inspector.

A Web Inspector spawns with `process.execPath` and argument arrays. Each command writes a WordPress summary beside the underlying Web Inspector `report.json` and screenshot written on disk.

## Profile setup and authentication

Choose one stable profile name (for example, `wp-local`) and reuse it for
authentication and subsequent checks.

Then run the interactive setup command. It always opens a dedicated headed Chromium profile at `wp-login.php`:

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --headed \
  --timeout 300000
```

After launching the command, tell the user that the dedicated login window is open. Ask them to sign in, select **Remember Me** when offered, close the browser window when finished, and then report that login is complete. Continue only after the browser has closed and this command's probe has completed.
An explicitly supplied `--timeout` also bounds this interactive session; if omitted, the session waits for the operator to close it.
The command follows the session with a wp-admin probe and reports `AUTHENTICATED` or `AUTH_REQUIRED`. Use `--headed` to allow showing the actual browser. Use `--headless` with `authenticate` and a somewhat short timeout only to receive an explicit error.

## Authentication recovery

If any command (`check-admin`, `check-editor`, or `snapshot-editor`) returns `AUTH_REQUIRED`:
Perform use the `authenticate` command again (make sure `--base-url` and `--profile` are correct). If this fails, stop and tell the user.

## check-admin

Check the admin shell:

```bash
node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --output-dir /tmp/wordpress-inspector/admin \
  --timeout 30000
```

`check-admin` verifies the wp-admin shell is accessible and you are logged in:

- Login form absent (`#loginform`)
- Login username control absent (`#user_login`)
- Admin shell visible (`#wpcontent`, `#wpbody`, or `#wpadminbar`)
- Browser diagnostics clear (console errors, failed requests, navigation failures)

## check-editor

Check the status of some Gutenberg content:

```bash
node scripts/wordpress_inspector.mjs check-editor \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/editor
```

`check-editor` only accepts the Gutenberg routes `post.php?action=edit&post=<positive-id>` and `site-editor.php`. It rejects arbitrary endpoints. The first version does not resolve post IDs, slugs, template IDs, or project-specific WordPress URLs; resolve those yourself (`find-post` may help).

`check-editor` performs full Gutenberg editor health checks:

- Login form/username absent (authentication verification)
- Editor shell visible (`.edit-post-visual-editor`, `.edit-site-visual-editor`, or `#editor`)
- Editor canvas visible (`.edit-post-visual-editor iframe`, `.edit-site-visual-editor iframe`, `.editor-styles-wrapper`, `.block-editor-writing-flow`, `.edit-site-visual-editor__editor-canvas`)
- Invalid block warning absent (`.block-editor-warning`)
- Block recovery prompt absent (`.block-editor-block-recovery`, `.block-editor-block-recovery__dialog`)
- Missing block placeholder absent (`.wp-block-missing`)
- Fatal editor error absent (`.editor-error`, `.block-editor-error-boundary`)
- Browser diagnostics clear (console errors, failed requests, navigation failures)

## Editor snapshots

Use `snapshot-editor` when you need machine-readable view to the of a Gutenberg page :

- post/page html source code of the page (the wordpress HTML source code with all the HTML comments thingy, not the frontend rendered HTML)
- an image of what the entire post/page looks like in the editor
- the block structure as a tree

```bash
node scripts/wordpress_inspector.mjs snapshot-editor \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/snapshot-editor
```

`snapshot-editor` only works with iframe-based Gutenberg. If it cannot find an accessible editor iframe, it exits non-zero with `EDITOR_IFRAME_NOT_FOUND`.

On success, the output directory contains:

```text
<output-dir>/
├── snapshot-editor/
│   ├── report.json
│   ├── rendered-iframe.png
│   ├── blocks.json
│   └── source.html
└── snapshot-editor.json
```

- `rendered-iframe.png` is a screenshot of the complete iframe document.
- `blocks.json` is the Gutenberg block tree from `wp.data.select('core/block-editor').getBlocks()`.
- `source.html` is the current post/page edited source returned by `wp.data.select('core/editor').getEditedPostContent()`; it is written as-is. A Site Editor page may not expose the source code editing view (`core/editor` source selector); in that case `snapshot-editor` reports `EDITOR_SOURCE_UNAVAILABLE`.
- `snapshot-editor.json` references these artifact files : `renderedIframe`, `blocks`, and `source` along with records sizes, dimensions, and a source hash.

### Classifications and artifacts

The check summary (`wordpress-summary.json`) and editor snapshot summary (`snapshot-editor.json`) contain :

- a normalized `targetType` (`authentication`, `wp-admin`, or `gutenberg-editor`)
- base/final URL
- profile name
- checks
- classification (result of the request)
- links to the generic report and screenshots
- named warnings (for example `invalid-block-warning`, `block-recovery-prompt`, `missing-block-placeholder`, or `fatal-editor-error`), and limitations.

Classification values:

- `AUTHENTICATED` — the expected shell/editor checks passed;
- `AUTH_REQUIRED` — WordPress returned a login route/form or equivalent expiry signal;
- `ADMIN_LOAD_FAILED` — authentication was not the primary signal, but the admin shell failed;
- `EDITOR_LOAD_FAILED` — the editor shell/canvas or fatal-error checks failed;
- `EDITOR_INVALID_BLOCKS` — the editor rendered but an invalid/missing/recovery indicator was present;
- `EDITOR_SNAPSHOT_CAPTURED` — `snapshot-editor` captured the iframe screenshot, block tree, and source successfully;
- `EDITOR_IFRAME_NOT_FOUND` — `snapshot-editor` requires an accessible iframe-based Gutenberg editor;
- `EDITOR_IFRAME_EMPTY` — the editor iframe was present but had no measurable document content;
- `EDITOR_DATA_UNAVAILABLE` — Gutenberg's block-editor data store was unavailable;
- `EDITOR_SOURCE_UNAVAILABLE` / `EDITOR_SOURCE_INVALID` — the single Gutenberg source selector could not provide a string;
- `TECHNICAL_ERRORS` — browser or network diagnostics failed.

Authentication expiry is reported separately.

## Safety and local-site workflow

`/tmp` for screenshots and reports unless the user requests another artifact location.
Do not use a personal browser profile.

## Validation

From this skill directory, run the fixture-based adapter smoke test:

```bash
node scripts/smoke_test.mjs
```

It uses a temporary local server and profile, proves authentication classification, healthy/invalid editor classification, iframe snapshot artifacts, no-iframe failure, same-origin enforcement, report redaction, and that no non-GET mutation request occurs. It removes its temporary artifacts. Run Web Inspector's own smoke and profile tests separately from `../web-inspector/`.
