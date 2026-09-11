# Web Inspector — Reference

Implementation details, internal behavior, and platform notes. This document is for tool maintainers and advanced users, not required for normal agent invocation (see SKILL.md).

## Persistent profiles and headed sessions

Normal captures are headless and use the permanent `default` browser profile. Use an explicit profile name when you need a dedicated persistent profile:

```bash
node scripts/capture_page.mjs http://localhost:3000/ \
  --profile lpu-local \
  --output-dir /tmp/web-inspector/profile-check
```

The profile name is a validated identifier, not a filesystem path. If
`--profile` is omitted, the validated name `default` is used. Any valid name
can be selected explicitly, and a new profile directory is created when
needed. Captures are headless by default; use `--headed` or `--headless` to
choose the mode explicitly. Do not run concurrent commands with the same
profile because Chromium may lock its user-data directory.

### Profile state resolution order

`WEB_INSPECTOR_STATE_DIR` → `${XDG_STATE_HOME}/web-inspector/profiles` → `~/.local/state/web-inspector/profiles`

State is stored in a dedicated owner-only directory; never in the repository, output directory, or `/tmp` by default.

### Profile behavior

- A profile name is an identifier, not a filesystem path.
- Profiles support both Chromium and Firefox; select the browser with `--browser`.
- Persistent mode retains cookies, localStorage, IndexedDB, and other browser state across invocations. It never imports the user's regular browser profile.
- Reports record only the profile name and `persistentContext: true` — never the path or contents.
- Chromium additionally persists session cookies via `--persist-session-cookies`; Firefox relies on its on-disk profile (session-only cookies may not survive restarts).
- Treat persistent profiles as bearer credentials: protect like a password, do not commit, do not print path/contents in reports.

### One-time interactive setup

```bash
node scripts/open_profile.mjs http://localhost:3000/ \
  --timeout 300000
```

Launches a visible dedicated Chromium window and returns as soon as the page,
browser context, or browser connection closes. Pass `--success-selector` to
close automatically when a visible success-state selector appears. A timeout
or SIGINT/SIGTERM also ends the session, but exits non-zero and is reported
separately from a normal `window-closed` or `success` result. The runner emits
a final `interactive-session-ended` JSON record with the session-end reason.
Requires a usable `DISPLAY` or `WAYLAND_DISPLAY` on Linux. It does not handle
credentials.

## First-run runtime setup

Before any capture, the runner resolves an existing Playwright package and browser runtime automatically in this order:

1. `PLAYWRIGHT_PACKAGE`, when explicitly provided
2. The project's local `node_modules/playwright`
3. Global Node module paths
4. Codex runtime caches under `~/.cache/codex-runtimes`
5. npm's `_npx` cache

If no existing installation is found, stop with an explicit error. Never install dependencies automatically.

```bash
PLAYWRIGHT_PACKAGE=/path/to/playwright \
  node scripts/capture_page.mjs http://localhost:3000/
```

For Firefox, if the Playwright package points at a missing revision, the runner searches existing `firefox-*` runtimes under the Playwright browser cache before failing.

Codex CLI only: if the sandboxed shell blocks Chromium, launch with elevated permissions (`sandbox_permissions="require_escalated"`). Chromium can fail before navigation with `sandbox_host_linux.cc:41` even though the runner supplies `--no-sandbox`.

## Playwright resolution and browser launch

The runner resolves Playwright in this order:

1. `PLAYWRIGHT_PACKAGE`
2. The project's `node_modules/playwright`
3. `NODE_PATH` and the global Node module path
4. Codex runtime caches (`~/.cache/codex-runtimes`)
5. npm's `_npx` cache
6. Normal Node module resolution

If resolution fails, report the error and do not silently install dependencies. Use shell escalation for the first Chromium or Firefox launch if the outer sandbox terminates the browser before navigation.

### Local hostname mapping

For `localhost` or `*.test` URLs, the runner maps the hostname to `127.0.0.1` by default (Chromium-only `--host-resolver-rules`; Firefox uses OS resolution). Reports distinguish `localMapRequested` from `localMapApplied`. Disable with `--no-local-map`.

When Codex's managed network proxy is active, the launcher passes it explicitly to Playwright for `.test` hostnames. Playwright does not automatically use Codex's `HTTP_PROXY` environment variables; direct loopback access from the sandbox can otherwise produce `ERR_CONNECTION_REFUSED` even while the host service is running. `localhost` and `127.0.0.1` fixtures remain direct so local smoke-test servers are not routed through the host proxy.

### Visual regression

Capture the same URL at the same viewport and compare the new screenshot with the supplied baseline. Do not call a page "responsive" from a desktop screenshot alone.

## Firefox installed through Snap

The system Firefox Snap (`/usr/bin/firefox` or `/snap/bin/firefox`) is not a safe default. Snap gives Firefox a private `/tmp`, while Playwright starts Firefox with a temporary profile and juggler pipe there; the paths are invisible inside the Snap. Launching the Snap binary directly can also select the already-running desktop profile or use libraries unavailable outside Snap.

Prefer `--browser firefox` with an existing Playwright Firefox runtime. If a system executable must be supplied, use `--executable-path` only with a non-Snap Firefox whose runtime can see the Playwright temporary directory.

## Validation

The bundled smoketest exercises navigation, actions, screenshots, diagnostics, report options, and `--fail-on-errors` behavior:

```bash
node scripts/smoke_test.mjs
```

Firefox variant:

```bash
WEB_INSPECTOR_BROWSER=firefox node scripts/smoke_test.mjs
```

Persistence checks:

```bash
node scripts/profile_smoke_test.mjs
```

Interactive-profile lifecycle checks:

```bash
node scripts/open_profile_smoke_test.mjs
```

The profile smoke test uses temporary state, output, and localhost fixtures. It
proves cross-process persistence, default-profile and separate-profile isolation,
viewport reporting, safe profile-name validation, Firefox selection, and that
cookie values do not enter reports or stdout.

All smoke tests require a usable Playwright installation. Set `PLAYWRIGHT_PACKAGE` when it is not available through normal Node resolution. The smoke tests create and remove their own temporary output and local HTTP server.
