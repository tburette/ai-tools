# Spike Report: wordpress-inspector & web-inspector Usage

**Date:** 2026-08-31
**Context:** Testing a custom WordPress block (`lpu/nav-group`) inside `core/navigation` — verifying editor rendering, front-end HTML output, and browser DOM structure.
**Review:** Initial report reviewed by a subagent that cross-checked source code claims against `wordpress.mjs` and `capture_page.mjs`. Findings marked (NEW-x) originate from that review.

---

## What I was doing

1. Check if the custom block is registered and insertable in the Gutenberg editor.
2. Open the Site Editor to inspect the navigation post containing the block.
3. Capture a screenshot of the editor to verify visual rendering.
4. Get the block tree and source HTML from the editor.
5. Check the front-end page rendering (screenshot + DOM structure).
6. Verify that the browser's HTML parser correctly handles nested `<li>` elements.

## Tools used

- **wordpress-inspector:** `check-admin`, `check-editor`, `snapshot-editor`, `authenticate`
- **web-inspector:** `capture_page.mjs` (for front-end page)
- **Ad-hoc Playwright script** (for DOM inspection — web-inspector didn't have a built-in way to do this)

---

## wordpress-inspector experience

### What worked well

- `check-admin` correctly detected authentication state and reported `AUTHENTICATED` after login.
- `check-editor` with the correct site-editor URL detected the editor shell, canvas, and invalid-block indicators accurately.
- `snapshot-editor` produced `blocks.json` (full block tree), `source.html` (editor content), and `rendered-iframe.png` — all useful artifacts.
- The classification system (`AUTHENTICATED`, `EDITOR_SNAPSHOT_CAPTURED`, etc.) is clear and machine-readable.

### Issues encountered

#### 1. URL format for navigation posts

I initially tried:

```
--editor-url 'http://lepaysanurbain.test:8889/wp-admin/post.php?post=7&action=edit'
```

This failed because `wp_navigation` is a custom post type, and the Site Editor URL format is different:

```
--editor-url 'http://lepaysanurbain.test:8889/wp-admin/site-editor.php?p=%2Fwp_navigation%2F7&canvas=edit'
```

The `normalizeEditorUrl` validator correctly rejects non-editor routes, but it doesn't inform the user about the site-editor format for `wp_navigation` posts. The error message says:

```
--editor-url must target a supported read-only Gutenberg editor route (post.php?action=edit or site-editor.php)
```

This is technically correct but doesn't help when the user has a `wp_navigation` post ID and doesn't know the site-editor URL encoding.

**Suggestion:** The SKILL.md should document the site-editor URL format for `wp_navigation` posts (see SKILL.md finding #5). The error message itself could also hint at the `site-editor.php` alternative when `post.php` is used with a non-standard post type.

#### 2. Vague `TECHNICAL_ERRORS` classification

When the editor had invalid blocks (mismatched save output), `check-editor` returned:

```json
{
  "classification": "TECHNICAL_ERRORS",
  "warnings": ["console-error"],
  "checks": [
    { "name": "browser diagnostics clear", "passed": false, "detail": "console-error" }
  ]
}
```

The actual error was a block validation failure with a clear "Block contains unexpected or invalid content" message in the console. But the report only said `"console-error"` without surfacing the actual error text.

**Suggestion:** When `browser diagnostics clear` fails with `detail: "console-error"`, include the first few console error messages in the detail or in a separate `consoleErrors` array in the summary. This would make debugging much faster.

#### 3. `find-post` doesn't cover `wp_navigation`

The `find-post` command queries the REST API for publicly readable posts/pages. `wp_navigation` posts aren't publicly queryable via the standard REST API, so `find-post` can't locate them.

**Suggestion:** Add a dedicated `find-navigation` command using WP-CLI (`wp post list --post_type=wp_navigation --name=<slug>`) since the REST API doesn't reliably expose `wp_navigation` endpoints. The existing `find-post` REST-based approach won't work for this CPT.

#### 4. Authentication flow required two attempts

The first `authenticate` attempt appeared to complete but the subsequent `check-admin` still reported `AUTH_REQUIRED`. The second attempt succeeded. This may have been a timing issue or the user not clicking "Remember Me" the first time.

**Suggestion:** After `authenticate` completes, the probe should verify that cookies are actually persisted in the profile. If the post-auth probe still detects a login form, report `AUTH_PROBE_FAILED` with a hint about "Remember Me".

---

## web-inspector experience

### What worked well

- `capture_page.mjs` produced a clean screenshot and `report.json` with DOM summary, links, images, and console diagnostics.
- The `--headed` flag worked correctly for user-visible browser sessions.
- Profile persistence worked — cookies from the wordpress-inspector `authenticate` session were available in web-inspector captures.
- The `domSummary.bodyText` truncation keeps reports compact while preserving useful content.

### Issues encountered

#### 1. Positional URL argument (not `--url` flag)

I initially ran:

```bash
node scripts/capture_page.mjs --url 'http://...' ...
```

This failed with `Unknown option --url`. The URL is a positional argument:

```bash
node scripts/capture_page.mjs 'http://...' ...
```

This is documented in the SKILL.md but easy to miss when switching between tools. The wordpress-inspector uses `--base-url` and `--editor-url` flags, so the mental model differs.

**Suggestion:** Either accept `--url` as an alias for the positional argument, or add a clear error message: `"The URL is a positional argument, not --url. Usage: node scripts/capture_page.mjs <url> ..."`.

#### 2. No built-in way to run JavaScript in browser context

I needed to inspect the browser-parsed DOM structure (check if `<li>` elements were correctly nested inside `<ul>`). The web-inspector doesn't have a command to evaluate arbitrary JavaScript in the page context.

The `--collector` extension point exists but requires writing a separate ES module file. For quick DOM queries, this is heavyweight.

**Suggestion:** Add an `--eval <expression>` option to `capture_page.mjs` that evaluates a JavaScript expression in the page context after navigation and includes the result in `report.json` under a `evalResult` field. This would cover quick DOM queries without requiring a collector module.

**Caveat:** This bypasses the "trusted read-only collector" model described in the SKILL.md. If added, it should only evaluate simple expressions (not arbitrary module loading) and be clearly documented as an escape hatch, not a preferred pattern.

#### 3. Playwright discovery required manual path hunting

When writing an ad-hoc Playwright script, I had to find the Playwright installation. It was in the npm `_npx` cache at an unexpected path. The web-inspector's own `capture_page.mjs` handles this automatically, but standalone scripts don't benefit from that resolution logic.

**Suggestion:** Export the Playwright resolution logic as a reusable module (it already exists in `scripts/lib/playwright.mjs`). Document how to use it from external scripts, or provide a `playwright-path` subcommand that prints the resolved path.

---

## SKILL.md documentation analysis

Beyond runtime behavior, the SKILL.md files themselves have gaps that contributed to the issues above.

### wordpress-inspector SKILL.md

#### 1. Config creation step is vague

Step 2 of the "Standard editor workflow" (line 21) says:

> If no config exists, create a minimal config at the selected config path before launching the browser

But it doesn't show the minimal config JSON. The actual example appears 50 lines later (line 73-81). An agent following the workflow step-by-step has to scroll ahead or guess.

**Suggestion:** Inline the minimal config JSON in step 2, or add a cross-reference: "Create a minimal config (see [Profile setup](#profile-setup-and-authentication) for the JSON format)."

#### 2. Heading case inconsistency

Line 27: `## retrieve post ID from frontend url` uses sentence case while all other headings use title case (`## Read-only checks`, `## Editor snapshots`, etc.).

**Suggestion:** Rename to `## Retrieve post ID from frontend URL`.

#### 3. `find-post` limitations are understated

Line 37 says `find-post` "only sees publicly readable content (drafts/private posts need an authenticated method)" but doesn't mention that custom post types like `wp_navigation` may not be queryable at all via the public REST API, even if published.

**Suggestion:** Add: "Custom post types (e.g. `wp_navigation`) may not expose a public REST API endpoint and will not be found."

#### 4. Gendered language

Line 65: "ask him to install web-inspector" should be "ask them".

#### 5. Site-editor URL format not documented

The URL validator section (line 121) mentions `site-editor.php` as an accepted route but doesn't document the query parameter encoding (`?p=%2Fwp_navigation%2F<id>&canvas=edit`). An agent working with `wp_navigation` posts has no way to know this format from the SKILL.md alone.

**Suggestion:** Add a brief note: "For `wp_navigation` posts, use the Site Editor URL format: `site-editor.php?p=%2Fwp_navigation%2F<id>&canvas=edit`."

#### 6. No guidance for `TECHNICAL_ERRORS` troubleshooting

The classifications section (line 169-181) lists `TECHNICAL_ERRORS` but the workflow section doesn't explain what to do when it's returned. The natural reaction is to retry or give up, but the actual fix is often to check console errors or fix block validation.

**Suggestion:** Add a troubleshooting note under `TECHNICAL_ERRORS`: "Check the `consoleErrors` array in the report for specific messages. Common causes: block validation mismatches (save output doesn't match stored content), missing plugin dependencies, or PHP fatal errors."

#### 7. `find-post` output format not shown

The `find-post` section shows the command but not the output format. An agent doesn't know whether it returns just an ID, a full URL, or a JSON object.

**Suggestion:** Add an example output:
```
ID: 123
Editor URL: http://example.test:8888/wp-admin/post.php?post=123&action=edit
```

### web-inspector SKILL.md

#### 8. Typo in Validation section

Line 257: `The bundled localhost smoketest tool`scripts.smoke_test.mjs` contains tests of this tool.` — missing space before the backtick.

**Suggestion:** Fix to: `The bundled localhost smoketest tool \`scripts/smoke_test.mjs\` contains tests of this tool.`

#### 9. Action table doesn't show `hover` example for dropdowns

The action reference (line 207-221) documents `hover` but the Capabilities section (line 47-55) only shows `click` and `assertVisible` examples. Dropdown menus are a primary use case for `hover`.

**Suggestion:** Add a hover example in the Capabilities section:
```bash
--action '{"type":"hover","selector":"text=Menu Item"}' \
--action '{"type":"assertVisible","selector":"text=Submenu Item"}' \
```

#### 10. No guidance on iframe handling

Gutenberg renders post content in an iframe (mentioned in wordpress-inspector's line 147). The web-inspector SKILL.md doesn't mention how `--action` selectors interact with iframes. An agent might try to selectors inside an iframe and fail silently.

**Suggestion:** Add a note in the Action reference: "Selectors operate on the top-level page. For content inside iframes (e.g. Gutenberg editor), use the `frame` option in the action JSON or use wordpress-inspector's `snapshot-editor` which handles iframes internally."

#### 11. `--collector` lacks a minimal example

The collector extension point (line 59) is documented abstractly but has no inline example. An agent has to read the full SKILL.md, find the description, then figure out the ES module format.

**Suggestion:** Add a minimal collector example:
```js
// my-collector.mjs
export async function collect({ page }) {
  return await page.evaluate(() => document.title);
}
```

#### 12. Codex-specific references may confuse non-Codex agents

Lines 12, 121, 195-196 reference "Codex CLI", "Codex runtime caches", and "`view_image` in Codex". These are irrelevant to opencode agents and add noise.

**Suggestion:** Move Codex-specific notes to a `### Codex CLI notes` subsection or prefix them with "(Codex CLI only:)" consistently, so the main workflow reads cleanly for any agent.

#### 13. No troubleshooting section

Neither SKILL.md has a troubleshooting section. Common failure modes (profile in use, Playwright not found, auth expired, sandbox blocking browser) are scattered throughout or missing entirely.

**Suggestion:** Add a `## Troubleshooting` section to both SKILL.md files covering:
- `EADDRINUSE` / "user data directory in use" → another process holds the profile
- Playwright not found → check `PLAYWRIGHT_PACKAGE` or install location
- `AUTH_REQUIRED` after `authenticate` → ensure "Remember Me" was checked
- Blank screenshots → page may need `--wait-ms` or `--wait-until networkidle`
- Sandbox blocks Chromium → use `--no-sandbox` (already default) or `sandbox_permissions="require_escalated"`

---

## Additional findings (from review)

The following were identified during a critical review of the initial report.

#### NEW-1: `normalizeEditorUrl` silently rejects `site-editor.php` with `action` param

`wordpress.mjs:75` requires `!editorUrl.searchParams.has("action")` for site-editor URLs. If someone passes `site-editor.php?p=...&action=edit` (copying the `action=edit` pattern from `post.php`), it will be rejected with the same generic error. This is a common user mistake that the validator could detect and explain.

#### NEW-2: `technicalIssues` intentionally filters action-related page errors

`wordpress.mjs:106` filters page errors with `!/^action \d+:/i.test(String(error))`. This means action assertion failures (e.g. block validation problems detected by Gutenberg actions) are excluded from `TECHNICAL_ERRORS` and classified as product signals instead. This is correct design but undocumented — an agent seeing `TECHNICAL_ERRORS` with no detail won't understand why action-related failures are absent.

#### NEW-3: `find-post` exit code for multiple matches is unspecified

The SKILL.md says `find-post` "exits non-zero when nothing matches" but doesn't document behavior when multiple posts match. Agents may rely on exit codes for control flow.

#### NEW-4: `--headed` behavior description is slightly inaccurate

The SKILL.md says "Use `--headless` with `authenticate` only to receive an explicit error," but `capture_page.mjs` doesn't actually check for this — it would run headless silently. The error comes from the subsequent probe, not the flag itself. This could confuse agents.

#### NEW-5: Codex references appear in primary Playwright resolution list

The SKILL.md line 12 mentions "Codex runtime caches" as the first item in the Playwright resolution list — the most prominent place where Codex appears. The original report flagged Codex references at lines 12, 121, 195-196 but didn't note that line 12 is in the resolution list, which all agents encounter first during setup.

---

## Summary of suggested improvements

| # | Tool | Improvement | Priority |
|---|------|-------------|----------|
| 1 | wordpress-inspector | Surface actual console error messages in `TECHNICAL_ERRORS` reports | High |
| 2 | wordpress-inspector | Add `find-navigation` command using WP-CLI for `wp_navigation` posts | Medium |
| 3 | wordpress-inspector | Improve error message when `site-editor.php` URL has `action` param (NEW-1) | Medium |
| 4 | wordpress-inspector | Verify cookie persistence after `authenticate` and report `AUTH_PROBE_FAILED` | Low |
| 5 | web-inspector | Accept `--url` as alias for positional URL argument (or clearer error) | Medium |
| 6 | web-inspector | Add `--eval <expression>` for quick JS evaluation (security caveat: escape hatch only) | Medium |
| 7 | web-inspector | Provide `playwright-path` subcommand or document reusable resolution | Low |
| 8 | wordpress-inspector SKILL.md | Document site-editor URL format for `wp_navigation` posts | High |
| 9 | wordpress-inspector SKILL.md | Add troubleshooting section for `TECHNICAL_ERRORS` and common failures | Medium |
| 10 | wordpress-inspector SKILL.md | Inline minimal config JSON in workflow step 2 | Medium |
| 11 | wordpress-inspector SKILL.md | Show `find-post` output format and multiple-match exit behavior (NEW-3) | Low |
| 12 | wordpress-inspector SKILL.md | Fix heading case and gendered language | Low |
| 13 | web-inspector SKILL.md | Add troubleshooting section (profile in use, Playwright not found, etc.) | Medium |
| 14 | web-inspector SKILL.md | Add `hover` example for dropdown menus in Capabilities section | Medium |
| 15 | web-inspector SKILL.md | Document iframe selector limitations and workaround | Medium |
| 16 | web-inspector SKILL.md | Add minimal `--collector` code example | Low |
| 17 | web-inspector SKILL.md | Fix typo in Validation section (missing space) | Low |
| 18 | web-inspector SKILL.md | Move Codex-specific references to dedicated subsection (incl. line 12 resolution list, NEW-5) | Low |
| 19 | wordpress-inspector SKILL.md | Document `action` param behavior in `normalizeEditorUrl` (NEW-1) | Medium |
| 20 | wordpress-inspector SKILL.md | Document that action failures are filtered from `TECHNICAL_ERRORS` (NEW-2) | Low |
| 21 | web-inspector SKILL.md | Fix `--headless` + `authenticate` claim — error comes from probe, not flag (NEW-4) | Low |
