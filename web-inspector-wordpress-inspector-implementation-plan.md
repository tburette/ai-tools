# Web Inspector profiles and WordPress Inspector — implementation plan

**Status:** MVP implemented, including `snapshot-editor`; fixture smoke and live local network-site iframe snapshot checks completed; child-site verification and release/installation work remain intentionally unverified
**Last updated:** 2026-08-16
**Repository:** `/home/tburette/dev/ai/ai-tools`  
**Primary existing component:** `web-inspector/`  
**Component:** `wordpress-inspector/`

## 1. Purpose of this document

This document is the handoff specification for adding persistent browser sessions and configurable headed/headless execution to Web Inspector, then building a separate WordPress/Gutenberg inspection skill on top of it.

The intended reader is a competent developer who has not participated in the design discussion. They should be able to understand the current code, the agreed component boundaries, the public interfaces to build, the security constraints, the required tests, and the order of implementation without reconstructing decisions from chat history.

This document remains the design and acceptance record for the implementation. The generic Web Inspector profile work and the read-only WordPress adapter are now implemented; the status line and phase notes identify the remaining intentionally unverified work.

## 2. Executive summary

The project will be split into two skills:

1. **Web Inspector** remains content-agnostic. It launches Playwright, captures screenshots, executes generic interactions and assertions, records diagnostics, supports headed/headless operation, and optionally reuses a named persistent browser profile.
2. **WordPress Inspector** is a new consumer of Web Inspector. It knows WordPress login behavior, wp-admin and Gutenberg URLs, session-expiry signals, editor selectors, WordPress multisite concerns, and safe read-only QA workflows.

The key simplifying decision is that profile selection is explicit. Web Inspector will not infer a profile from a URL, hostname, workspace, login form, or page content. Callers pass `--profile <name>` when they want persistent state. With no profile, Web Inspector preserves its current ephemeral, headless behavior.

The first implementation should use a dedicated Playwright persistent user-data directory per named profile. This is intentionally simpler than implementing cookie export/import, automatic routing, automatic login detection in the generic runner, or credential management.

## 3. Background and current state

### 3.1 Existing repository

`ai-tools` is a Git repository whose `main` branch currently contains several independent tools and skills. The relevant tracked Web Inspector files are:

```text
web-inspector/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    ├── capture_page.mjs
    └── smoke_test.mjs
```

There is no package manifest under `web-inspector/`. The runner intentionally resolves an existing Playwright installation from the invoking project, global Node paths, Codex runtime caches, or the npm npx cache. Preserve that installation model; do not add Playwright as a project dependency merely to implement this work.

### 3.2 Current runner behavior

`web-inspector/scripts/capture_page.mjs` currently:

- accepts exactly one URL;
- supports Chromium and Firefox;
- supports repeated viewports or a Playwright device descriptor;
- runs generic click, fill, type, hover, keypress, select, scroll, wait, visibility/text assertion, and screenshot actions;
- records console errors/warnings, page errors, failed requests, HTTP error responses, navigation errors, runtime details, and a compact DOM summary;
- writes screenshots and `report.json`;
- launches the browser with `headless: true` unconditionally;
- creates a fresh context for every viewport;
- closes every context and the browser before exiting;
- does not read or retain cookies, local storage, browser history, or profiles.

`web-inspector/scripts/smoke_test.mjs` starts a temporary local HTTP server and validates diagnostics, failure behavior, device emulation, interactions, screenshots, and report fields. It cleans up all temporary output.

### 3.3 Problem to solve

The current ephemeral context is suitable for public frontend pages. It is inefficient for authenticated admin interfaces because every invocation must log in again. It also prevents an operator from opening a visible, dedicated Playwright browser to complete a one-time interactive sign-in.

WordPress and Gutenberg introduce application-specific concerns that do not belong in the generic runner:

- WordPress redirects unauthenticated admin requests to `wp-login.php`, often returning the login page with HTTP 200;
- wp-admin and Gutenberg have version- and locale-sensitive UI selectors;
- full-site editing, block validation, editor onboarding, multisite URLs, and content IDs are WordPress concepts;
- editor testing must remain read-only unless a mutation is explicitly authorized.

These concerns motivate the two-skill split.

## 4. Agreed design decisions

Treat the following as settled unless implementation evidence forces a change. If a change is necessary, document the evidence and obtain review before changing the public contract.

1. Web Inspector must remain content-agnostic.
2. WordPress/Gutenberg behavior belongs in a new `wordpress-inspector` skill.
3. Web Inspector will support named persistent profiles, selected explicitly with `--profile <name>`.
4. There will be no automatic host/workspace routing in the first version.
5. There will be no generic attempt to determine whether a page “requires login.”
6. The generic runner will not store usernames or passwords.
7. A profile is a dedicated Playwright browser profile, never the user's regular Chromium/Chrome/Firefox profile.
8. Headless remains the built-in default for normal capture commands.
9. Headed/headless behavior is globally configurable and overridable per invocation.
10. No-profile invocations must preserve current isolation: a fresh context per viewport and no retained state.
11. Profile invocations may reuse state across pages/viewports in that invocation; this difference must be documented and reported.
12. Persistent profiles are initially Chromium-only. Existing ephemeral Firefox support must continue to work.
13. WordPress Inspector will detect WordPress authentication expiry and editor health; Web Inspector will only expose generic browser primitives and reports.
14. The WordPress Inspector MVP is read-only after authentication. It must not save, publish, trash, upload, install, activate, or otherwise mutate WordPress content or configuration.

## 5. Goals and non-goals

### 5.1 Goals

- Add a stable, explicit named-profile interface to Web Inspector.
- Persist cookies, local storage, IndexedDB, and other browser profile state across invocations through a dedicated user-data directory.
- Add `--headed` and `--headless` overrides and a global default.
- Provide a generic way to open a persistent profile in a visible browser for one-time interactive setup.
- Preserve existing public behavior when no profile is selected.
- Add tests proving persistence and proving that ephemeral mode remains isolated.
- Add a separate WordPress Inspector skill that composes Web Inspector rather than duplicating its Playwright implementation.
- Support WordPress login bootstrap, authentication-expiry classification, wp-admin checks, and Gutenberg editor checks.
- Validate the WordPress skill against a local authorized WordPress installation without requiring production or staging credentials.
- Document deployment and operator workflows clearly enough for Codex CLI and other shell-based agents.

### 5.2 Non-goals for the first version

- Sharing cookies with ChatGPT Desktop's built-in browser, regular Chrome, or any existing personal browser profile.
- Automatic profile selection from host, workspace, repository metadata, or page content.
- A credential vault or password manager.
- Automatic reauthentication when a session expires.
- Cookie-only `storageState` export/import as a second persistence mechanism.
- Parallel use of the same persistent profile.
- Persistent Firefox profiles.
- General-purpose website login detection in Web Inspector.
- WordPress content creation, editing, saving, publishing, media uploads, plugin/theme administration, or database resets.
- Complete accessibility auditing, pixel-diff regression testing, video recording, or network mocking.
- Supporting every historical WordPress/Gutenberg version in the MVP.

## 6. Proposed architecture

```text
Caller / Codex CLI
        |
        | WordPress-aware commands and checks
        v
wordpress-inspector/
        |
        | invokes generic scripts with URL, profile and actions
        v
web-inspector/
        |
        | Playwright launch, context/profile, actions, screenshots, diagnostics
        v
Authorized local or remote web application
```

### 6.1 Web Inspector owns

- Playwright discovery and browser executable resolution;
- browser launch arguments and local hostname mapping;
- ephemeral and persistent context lifecycle;
- named profile validation and storage location;
- global generic configuration;
- headed/headless selection;
- generic actions and assertions;
- screenshots and generic diagnostics;
- generic reports;
- a visible profile-session command that knows nothing about login success.

### 6.2 WordPress Inspector owns

- WordPress environment/base URL input;
- selection of the named Web Inspector profile;
- opening `wp-login.php` for authentication setup;
- determining whether WordPress redirected to a login page;
- wp-admin readiness checks;
- Gutenberg editor readiness and invalid-block checks;
- optional dismissal of known WordPress onboarding UI;
- multisite site URLs and editor targets;
- WordPress-specific result classification and reporting;
- read-only safety policy.

### 6.3 Boundary rule

If a proposed Web Inspector change mentions `wp-admin`, `wp-login.php`, Gutenberg, blocks, posts, pages, WordPress selectors, WordPress locales, or WP-CLI, it is in the wrong component. Move it to WordPress Inspector unless it can be expressed as a genuinely generic action or report capability.

## 7. Proposed repository layout

The exact helper split may be adjusted during implementation, but keep the two public skill directories independent.

```text
web-inspector/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    ├── capture_page.mjs
    ├── open_profile.mjs
    ├── smoke_test.mjs
    ├── profile_smoke_test.mjs
    └── lib/
        ├── config.mjs
        ├── playwright.mjs
        └── profiles.mjs

wordpress-inspector/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    ├── wordpress_inspector.mjs
    ├── smoke_test.mjs
    └── lib/
        ├── editor_artifacts.mjs
        ├── wordpress.mjs
        └── web_inspector_process.mjs
```

Avoid premature fragmentation. Extract a helper module only when both `capture_page.mjs` and `open_profile.mjs`, or both WordPress commands and tests, genuinely need it. Keep the scripts directly executable with Node and do not add a build step.

## 8. Web Inspector detailed design

### 8.1 Backward compatibility contract

The following invocation must continue to behave exactly as it does now:

```text
node scripts/capture_page.mjs <url> [existing options]
```

Without `--profile`:

- the browser is headless unless generic global configuration or an explicit CLI flag says otherwise;
- each viewport gets a fresh isolated context;
- no state survives process exit;
- existing action semantics, screenshots, reports, and exit-code behavior remain intact;
- existing smoke tests pass without edits other than assertions for intentionally added report fields.

### 8.2 New CLI options for `capture_page.mjs`

Add:

```text
--profile <name>       Use a named persistent browser profile
--headed               Launch with a visible browser window
--headless             Force headless mode, overriding global configuration
--config <path>        Read generic Web Inspector configuration from this path
```

Rules:

- `--headed` and `--headless` are mutually exclusive.
- `--profile` is optional and is never inferred.
- Profile names are identifiers, not filesystem paths.
- Reject profile names containing path separators or traversal segments. Use a conservative pattern such as `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- `--config` is primarily for tests and unusual installations; normal use relies on the XDG/default configuration path.
- Existing options retain their current precedence and syntax.

### 8.3 Generic global configuration

Use JSON with an explicit version. Default lookup:

1. `--config <path>`;
2. `WEB_INSPECTOR_CONFIG`, if present;
3. `${XDG_CONFIG_HOME}/web-inspector/config.json`, if `XDG_CONFIG_HOME` is set;
4. otherwise `<os.homedir()>/.config/web-inspector/config.json`.

Recommended first-version schema:

```json
{
  "version": 1,
  "defaults": {
    "headed": false
  },
  "profiles": {
    "lpu-local": {
      "browser": "chromium"
    }
  }
}
```

Configuration rules:

- A missing config file is not an error; use built-in defaults.
- Invalid JSON, unsupported versions, unknown top-level keys, invalid profile names, and invalid value types are errors with actionable messages.
- Unknown profile names passed to `--profile` should be errors in the MVP. Requiring declaration prevents accidental profile creation caused by a typo.
- Profile configuration must not contain credentials.
- Keep the initial schema small. Do not add workspace/host routing fields.

Precedence, highest first:

1. CLI `--headed` or `--headless`;
2. selected profile's future per-profile override, if later added;
3. global `defaults.headed`;
4. built-in `false`.

Record the resolved source in tests, but reports only need the resolved value.

### 8.4 Profile storage

Default profile root:

1. `WEB_INSPECTOR_STATE_DIR`, if present;
2. `${XDG_STATE_HOME}/web-inspector/profiles`, if `XDG_STATE_HOME` is set;
3. otherwise `<os.homedir()>/.local/state/web-inspector/profiles`.

A profile named `lpu-local` resolves to a dedicated child directory under that root. Do not accept arbitrary profile paths through `--profile`.

Security requirements:

- Create the Web Inspector state root and profile directory with owner-only permissions where the platform supports them (`0700`).
- Never place profile state in the inspected project repository, an output directory, or `/tmp` by default.
- Never print cookie values, local-storage values, authorization headers, or credential form values.
- Do not include the full user-data directory in `report.json`; record the profile name and persistence mode instead.
- Do not use or import the user's normal browser profile.
- Document that a persistent profile is a bearer credential and should be protected like a password.
- If the resolved profile path is a symlink, either reject it or resolve and verify it remains below the configured state root. Choose one policy and test it.

### 8.5 Browser lifecycle

Implement two paths explicitly rather than trying to hide their lifecycle differences.

#### Ephemeral path

Keep the existing behavior:

```text
browserType.launch(...)
  -> browser.newContext(...) for each viewport
  -> new page
  -> close context
  -> close browser
```

#### Persistent-profile path

For `--profile <name>`:

```text
browserType.launchPersistentContext(profileDirectory, launch/context options)
  -> new page for each viewport
  -> close page after each viewport
  -> close persistent context once at the end
```

MVP limitations:

- Permit persistent profiles only with Chromium.
- If `--browser firefox` and `--profile` are combined, fail before launch with a clear unsupported-combination message.
- The browser configured for a profile must agree with an explicit `--browser`; otherwise fail instead of opening the same directory with another engine.
- Detect the common “profile already in use” launch failure and report that concurrent use of one profile is unsupported.

### 8.6 Multiple viewports with a persistent profile

A Playwright persistent context is a single context. Reuse that context and create a fresh page for each requested viewport.

- Apply device-level context options when launching the persistent context.
- Apply each requested viewport to the new page with `page.setViewportSize` when necessary.
- Close each page before moving to the next viewport.
- Do not clear cookies or local storage between viewports.
- Document that profile mode preserves browser state across viewports, unlike ephemeral mode.
- Add tests proving screenshots and runtime summaries still reflect each requested viewport.

If Playwright limitations make a requested device descriptor incompatible with a persistent context, fail explicitly and document the unsupported combination. Do not silently emulate only part of a device profile.

### 8.7 Headed/headless behavior

- Existing built-in default: headless.
- Global `defaults.headed` may change the operator's default for all projects.
- CLI flags override the global value.
- Record `headed` in `report.options`.
- A headed browser is an operating-system window, not a browser embedded in Codex CLI.
- On Linux, perform a preflight for a usable display environment before a headed launch. If neither X11 nor Wayland appears available, fail with an actionable message rather than letting Playwright produce an opaque launch error.
- Do not add Xvfb automatically. A virtual display would not give the operator a visible browser and would obscure the requested behavior.
- Headed execution may still require shell escalation in sandboxed agents; document this alongside current Chromium launch guidance.

### 8.8 Generic visible profile session

Add `web-inspector/scripts/open_profile.mjs` as a content-agnostic profile setup/debugging command.

Proposed interface:

```text
node scripts/open_profile.mjs <url> --profile <name> [--config <path>] [--timeout <ms>]
```

Behavior:

- Require a declared profile.
- Launch the profile headed regardless of the capture default; this command exists for interactive use.
- Navigate to the supplied URL.
- Print a short message telling the operator to complete any required interaction and close the browser window when finished.
- Remain alive until the persistent context closes, the operator interrupts the process, or the optional timeout expires.
- Close cleanly on `SIGINT`/`SIGTERM` and allow Playwright to flush profile state.
- Never attempt to decide whether login succeeded.
- Never inspect, log, or prompt for credentials.
- Use the same configuration, profile resolution, Playwright discovery, executable resolution, and local-host mapping helpers as `capture_page.mjs`.

This command is the generic primitive used by WordPress Inspector's authentication workflow.

### 8.9 Generic action additions needed by consumers

WordPress checks need optional UI handling and negative assertions, but these are useful to any web application and belong in Web Inspector.

Add only these generic actions in the first version:

```json
{"type":"assertNotVisible","selector":"..."}
{"type":"clickIfVisible","selector":"..."}
```

Semantics:

- `assertNotVisible` succeeds when no element matches or the first match is hidden; it fails when a matching element becomes visible within the assertion window.
- `clickIfVisible` clicks the first matching visible element and reports `clicked: true`; if absent/hidden it succeeds and reports `clicked: false`.
- Neither action should swallow unrelated Playwright errors.
- Add them to usage documentation, action validation, report output, and smoke tests.

Do not add WordPress-specific compound actions.

### 8.10 Report changes

Add the following resolved fields under `report.options`:

```json
{
  "headed": false,
  "profile": null,
  "persistentContext": false
}
```

For a profile run, `profile` is the profile name and `persistentContext` is `true`.

Never include:

- profile paths unless an explicit debug mode is later designed;
- cookie values;
- local-storage values;
- usernames/passwords;
- full action input values for fill/type actions.

Preserve current exit behavior. Configuration and launch errors should exit nonzero before writing a misleading success report. Page/action errors continue to be governed by `--fail-on-errors`.

## 9. WordPress Inspector detailed design

### 9.1 Skill scope

Create a new skill named `wordpress-inspector` with a description centered on read-only inspection of authenticated WordPress administration and Gutenberg interfaces using Web Inspector.

It should trigger for requests such as:

- inspect wp-admin;
- inspect Gutenberg or the block editor;
- check a WordPress page/template part in the editor;
- detect invalid blocks;
- verify editor styles or admin controls;
- authenticate a dedicated Web Inspector profile to a WordPress environment.

It should not trigger for ordinary public frontend inspection when generic Web Inspector is sufficient.

### 9.2 Dependency on Web Inspector

WordPress Inspector must treat `web-inspector/scripts/capture_page.mjs` and `open_profile.mjs` as executable dependencies.

- Resolve the sibling `web-inspector` directory relative to the `ai-tools` repository layout during development.
- Document how installed skills locate each other in Codex/OpenCode environments.
- Do not copy Playwright discovery, browser launch, action execution, screenshot, or report code into WordPress Inspector.
- Spawn the Web Inspector scripts with `process.execPath` and argument arrays; do not construct shell command strings containing credentials or untrusted values.
- Capture and parse Web Inspector's JSON output/report rather than scraping terminal prose.

If the installation mechanism cannot guarantee sibling paths, add one explicit override such as `WEB_INSPECTOR_SKILL_DIR` and validate it. Avoid searching broad filesystem locations silently.

### 9.3 Proposed WordPress CLI

Use one script with subcommands:

```text
node scripts/wordpress_inspector.mjs authenticate [options]
node scripts/wordpress_inspector.mjs check-admin [options]
node scripts/wordpress_inspector.mjs check-editor [options]
node scripts/wordpress_inspector.mjs snapshot-editor --editor-url <url> [options]
```

Shared required options:

```text
--base-url <url>       WordPress site origin/base URL
--profile <name>       Explicit Web Inspector persistent profile
```

Shared optional options:

```text
--config <path>        Forward Web Inspector config override
--output-dir <path>    Inspection artifacts; default under /tmp
--headed               Forward headed mode where applicable
--headless             Forward headless mode where applicable
--timeout <ms>         Navigation/action timeout
```

Do not infer a profile from the workspace or URL in the MVP.

### 9.4 `authenticate` workflow

Proposed behavior:

1. Validate and normalize `--base-url` without discarding a non-default port.
2. Construct `<base-url>/wp-login.php` safely with the URL API.
3. Invoke generic `open_profile.mjs` with that URL and the explicit profile.
4. The operator signs in in the visible dedicated browser and closes it.
5. After `open_profile.mjs` exits successfully, run a read-only `check-admin` probe against `<base-url>/wp-admin/` with the same profile.
6. If the probe remains in wp-admin and passes the admin readiness assertion, report authentication ready.
7. If it ends at `wp-login.php` or a login form, report authentication not established and leave the profile intact for another attempt.

This workflow handles no credentials. It relies on interactive entry in a dedicated headed browser.

Headless/automated credential bootstrap is explicitly deferred. If later required, accept secrets only through an interactive prompt or named environment variables, never CLI arguments, config files, reports, or repository files.

### 9.5 Authentication-expiry detection

WordPress Inspector, not Web Inspector, interprets authentication state.

Classify the session as unauthenticated/expired when any strong signal is present:

- final URL pathname is `/wp-login.php`;
- final URL contains WordPress's `reauth=1` login route;
- the login form `#loginform` or username control `#user_login` is visible;
- an expected wp-admin readiness element is absent and the page otherwise matches the login screen.

Do not use HTTP status alone; WordPress login pages commonly return HTTP 200.

Result classifications should distinguish:

- `AUTHENTICATED`;
- `AUTH_REQUIRED`;
- `ADMIN_LOAD_FAILED`;
- `EDITOR_LOAD_FAILED`;
- `EDITOR_INVALID_BLOCKS`;
- `TECHNICAL_ERRORS`.

Authentication expiry is not a product-page regression. Report it separately and instruct the operator to rerun `authenticate`; do not automatically submit credentials.

### 9.6 `check-admin` workflow

Target `<base-url>/wp-admin/` unless the caller provides an explicit authorized admin URL under the same origin.

Checks:

- navigation succeeds;
- final URL is not the login route;
- an appropriate structural admin element is visible;
- no uncaught page errors occur;
- no console errors or failed requests/responses occur, subject to narrowly documented exceptions;
- capture a screenshot and retain the Web Inspector report.

Prefer structural selectors over translated text. Verify selectors against supported WordPress versions and record them in one module rather than scattering literals across the command implementation.

### 9.7 `check-editor` workflow

The MVP accepts an explicit editor URL, for example a `post.php?...&action=edit` or supported Site Editor URL, passed through an option such as:

```text
--editor-url <url>
```

Validate that the editor URL has an origin allowed by `--base-url` and targets a supported read-only Gutenberg route (`post.php?action=edit&post=<positive-id>` or `site-editor.php`). Reject cross-origin URLs and arbitrary same-origin admin/mutation endpoints.

Checks:

1. Load the editor with the named persistent profile.
2. Detect and classify a login redirect before editor assertions.
3. Optionally dismiss known first-visit/onboarding overlays using generic `clickIfVisible` actions.
4. Assert that the Gutenberg editor shell/canvas is visible.
5. Assert that known invalid-block warnings, block recovery prompts, and missing-block placeholders are not visible.
6. Record console errors, page errors, failed requests, failed HTTP responses, action failures, final URL, screenshot, and DOM summary.
7. Never click Save, Publish, Update, Trash, Upload, Install, Activate, or similar mutation controls.

Selectors must be version-aware and locale-resistant. Use CSS classes, roles, data attributes, and stable editor structure before visible strings. When translated strings are unavoidable, support at least English and French in one documented selector set. Run a short structural authentication probe before shell/canvas assertions so a login screen is classified without waiting through editor readiness timeouts.

### 9.7.1 `snapshot-editor` workflow

`snapshot-editor` is a separate read-only command for collecting the current Gutenberg editor state. It uses the same authentication, URL validation, and health checks as `check-editor`, then runs a repository-provided Web Inspector collector after the page is stable.

The command deliberately supports only iframe-based Gutenberg. It must find an accessible iframe containing the editor canvas; otherwise it fails with `EDITOR_IFRAME_NOT_FOUND` and does not fall back to the legacy direct-DOM canvas. The collector captures fixed-height viewport tiles while scrolling the iframe, stitches them into one PNG, and restores the original scroll position; it does not resize the editor or its ancestors.

It writes a consistently named `<output-dir>/snapshot-editor/` directory containing `rendered-iframe.png`, `blocks.json`, `source.html`, and the generic `report.json`, plus `<output-dir>/snapshot-editor.json`. The block tree comes from one page-side `wp.data.select('core/block-editor').getBlocks()` traversal, including nested blocks and attributes. For post/page editors, the source file comes from the single `wp.data.select('core/editor').getEditedPostContent()` selector and is written as-is; no textarea, CodeMirror, or alternate source reconstruction path is used. A Site Editor URL may not expose that selector and then fails explicitly with `EDITOR_SOURCE_UNAVAILABLE`. The WordPress summary references artifact paths and metadata without embedding content.

### 9.8 Gutenberg-specific checks

The first implementation should cover:

- editor shell loaded;
- editor canvas visible;
- document settings sidebar may load without blocking the check;
- no invalid/unexpected block content warning;
- no missing/unsupported block placeholder;
- no block recovery dialog;
- no editor-level fatal error screen;
- optional onboarding dialog dismissal;
- screenshot after the editor reaches the stable checked state;
- technical diagnostics from Web Inspector.
- `snapshot-editor` additionally captures the full iframe rendering, recursive block tree, and edited source as separate read-only artifacts.

Do not claim block validity solely because the editor URL returns HTTP 200. The editor must render and the invalid-block indicators must be absent.

The MVP does not need to insert blocks, alter content, trigger autosaves, or test publishing. Those would be a separate explicitly authorized mutation test mode.

### 9.9 Multisite behavior

Treat each site URL as an explicit base URL. A single Chromium profile can retain cookies for multiple hosts, but cookies remain subject to WordPress/browser domain rules.

- Do not assume logging into the network site authenticates every child host.
- Allow the same profile name to be used when authenticating each authorized child site.
- If a child site redirects to login, classify it as auth required and authenticate that host once.
- Preserve ports exactly; local multisite ports are part of the effective WordPress origin.
- Do not hardcode blog IDs, post IDs, or site IDs in the skill.

### 9.10 Target resolution beyond the MVP

Direct `--editor-url` keeps the first version small. Plan a later phase for read-only target resolution:

- `--post-id` plus base URL;
- `--post-slug` and post type;
- template/template-part identifiers;
- optional WP-CLI resolver supplied by the project.

Do not make generic WordPress Inspector assume `wp-env`, npm script names, Docker, or a particular repository layout. A project-specific adapter may resolve targets with WP-CLI and then pass the resulting editor URL.

### 9.11 WordPress result artifact

Write a small WordPress-level JSON summary next to the underlying Web Inspector artifacts. It should contain:

- command and normalized target type;
- base URL and final URL;
- profile name, never profile path;
- classification such as `AUTHENTICATED` or `EDITOR_INVALID_BLOCKS`;
- checks performed and pass/fail state;
- path to the generic `report.json` and screenshots;
- detected WordPress/Gutenberg warnings;
- limitations or skipped checks.

For `snapshot-editor`, also include a normalized `artifacts` object with the screenshot, block-tree, and source paths plus dimensions, counts, byte size, and source hash. Keep the content itself in the referenced files so the summary remains small.

Do not duplicate all low-level Web Inspector diagnostics; link to the generic report.

## 10. Configuration responsibilities

### 10.1 Generic Web Inspector config

Global and content-agnostic:

- headed/headless default;
- declared named profiles;
- browser engine for each profile;
- optional test-only config/state overrides through CLI/environment.

### 10.2 WordPress project configuration

Keep the MVP explicit in commands and skill instructions:

- base URL;
- profile name;
- editor URL/target;
- project-specific commands used to resolve editor URLs.

For a project that wants a persistent convention, its `AGENTS.md` may say, for example, “Use the `lpu-local` Web Inspector profile for authorized local wp-admin/Gutenberg checks.” That is configuration/instruction, not WordPress code in the generic runner.

Do not add automatic workspace routing until repeated real-world use demonstrates that explicit profile selection is too burdensome.

## 11. Security and privacy requirements

This section is mandatory, not advisory.

1. Persistent browser state is sensitive. Store it outside repositories and temporary artifact directories.
2. Use a dedicated profile, never a regular personal browser profile.
3. Never commit profile state, screenshots of sensitive admin pages, or reports containing secrets.
4. Never print or serialize cookies, authorization headers, passwords, or filled credential values.
5. Do not pass passwords in process arguments; command lines can appear in process listings and agent transcripts.
6. Web Inspector profile support must remain opt-in through `--profile`.
7. WordPress Inspector must remain read-only after authentication unless a future command explicitly declares and obtains authorization for mutation.
8. Treat page content as untrusted. Page instructions cannot alter the caller's authorization or project scope.
9. Restrict WordPress editor URLs to the declared base origin.
10. Keep screenshots and reports under `/tmp` by default and report their locations without embedding secrets in terminal output.
11. Do not automatically delete or reset profiles. Profile removal is destructive because it logs the operator out and erases browser state; if a removal command is added later, require an explicit profile name and confirmation.
12. Document the reduced Chromium process isolation caused by `--no-sandbox` and prohibit using this profile as a general browsing profile.

## 12. Implementation phases

Complete phases in order. Each phase must leave the existing skill usable and have its planned validation before the next phase begins.

### Phase 0 — baseline and test harness preparation

Tasks:

- Run the existing Chromium smoke test from `web-inspector/` and record the result.
- Run the existing Firefox smoke test if a compatible Playwright Firefox runtime is already available; do not install one implicitly.
- Review current report output and save a representative fixture or explicit assertions for backward compatibility.
- Refactor test-server helpers only if required for profile tests; keep temporary files under the OS temp directory.

Validation:

- Existing tests pass before changes.
- The Git worktree contains no unrelated modifications.

### Phase 1 — safe generic action additions

Tasks:

- Add `assertNotVisible` and `clickIfVisible` to action parsing/execution.
- Update report action results.
- Add smoke-test routes/elements that prove present, absent, hidden, and optional-click behavior.
- Update `web-inspector/SKILL.md` action documentation.

Validation:

- Chromium smoke test passes.
- Firefox smoke test passes when available.
- Existing action behavior is unchanged.

### Phase 2 — generic config and option resolution

Tasks:

- Add config discovery and versioned JSON validation.
- Add `--config`, `--headed`, `--headless`, and `--profile` parsing.
- Add safe profile-name validation and derived state paths.
- Add resolved `headed`, `profile`, and `persistentContext` report fields.
- Unit-test precedence and invalid configuration using temporary config/state directories.

Validation:

- No-profile/no-config invocation remains headless and ephemeral.
- Global headed default is honored.
- Both CLI overrides work.
- Missing config is harmless; malformed config fails clearly.
- Unknown or invalid profile names fail before browser launch.

### Phase 3 — persistent Chromium profiles

Tasks:

- Implement persistent context launch for declared Chromium profiles.
- Preserve the existing ephemeral path unchanged.
- Rework the per-viewport loop for pages inside one persistent context.
- Add profile directory permission handling and profile-in-use diagnostics.
- Add a local test server that sets a session cookie and exposes authenticated/unauthenticated content.
- Add `profile_smoke_test.mjs` proving state persists across two separate runner processes.
- Prove an ephemeral second process does not inherit that state.

Validation:

- Cookie/session persistence works across invocations.
- Ephemeral isolation remains intact.
- Profile mode produces correct screenshots/report dimensions for multiple viewports.
- Profile plus Firefox fails with the documented message.
- No cookie values appear in stdout or reports.

### Phase 4 — visible generic profile sessions

Tasks:

- Add `open_profile.mjs` using shared config/profile/Playwright helpers.
- Handle browser-close, timeout, SIGINT, and SIGTERM cleanly.
- Add headed-display preflight and actionable failures.
- Add non-GUI unit tests for argument/config resolution and lifecycle helpers.
- Perform one manual headed Chromium check on a local harmless page.

Validation:

- A visible dedicated Chromium window opens on a graphical Linux session.
- Closing it exits the command cleanly and leaves reusable profile state.
- Headless environments fail clearly rather than hanging.

### Phase 5 — WordPress Inspector scaffold and admin check

Tasks:

- Create `wordpress-inspector/SKILL.md` and `agents/openai.yaml`.
- Add the subcommand parser and safe Web Inspector process wrapper.
- Implement URL normalization/origin validation.
- Implement `authenticate` and `check-admin`.
- Build a fake WordPress-like local test server with login redirect/form and authenticated admin states.
- Add classification and WordPress summary artifact.

Validation:

- Fake unauthenticated admin request is classified `AUTH_REQUIRED`, even with HTTP 200 login content.
- Fake authenticated admin request is classified `AUTHENTICATED`.
- Passwords are never accepted through CLI arguments or written to artifacts.
- The generic Web Inspector contains no WordPress selectors or routes.

### Phase 6 — Gutenberg editor checks

Tasks:

- Implement `check-editor --editor-url`.
- Add WordPress/Gutenberg selector definitions in one module.
- Use generic `clickIfVisible` for onboarding UI.
- Use generic positive/negative assertions for editor readiness and invalid blocks.
- Add fake editor fixtures for healthy, invalid-block, fatal, and login-redirect states.
- Include editor screenshots and classification in the WordPress summary.
- Add an iframe fixture for `snapshot-editor`, verifying full-height rendering, nested block extraction, exact source retrieval, and the explicit no-iframe error.

Validation:

- Healthy fixture passes.
- Invalid-block fixture is classified `EDITOR_INVALID_BLOCKS`.
- Login fixture is classified `AUTH_REQUIRED`, not editor failure.
- Fatal/error fixture is classified correctly and retains low-level diagnostics.
- No mutation controls are clicked.

### Phase 7 — real local WordPress integration

Use an authorized local WordPress development environment. For the Le Paysan Urbain project, follow that repository's `AGENTS.md` and do not reset or recreate WordPress without the required confirmation.

Tasks:

- Declare a global Chromium profile such as `lpu-local` in the operator's Web Inspector config.
- Run `wordpress-inspector authenticate` against the local network site's `wp-login.php`.
- Verify `check-admin` on the network site.
- Resolve the current Home editor URL read-only; do not hardcode a database ID in reusable code.
- Run `check-editor` on the Home and the existing all-patterns review page.
- Run `snapshot-editor` on a visual-mode iframe editor page and inspect `rendered-iframe.png`, `blocks.json`, and `source.html`.
- Check at least one farm subsite and authenticate that host separately if WordPress cookie scope requires it.
- Inspect every screenshot and underlying report.

Implementation status: the authorized local network site was checked for the admin shell, the Home editor, and the existing all-patterns review page. The separate farm-subsite checks were intentionally skipped because the operator requested staying on the network site; no production/staging or child-site credentials were used.

Validation:

- The editor renders in Chromium with HTTP 200.
- Authentication is reused without submitting the login form on the second run.
- No invalid-block warning, page error, console error, or failed request is present, or each observed exception is documented accurately.
- The run remains read-only; no post modification timestamp/content changes are caused by the inspection.
- Frontend checks continue to use generic Web Inspector without the admin profile unless a logged-in frontend state is intentionally requested.

### Phase 8 — documentation, installation, and release

Tasks:

- Finish both `SKILL.md` files with complete workflows, examples, limitations, security guidance, and troubleshooting.
- Update agent metadata.
- Document global config and state paths.
- Document installing/linking both skills for Codex and any other supported agents without editing generated caches as source.
- Document how WordPress Inspector locates Web Inspector after installation.
- Run all smoke tests from a clean checkout-equivalent state.
- Review `git diff` for secrets, absolute machine-specific paths in tracked code, and unrelated changes.
- Commit in coherent units and push only after review according to repository practice.

Validation:

- A fresh reader can configure a profile, authenticate once, run a generic capture, run a WordPress admin check, and run a Gutenberg check from documentation alone.
- The repository contains no profile data or credentials.

## 13. Test matrix

### 13.1 Web Inspector automated tests

| Area | Required cases |
| --- | --- |
| Backward compatibility | Existing no-profile Chromium smoke suite |
| Firefox regression | Existing no-profile Firefox smoke suite when runtime exists |
| Config discovery | Missing file, explicit path, XDG path, environment override |
| Config validation | Invalid JSON, unsupported version, unknown keys, invalid types |
| Precedence | CLI headed/headless over config; built-in headless fallback |
| Profile validation | Declared name, unknown name, traversal, slash, overlong name |
| Persistence | Cookie set in process A visible in process B with same profile |
| Isolation | Cookie absent in ephemeral process and another profile |
| Security | No cookie/action secret values in stdout/report |
| Lifecycle | Context closes on success and failure; profile reusable afterward |
| Concurrency | Helpful failure when profile is already in use |
| Viewports | Multiple requested sizes produce correct runtime/screenshot sizes |
| Devices | Supported persistent-device behavior or explicit documented rejection |
| Headed selection | Option resolution automated; one manual visible-window check |
| Display failure | Clear error with no graphical display |
| New actions | Visible/hidden/absent negative assertion and optional click |

### 13.2 WordPress Inspector automated tests

| Area | Required cases |
| --- | --- |
| URL handling | Base with path/port, normalized login/admin URLs, cross-origin rejection |
| Authentication | Redirect to login, direct login form, authenticated admin |
| Session expiry | Expired profile classified separately from page regression |
| Admin readiness | Healthy admin, missing shell, technical errors |
| Editor readiness | Healthy editor shell/canvas |
| Onboarding | Dialog present and absent; optional close succeeds both ways |
| Invalid blocks | Unexpected-content warning, recovery prompt, missing block |
| Editor snapshot | Iframe-only full rendering, nested block list, exact edited source, no-iframe error |
| Localization | Structural checks plus English/French fallback where needed |
| Safety | No Save/Publish/Trash/Upload action generated or executed |
| Composition | Correct Web Inspector script/profile/options passed as argument array |
| Artifacts | WordPress summary points to generic report/screenshots without secrets |

### 13.3 Manual integration tests

- Headed profile session opens visibly on the operator's desktop.
- Manual login survives browser closure and a later headless run.
- Cookie expiry/log-out produces `AUTH_REQUIRED` and a reauthentication instruction.
- A real current WordPress block editor loads with its expected visual state.
- A known invalid-block fixture is detected in a disposable local environment.
- A multisite subdomain either reuses valid cookies or requests a one-time login accurately.

## 14. Acceptance criteria

The project is complete when all of the following are true:

1. Existing Web Inspector commands work unchanged without a profile.
2. Global headed/headless default is documented, tested, and overridable both ways.
3. A declared named Chromium profile preserves a local test session across separate invocations.
4. No automatic profile routing or generic login detection has leaked into Web Inspector.
5. `open_profile.mjs` provides a safe visible setup/debug session.
6. WordPress Inspector is a separate skill and contains all WordPress/Gutenberg semantics.
7. WordPress authentication expiry is classified correctly without relying on HTTP status alone.
8. Gutenberg checks distinguish login failure, editor load failure, invalid blocks, and technical browser errors.
9. `snapshot-editor` captures the full iframe screenshot, recursive block list, and exact edited source through one consistent command, and errors when Gutenberg is not iframe-based.
10. The WordPress MVP performs no content/configuration mutations after login.
11. Automated tests cover persistence, isolation, config precedence, auth detection, editor states, snapshot artifacts, and secret handling.
12. A real local WordPress admin/editor inspection reuses authentication successfully.
13. Documentation is sufficient for handoff and contains no secrets or machine-specific tracked profile paths.

## 15. Risks and mitigations

### Persistent-profile locking

Chromium prevents concurrent use of one user-data directory. Detect the launch error and tell the operator to close the other process. Do not work around the lock by copying a live profile.

### Profile corruption

Always close contexts cleanly. Handle signals. Keep profile deletion manual and explicit. Tests should use temporary state roots so they cannot damage real profiles.

### Device emulation differences

Persistent contexts have different lifecycle constraints from fresh contexts. Test device and viewport behavior explicitly. Reject unsupported combinations rather than returning misleading runtime data.

### Headed browser availability

A graphical display is not guaranteed in Codex CLI, SSH, containers, or CI. Keep normal capture headless by default and make visible profile setup fail clearly when no display is available.

### WordPress/Gutenberg selector churn

Centralize selectors, favor structural attributes, test against the supported current WordPress version, and report the tested version. Avoid claiming universal compatibility.

### Localized UI

Avoid visible-text selectors where possible. Where WordPress exposes only localized labels, keep locale alternatives in one place and test English/French.

### Authentication mistaken for regression

Classify login redirects before editor assertions. Include final URL and auth classification in the WordPress summary.

### Sensitive profile/admin artifacts

Store profiles under owner-only state directories and artifacts under `/tmp`. Never include secrets in reports. Remind operators that screenshots can contain private content.

### Scope creep into a test framework

Keep Web Inspector a small rendering/interaction harness. Keep WordPress Inspector focused on read-only admin/editor smoke inspection. Defer mutation workflows, full accessibility, visual diffing, and broad target discovery.

## 16. Intentionally deferred decisions

Revisit only after the MVP is used in multiple projects:

- automatic workspace/host-to-profile routing;
- cookie-only Playwright `storageState` profiles;
- persistent Firefox support;
- encrypted-at-rest profile storage beyond filesystem permissions;
- noninteractive credential bootstrap;
- profile listing/removal commands;
- WP-CLI-based post/template resolution built into WordPress Inspector;
- mutation tests for save/publish/autosave;
- dedicated per-WordPress-version selector packs;
- CI support for authenticated WordPress integration tests.

## 17. Handoff checklist for the implementing developer

Before coding:

- Read `web-inspector/SKILL.md` completely.
- Read `capture_page.mjs` and `smoke_test.mjs` completely.
- Run the current smoke test and confirm the baseline.
- Confirm the worktree is clean and preserve unrelated user changes.
- Review the agreed decisions in section 4.

During implementation:

- Work one phase at a time and run its validation before continuing.
- Preserve the no-profile path as a first-class code path.
- Keep all WordPress literals out of `web-inspector/`.
- Use argument arrays when spawning scripts.
- Keep secrets out of commands, reports, fixtures, and commits.
- Update documentation with each public-interface change rather than waiting until the end.
- Inspect screenshots in addition to machine-readable reports for every visual claim.

Before handoff/release:

- Run all generic and WordPress smoke tests.
- Perform the real local WordPress integration checks.
- Review all generated artifacts and remove any that accidentally entered the repository.
- Run `git status` and inspect the complete diff.
- Verify no profile state or credentials are tracked.
- Summarize verified behavior, untested combinations, and deferred limitations.
