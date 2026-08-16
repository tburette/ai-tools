---
name: wordpress-inspector
description: Inspect authorized WordPress administration and Gutenberg interfaces with a dedicated persistent Web Inspector profile. Use for read-only wp-admin checks, Gutenberg health checks, editor snapshots, authentication-expiry detection, and local WordPress QA; use web-inspector directly for ordinary public frontend inspection.
---

# WordPress Inspector

Use this skill for read-only inspection of an authorized WordPress site, its wp-admin shell, and an explicit Gutenberg editor URL. It is a thin WordPress adapter over the sibling `web-inspector` skill: browser launch, actions, screenshots, diagnostics, and low-level reports remain in Web Inspector.

The MVP is deliberately explicit and read-only. It never accepts passwords, submits content changes, saves, publishes, uploads, installs, activates, trashes, or resets WordPress data. A persistent browser profile contains bearer credentials; protect it like a password.

## Dependency and installation

The adapter resolves `../web-inspector` relative to this directory. It can also use a web-inspector in another directory with the environment variable `WEB_INSPECTOR_SKILL_DIR`:

```bash
WEB_INSPECTOR_SKILL_DIR=/path/to/web-inspector \
  node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test \
  --profile wp-local
```

If there is no valid `WEB_INSPECTOR_SKILL_DIR` and there is no sibling `../wordpress-inspector` directory report the problem to the user, ask him to install web-inspector.

A Web Inspector spawns with `process.execPath` and argument arrays. Each command writes a WordPress summary beside the underlying Web Inspector `report.json` and screenshots.

## Profile setup and authentication

Declare the profile in a Web Inspector configuration file before using it:

```json
{
  "version": 1,
  "defaults": { "headed": false },
  "profiles": {
    "wp-local": { "browser": "chromium" }
  }
}
```

Then run the interactive setup command. It always opens a dedicated headed Chromium profile at `wp-login.php`, never decides whether login succeeded, and never handles credentials:

```bash
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --config ~/.config/web-inspector/config.json \
  --timeout 300000
```

Sign in only in the visible dedicated window, then close it. If the WordPress login form offers **Remember Me**, select it. An explicitly supplied `--timeout` also bounds this interactive session; if omitted, the session waits for the operator to close it. The command follows the session with a read-only wp-admin probe and reports `AUTHENTICATED` or `AUTH_REQUIRED`. Use `--headless` with `authenticate` only to receive an explicit error; automated credential bootstrap is intentionally not part of the MVP.

The profile must be explicit. Do not infer it from a hostname, workspace, WordPress site, or login form. For local multisite work, use the exact authorized site URL, including its port and path. A network login does not imply that every child host is authenticated.

## Read-only checks

Check the admin shell:

```bash
node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --config ~/.config/web-inspector/config.json \
  --output-dir /tmp/wordpress-inspector/admin \
  --timeout 30000
```

Check an explicit Gutenberg editor URL from the same origin:

```bash
node scripts/wordpress_inspector.mjs check-editor \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/editor
```

`check-editor` rejects cross-origin URLs and only accepts the read-only Gutenberg routes `post.php?action=edit&post=<positive-id>` and `site-editor.php`. It rejects arbitrary same-origin admin endpoints so a caller cannot accidentally send the browser to a mutation-capable route. The first version does not resolve post IDs, slugs, template IDs, or project-specific WordPress URLs; resolve those read-only in the project and pass the resulting URL explicitly.

The adapter checks structural, locale-resistant signals:

- login route/form absence and wp-admin shell visibility;
- Gutenberg editor shell and canvas visibility;
- invalid/unexpected block warnings;
- missing/unsupported block placeholders;
- block recovery prompts;
- editor-level fatal-error indicators;
- console errors, uncaught page errors, failed requests/responses, navigation failures, and screenshots from Web Inspector.

It may dismiss a visible onboarding close control, but it never clicks mutation controls. A check returning HTTP 200 is not enough to establish editor health.

## Editor snapshots

Use `snapshot-editor` when you need the current editor contents as machine-readable artifacts rather than only a health classification:

```bash
node scripts/wordpress_inspector.mjs snapshot-editor \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/snapshot-editor
```

The command is intentionally limited to iframe-based Gutenberg. If it cannot find an accessible editor iframe, it exits non-zero with `EDITOR_IFRAME_NOT_FOUND`; it does not fall back to the older non-iframe canvas.

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

`rendered-iframe.png` is a screenshot of the complete iframe document, including content below the normal scroll viewport. The collector captures fixed-height viewport tiles while scrolling the iframe, stitches them into one PNG, and restores the original scroll position; it does not resize the editor or its ancestors. `blocks.json` is the recursively collected Gutenberg block tree from `wp.data.select('core/block-editor').getBlocks()`. `source.html` is the current post/page edited source returned by `wp.data.select('core/editor').getEditedPostContent()`; it is written as-is and is not reconstructed from the block tree. The URL validator also accepts the Site Editor for `check-editor`, but a Site Editor page may not expose the `core/editor` source selector; in that case `snapshot-editor` reports `EDITOR_SOURCE_UNAVAILABLE` rather than silently switching to another source method.

The snapshot summary references these files under an `artifacts` object and records sizes, dimensions, and a source hash without embedding the page content. Treat the HTML, block attributes, and screenshot as potentially sensitive site content.

## Classifications and artifacts

The check summary (`wordpress-summary.json`) and editor snapshot summary (`snapshot-editor.json`) contain a normalized `targetType` (`authentication`, `wp-admin`, or `gutenberg-editor`), base/final URL, profile name, checks, classification, links to the generic report and screenshots, named warnings (for example `invalid-block-warning`, `block-recovery-prompt`, `missing-block-placeholder`, or `fatal-editor-error`), and limitations. Snapshot summaries additionally reference `renderedIframe`, `blocks`, and `source` artifacts. They intentionally omit profile paths, cookies, storage values, authorization headers, usernames, passwords, and filled form values.

Classifications are:

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

Authentication expiry is reported separately from a product regression. Rerun `authenticate` for the same explicit site/profile; the adapter never submits credentials automatically.

## Safety and local-site workflow

Keep profile state under Web Inspector's owner-only state root, outside repositories and output directories. Use `/tmp` for screenshots and reports unless the user requests another artifact location. Do not commit screenshots or profile state. Do not use a personal browser profile, and do not use these Chromium sessions as general browsing profiles (`--no-sandbox` reduces process isolation).

Before a local check, verify that the authorized WordPress environment is already running. Do not edit its project files. A multisite site is an explicit base URL; do not hop to another child host unless it is separately authorized.

## Validation

From this skill directory, run the fixture-based adapter smoke test:

```bash
node scripts/smoke_test.mjs
```

It uses a temporary local server and profile, proves authentication classification, healthy/invalid editor classification, iframe snapshot artifacts, no-iframe failure, same-origin enforcement, report redaction, and that no non-GET mutation request occurs. It removes its temporary artifacts. Run Web Inspector's own smoke, configuration, and profile tests separately from `../web-inspector/`.
