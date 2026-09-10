---
name: website-visual-diff
description: Compare before-and-after rendered versions of local or authorized websites with cache-isolated screenshots, pixel diffs, and reversible CSS experiments. Use for visual regression checks after a web change, not for comparing source files alone.
---

# Website Visual Diff

Use this skill when the question is “what changed visually between these two rendered versions?” Capture the same URL(s), viewport(s), browser/device settings, and interaction state on both sides, then inspect the generated comparison and browser reports.

It supports Codex and OpenCode skill discovery. It requires Node.js and the sibling `web-inspector` skill; the WordPress editor workflow additionally requires `wordpress-inspector`. ImageMagick's `identify`, `convert`, `compare`, and `montage` are optional enhancements. Without them, the comparator still writes an HTML side-by-side viewer.

The primary workflow is a reversible CSS experiment. `scripts/run_visual_diff.mjs` captures the original page, comments out one or more explicitly selected line ranges in a CSS file, captures the changed page, generates comparison artifacts, and restores the file in a `finally` path. It invokes the sibling `web-inspector` runner rather than reimplementing browser capture.

## CSS experiment

Only make a source change that the user has requested or clearly authorized. First verify that the target URL is the intended local or authorized site, that the relevant server is already running, and that the CSS file is the source actually served by the site. Do not reset, start, or stop a WordPress environment unless the project instructions or user explicitly authorizes that operation.

Use one-based, inclusive line ranges. A range must contain a complete CSS rule or declaration and must not contain an existing `/* ... */` comment. Repeat `--range` for multiple independent ranges; inspect the file with `rg -n` first rather than guessing line numbers.

Example from the skill directory (or replace the script path with its absolute path):

```bash
node scripts/run_visual_diff.mjs \
  http://lepaysanurbain.test:8888/ \
  --css-file themes/lepaysanurbain/assets/css/theme.css \
  --range 120:134 \
  --viewport 1440x1100 \
  --viewport 390x844 \
  --full-page \
  --output-dir /tmp/lpu-theme-css-diff \
  --open
```

The runner uses a new uniquely named Web Inspector profile and a `visual_diff_cache_bust` query value for each phase. This is deliberate: the companion capture runner otherwise uses a persistent profile, and an unchanged CSS URL could otherwise be served from the browser cache. The two captures are sequential, never concurrent, and use the same capture settings. The short-lived browser state is removed after the run. If the page requires authentication, use an authenticated capture workflow with `wordpress-inspector`/`web-inspector`, then compare the resulting directories with the standalone comparator below; do not silently use a personal browser profile.

The CSS file is restored even when the changed capture or comparison fails. If restoration fails because the file no longer matches the helper's expected modified content, stop and report the state-file path; never overwrite an intervening edit automatically.

## Compare existing captures

When a change must be made by another tool or has already been made, use:

```bash
node scripts/compare_screenshots.mjs \
  --before /tmp/before-capture \
  --after /tmp/after-capture \
  --output-dir /tmp/site-comparison \
  --open
```

The comparator pairs the primary screenshots recorded in each `report.json` by filename. If reports are absent, it pairs PNGs by basename. It pads images to a common canvas when page heights differ, generates an ImageMagick pixel-difference image and a three-panel side-by-side image when `compare`/`montage` are available, and always writes an HTML viewer. Pixel differences are evidence of changed pixels, not an explanation of the cause; inspect the rendered images and both reports.

`--open` opens the HTML viewer with `xdg-open` when a graphical session is available. In a headless session, use the printed `comparison/index.html` path or inspect the PNGs directly. Generated captures and browser state belong in `/tmp` by default and should not be committed.

## Required checks

- Keep the URL, viewport(s), full-page setting, browser/device, wait settings, and actions identical before and after.
- Read both Web Inspector `report.json` files. Check HTTP status, navigation errors, failed requests, page errors, action failures, image loading, and final document dimensions before attributing a difference to the CSS change.
- Open every relevant original, changed, diff, and side-by-side PNG. Treat the rendered screenshots as the source of truth; use DOM summaries only as supporting evidence.
- Report the artifact directory, exact source ranges changed, restoration result, tested viewports/actions, and any checks not performed.

For Gutenberg editor or Site Editor canvas comparisons, use `wordpress-inspector` for the editor snapshot and its required browser workflow, then use `compare_screenshots.mjs` for the image comparison. This skill does not replace WordPress editor inspection or accessibility testing.

## Validation and installation

From the skill source directory, run:

```bash
python3 /home/tburette/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
node scripts/smoke_test.mjs
```

The smoke test uses temporary files under `/tmp` and removes them. Browser smoke testing belongs to the companion `web-inspector` skill; this skill's end-to-end runner can be tested with an injected capture adapter when Chromium is not appropriate for a unit test.

For a local project checkout, expose the source to both hosts with links, after checking that the two destinations are absent or already point to this source:

```bash
mkdir -p .codex/skills .config/opencode/skills
ln -s /home/tburette/dev/ai/ai-tools/website-visual-diff .codex/skills/website-visual-diff
ln -s /home/tburette/dev/ai/ai-tools/website-visual-diff .config/opencode/skills/website-visual-diff
```

Do not replace an existing directory or link silently. The run mutates the requested CSS file temporarily and creates screenshots, reports, HTML, and comparison PNGs in the output directory; those artifacts may contain private page content and should stay out of version control unless explicitly requested.
