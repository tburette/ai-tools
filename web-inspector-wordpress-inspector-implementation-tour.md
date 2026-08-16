# Web Inspector and WordPress Inspector — implementation tour

**Status:** implemented and validated on 2026-08-16
**Audience:** people using the skills, agents invoking them, and maintainers extending them

This document describes the completed work behind persistent Web Inspector profiles and the new read-only WordPress/Gutenberg Inspector. It is a companion to the implementation plan: it describes what is available now, rather than proposing future work.

## At a glance

Two independently usable skills now work together:

1. **Web Inspector** remains a generic Playwright renderer and interaction harness. It gained explicit persistent Chromium profiles, configuration, headed sessions, and two generic actions needed by higher-level adapters.
2. **WordPress Inspector** is a new, read-only adapter over Web Inspector. It knows how to inspect an authenticated WordPress admin area and Gutenberg editor without submitting content changes or using credentials from the command line.

The implementation deliberately keeps browser mechanics in `web-inspector/` and WordPress behavior in `wordpress-inspector/`. This preserves a reusable generic tool while giving WordPress checks the application-specific rules they need.

## What changed for a user or an agent

### Ordinary Web Inspector use still works

Existing no-profile captures keep their original isolation model: they are headless by default, use a fresh browser context for each viewport, and retain no browser state after exit.

```bash
cd web-inspector
node scripts/capture_page.mjs http://localhost:3000/ \
  --viewport 1440x1100 \
  --output-dir /tmp/web-inspector/page
```

The usual screenshots and `report.json` are produced. The report now also says whether the run was headed, which profile name was used, and whether it used a persistent context.

### Persistent login state is explicit and opt-in

An operator first declares a profile in Web Inspector configuration:

```json
{
  "version": 1,
  "defaults": { "headed": false },
  "profiles": {
    "wp-local": { "browser": "chromium" }
  }
}
```

Then the profile can be reused for normal captures:

```bash
node scripts/capture_page.mjs http://example.test:8888/ \
  --profile wp-local \
  --config ~/.config/web-inspector/config.json \
  --output-dir /tmp/web-inspector/profile-check
```

No profile is inferred from a URL, project, workspace, or page contents. This avoids surprising state sharing and makes authenticated checks deliberate.

### Interactive authentication has a dedicated workflow

For a site that requires login, use the visible persistent-profile command rather than passing credentials to a script:

```bash
cd wordpress-inspector
node scripts/wordpress_inspector.mjs authenticate \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --config ~/.config/web-inspector/config.json
```

It opens a dedicated Chromium window at WordPress login. The operator enters credentials interactively, closes the window, and the command performs a read-only admin probe. `--timeout <ms>` can close the interactive window automatically; otherwise it waits for the operator.

The tool never accepts a username or password as an option, config value, report field, or process argument.

### WordPress admin and editor checks are now available

Check the admin shell:

```bash
node scripts/wordpress_inspector.mjs check-admin \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --config ~/.config/web-inspector/config.json \
  --output-dir /tmp/wordpress-inspector/admin
```

Check a specific Gutenberg editor URL:

```bash
node scripts/wordpress_inspector.mjs check-editor \
  --base-url http://example.test:8888 \
  --profile wp-local \
  --editor-url 'http://example.test:8888/wp-admin/post.php?post=123&action=edit' \
  --output-dir /tmp/wordpress-inspector/editor
```

Each WordPress command writes:

- `wordpress-summary.json` — a concise result for people and agents;
- the underlying Web Inspector `report.json` — browser diagnostics and action results;
- one or more PNG screenshots.

The primary classifications are `AUTHENTICATED`, `AUTH_REQUIRED`, `ADMIN_LOAD_FAILED`, `EDITOR_LOAD_FAILED`, `EDITOR_INVALID_BLOCKS`, and `TECHNICAL_ERRORS`.

### New generic actions are available to every Web Inspector consumer

| Action | Purpose |
| --- | --- |
| `assertNotVisible` | Fails if **any** matching element is visible during a short assertion window (250 ms by default). It is useful for warnings, overlays, and error indicators that appear slightly after load. |
| `clickIfVisible` | Clicks the first visible matching element and reports `clicked: true`; otherwise succeeds with `clicked: false`. |

For example:

```bash
node scripts/capture_page.mjs http://localhost:3000/ \
  --action '{"type":"assertNotVisible","selector":".error-banner","windowMs":500}' \
  --action '{"type":"clickIfVisible","selector":".welcome-dialog [aria-label=Close]"}'
```

## Technical design and operational facts

### Component boundary

`web-inspector/` owns all generic concerns:

- Playwright discovery and browser executable resolution;
- Chromium and Firefox ephemeral captures;
- screenshots, reports, diagnostics, viewports, and device emulation;
- profile/configuration parsing and browser lifecycle;
- generic action execution.

`wordpress-inspector/` composes the generic scripts with `process.execPath` and argument arrays. It does not duplicate Playwright discovery or browser-launch logic. It owns WordPress URLs, selectors, classifications, safety rules, and WordPress-level result summaries.

### Configuration and precedence

Web Inspector reads a versioned JSON configuration in this order:

1. `--config <path>`;
2. `WEB_INSPECTOR_CONFIG`;
3. `${XDG_CONFIG_HOME}/web-inspector/config.json`;
4. `~/.config/web-inspector/config.json`.

A missing configuration file means built-in defaults, not an error. Invalid JSON, unsupported versions, unknown keys, bad types, bad profile names, and undeclared profile use fail clearly.

For headed behavior, precedence is:

1. CLI `--headed` or `--headless`;
2. `defaults.headed` in configuration;
3. built-in `false`.

Profiles are Chromium-only in this release. Firefox support remains available for ordinary ephemeral captures, but a Firefox profile request is rejected before launch.

### Profile state and security

Profile state resolves in this order:

1. `WEB_INSPECTOR_STATE_DIR`;
2. `${XDG_STATE_HOME}/web-inspector/profiles`;
3. `~/.local/state/web-inspector/profiles`.

A profile name is an identifier, not a path. The implementation creates owner-only directories where supported, rejects symlinked profile directories, redacts full profile paths from user-facing errors and reports, and gives a clear message if Chromium reports that a profile is already in use.

Persistent state can contain cookies, local storage, IndexedDB, and session data. Treat it as a bearer credential: keep it out of repositories and `/tmp`, do not share it casually, and do not use a personal browser profile.

### Browser lifecycle

The two code paths remain intentionally separate:

- **No profile:** launch a browser and create a fresh context for every requested viewport.
- **Named profile:** launch one Chromium persistent context, use it for the requested pages/viewports, then close it once so state is flushed.

The persistent Chromium path includes the browser setting needed to retain session cookies across CLI invocations. Reports expose the profile name and `persistentContext: true`, never the profile directory or stored values.

### Diagnostics and result semantics

Web Inspector continues to record console errors/warnings, uncaught page errors, failed requests, HTTP error responses, navigation errors, action failures, runtime data, a compact DOM summary, and screenshots.

WordPress Inspector performs a short structural authentication probe before expensive admin or editor readiness assertions. This means an expired session is classified quickly as `AUTH_REQUIRED` instead of waiting through editor timeouts. It treats action failures separately from genuine browser diagnostics, so an expected failed negative assertion does not become a misleading `page-error` warning.

When no generic report can be written, the WordPress summary marks checks as unknown and supplies a sanitized, actionable category such as an undeclared profile or unavailable Playwright runtime. It does not copy raw stderr that might reveal sensitive paths or page data.

### WordPress safety model

The WordPress adapter is read-only after authentication:

- it does not save, publish, update, trash, upload, install, activate, or reset;
- it never submits login credentials or mutation controls;
- it only dismisses a close control scoped to a known Gutenberg welcome guide;
- it stops editor/admin readiness checks once the authentication probe finds a login screen.

`check-editor` accepts only same-origin, supported editor routes:

- `wp-admin/post.php?action=edit&post=<positive-id>`;
- `wp-admin/site-editor.php` without an `action` parameter.

Arbitrary same-origin admin routes, mutation endpoints, cross-origin URLs, and duplicate `action` or `post` query parameters are rejected. This prevents a caller from accidentally navigating the read-only tool to a GET-based mutation endpoint.

### Installation and dependency lookup

In this repository, WordPress Inspector resolves the sibling `../web-inspector` directory. If the skills are installed separately, set `WEB_INSPECTOR_SKILL_DIR` explicitly. Keep the two source directories together when possible.

The runners only discover existing Playwright installations. They do not install npm dependencies or download a browser implicitly. On Linux, a headed interactive session requires `DISPLAY` or `WAYLAND_DISPLAY`; normal captures can remain headless.

Before copying or linking either skill into a host-managed directory such as `~/.codex` or an OpenCode directory, validate the source in this repository and obtain operator approval.

## Implementation tour by file

| Location | What it now provides |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Clearer repository map, source-of-truth rules, nested-instruction precedence, installation approval, validation, and sensitive-artifact guidance. |
| [`web-inspector/SKILL.md`](web-inspector/SKILL.md) | User-facing persistent-profile, headed-session, action, safety, and validation documentation. |
| [`web-inspector/scripts/capture_page.mjs`](web-inspector/scripts/capture_page.mjs) | Extended generic runner: config/profile options, headed mode, persistent Chromium lifecycle, richer report options, and the two new generic actions. |
| [`web-inspector/scripts/open_profile.mjs`](web-inspector/scripts/open_profile.mjs) | Visible, generic, persistent Chromium session for authorized interactive setup. |
| [`web-inspector/scripts/lib/config.mjs`](web-inspector/scripts/lib/config.mjs) | Versioned config validation, profile-name validation, config/state path resolution, and option precedence. |
| [`web-inspector/scripts/lib/profiles.mjs`](web-inspector/scripts/lib/profiles.mjs) | Owner-only profile directory creation, symlink rejection, and profile-lock error normalization. |
| [`web-inspector/scripts/lib/playwright.mjs`](web-inspector/scripts/lib/playwright.mjs) | Shared Playwright resolution, executable selection, local-host mapping, persistent-profile args, and headed-display checks. |
| [`web-inspector/scripts/config_smoke_test.mjs`](web-inspector/scripts/config_smoke_test.mjs) | Config lookup, schema, precedence, and profile declaration regression coverage. |
| [`web-inspector/scripts/profile_smoke_test.mjs`](web-inspector/scripts/profile_smoke_test.mjs) | Cross-process persistence, isolation, profile security, browser restriction, and secret-redaction coverage. |
| [`web-inspector/scripts/smoke_test.mjs`](web-inspector/scripts/smoke_test.mjs) | Existing smoke suite expanded for new report fields and delayed/duplicate negative-assertion behavior. |
| [`wordpress-inspector/SKILL.md`](wordpress-inspector/SKILL.md) | Complete WordPress workflow, installation, safety, classification, artifact, and validation guide. |
| [`wordpress-inspector/agents/openai.yaml`](wordpress-inspector/agents/openai.yaml) | Codex skill metadata. |
| [`wordpress-inspector/scripts/wordpress_inspector.mjs`](wordpress-inspector/scripts/wordpress_inspector.mjs) | `authenticate`, `check-admin`, and `check-editor` commands; probes, classifications, summaries, and read-only route enforcement. |
| [`wordpress-inspector/scripts/lib/web_inspector_process.mjs`](wordpress-inspector/scripts/lib/web_inspector_process.mjs) | Safe child-process invocation of the sibling Web Inspector scripts and report collection. |
| [`wordpress-inspector/scripts/lib/wordpress.mjs`](wordpress-inspector/scripts/lib/wordpress.mjs) | URL normalization, WordPress selectors, authentication detection, diagnostics filtering, and summary creation. |
| [`wordpress-inspector/scripts/smoke_test.mjs`](wordpress-inspector/scripts/smoke_test.mjs) | WordPress fixture coverage for authentication, onboarding, invalid blocks, fatal errors, technical failures, route safety, redaction, and no mutation requests. |
| [`web-inspector-wordpress-inspector-implementation-plan.md`](web-inspector-wordpress-inspector-implementation-plan.md) | Original design/acceptance record, updated to say what was implemented and what remains intentionally unverified. |

## Validation performed

The completed implementation was checked with:

```bash
# Syntax and whitespace
find web-inspector wordpress-inspector -name '*.mjs' -print0 | xargs -0 -n1 node --check
git diff --check

# Web Inspector
cd web-inspector
node scripts/config_smoke_test.mjs
node scripts/profile_smoke_test.mjs
node scripts/smoke_test.mjs
WEB_INSPECTOR_BROWSER=firefox node scripts/smoke_test.mjs

# WordPress Inspector
cd ../wordpress-inspector
node scripts/smoke_test.mjs
```

All of these passed. A review subagent also examined the finished work. Its findings were incorporated, including fixes for inherited profile-name lookup, config-path forwarding, profile security, authentication classification order, selector false positives, negative assertion behavior, technical-diagnostic classification, report failure handling, and editor-route safety.

## Authorized local WordPress integration

The implementation was also exercised against the authorized local network site:

- `check-admin` passed with `AUTHENTICATED`;
- the Home editor passed with `AUTHENTICATED`;
- the existing all-patterns review page passed with `AUTHENTICATED`;
- each check returned HTTP 200, had no reported console/page/request/response errors, and produced an inspected screenshot;
- no mutation controls were exercised;
- a repeat all-patterns editor check left the observed post modification timestamp unchanged.

The local environment had to be started with its authorized `npm run env:start` command. Its project files were not edited. Farm/child subsites were intentionally not checked because the authorized scope was the network site only.

## Limits and intentionally deferred work

- Persistent Firefox profiles are not supported; Firefox remains available for ephemeral captures.
- There is no automatic profile selection, credential vault, automatic reauthentication, or profile deletion command.
- WordPress Inspector does not resolve post IDs, slugs, templates, or project-specific targets. A caller must supply an allowed editor URL.
- The MVP is not a mutation-test framework, full accessibility auditor, visual-diff system, video recorder, or network mocker.
- A WordPress network login does not prove authentication on every child host; each authorized multisite host must be checked explicitly.
- Screenshots and reports may contain private administrative information. Keep them in a protected temporary location and do not commit them.

## Where to start

For normal browser work, start with [Web Inspector](web-inspector/SKILL.md). For authorized WordPress administration or Gutenberg checks, start with [WordPress Inspector](wordpress-inspector/SKILL.md), declare an explicit profile, authenticate interactively, then run the read-only checks.
