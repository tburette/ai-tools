---
name: website-visual-diff
description: Compare before-and-after rendered versions of websites with cache-isolated screenshots, pixel diffs, and reversible CSS experiments. Use for visual regression checks after a web change, not for comparing source files alone.
---

# Website Visual Diff

Use this skill when the question is “what changed visually between these rendered versions?” Capture the same URL(s), viewport(s), browser/device settings, and interaction state on both sides, then inspect the generated comparison and browser reports.

The runner uses the two viewports: 1440×1100 and 390×844, both with full-page capture. If it has been requested, you can choose the viewports to use with `--viewport` (can be repeated) and `--no-full-page` to the runner to change those values.

The primary workflow is a reversible CSS experiment using `scripts/run_visual_diff.mjs`. It captures the original page, temporarily disables one or more CSS rules, captures the changed page, generates comparison artifacts, and restores the file in a `finally` path.

## CSS experiment

Only make a source change that the user has requested or authorized. Do not try to configure, reset or start what is needed to make the URL work. Report if the URL couldn't be successfully retrieved.

You can receive CSS rule locaton in the following format: `FILE:LINENO (SELECTOR) [context-lines=FROM-TO]`
eg.:

```text
themes/lepaysanurbain/assets/css/theme.css:26 (.lpu-graphic-band)
themes/lepaysanurbain/assets/css/theme.css:26 (.lpu-graphic-band) [context-lines=20-28]
```

The selector and context-line are optional.The selector in parentheses is only a disambiguation hint and may be incomplete for multiline or escaped selectors. context-lines is the beginning and en of the entire ruleset

Pass it to the runner with `--css-ref`:

```bash
node scripts/run_visual_diff.mjs \
  http://lepaysanurbain.test:8888/ \
  --css-ref 'themes/lepaysanurbain/assets/css/theme.css:26 (.lpu-graphic-band)' \
  --viewport 1440x1100 \
  --viewport 390x844 \
  --full-page \
  --output-dir /tmp/lpu-theme-css-diff
```

Repeat `--css-ref` for multiple rules in the same CSS file. The runner reports the resolved one-based line ranges before recording them in `run.json` and the aggregate HTML viewer. If the reference is ambiguous, move the cursor to a unique line or include the selector context; never guess a rule.

Another format exists, using an exact line range.
Example from the skill directory (or replace the script path with its absolute path):

```bash
node scripts/run_visual_diff.mjs \
  http://lepaysanurbain.test:8888/ \
  --css-file themes/lepaysanurbain/assets/css/theme.css \
  --range 120:134 \
  --viewport 1440x1100 \
  --viewport 390x844 \
  --full-page \
  --output-dir /tmp/lpu-theme-css-diff
```

After comparison HTML, JSON reports, and CSS restoration are complete, the runner automatically opens the aggregate viewer with `open <absolute-path-to-index.html>`. By default it first copies the complete report bundle to `~/Downloads/website-visual-diff/<run>-<token>/` so Firefox installed as a Snap can read local screenshots and reports. Pass `--no-viewer-relocation` to open the requested output path directly from `/tmp/`, or `--no-open` to skip launching a viewer entirely in a headless/container environment. An explicitly supplied output directory must be new or empty; use a fresh directory such as `--output-dir "$(mktemp -d /tmp/website-visual-diff.XXXXXX)"` so a failed or interrupted run cannot leave stale screenshots looking current. If opening or copying fails, it reports a warning while preserving the completed artifacts. The runner uses a browser with different profiles for each phase and a `visual_diff_cache_bust` query value for each phase. This is done to help avoid being served from the browser cache, it shouldn't be needed as the tool should use two different browser profiles with their own caches.

The CSS file is restored even when the changed capture or comparison fails. file and line number (or range) based `--css-ref` rules are replaced by a CSS comment sentinel rather than wrapped in comment, so existing comments inside the rule remain valid. If restoration fails because the file no longer matches the helper's expected modified content, stop and report the state-file path; never overwrite an intervening edit automatically.

Each successful before/after capture also gets a readable `capture-summary.txt` next to Web Inspector's `report.json`. The aggregate viewer links to both summaries. The summary covers HTTP status, final URL, navigation errors, console/page errors, failed requests/responses, action failures, document dimensions, and image loading; consult the raw `report.json` for full details.

If a capture fails before writing `report.json`, read the runner's complete error: it includes both child stderr and stdout. An error containing `sandbox_host_linux`, `sandbox_host`, or `Operation not permitted` is a browser-process permission failure before navigation, not a CSS or WordPress failure. Retry the capture with elevated browser execution. Do not infer that the local site is offline from that error.

## Compare existing captures

This is an optional alternative way to use this skill.
When screen captures has already been made, use:

```bash
node scripts/compare_screenshots.mjs \
  --before /tmp/before-capture \
  --after /tmp/after-capture \
  --output-dir /tmp/site-comparison \
  --open
```

The comparator pairs the primary screenshots recorded in each `report.json` by filename. If reports are absent, it pairs PNGs by basename. Its output directory must be new or empty. It pads images to a common canvas when page heights differ, generates an ImageMagick pixel-difference image and a three-panel side-by-side image when `compare`/`montage` are available, and always writes an HTML viewer. Pixel differences are evidence of changed pixels, not an explanation of the cause; inspect the rendered images and both reports.

For standalone comparisons, `--open` invokes `open` for the HTML viewer and applies the same copy to `~/Downloads/website-visual-diff/` by default. Pass `--no-viewer-relocation` to open the requested output path directly. If `open` or copying fails, the comparator reports a warning. Generated captures and browser state belong in `/tmp` by default; relocated caputes and browser reports copies live under `~/Downloads/website-visual-diff/`.

## Required checks

- Keep the URL, viewport(s), full-page setting, browser/device, wait settings, and actions identical before and after.
- You can read both Web Inspector `report.json` files to check HTTP status, navigation errors, failed requests, page errors, action failures, image loading, and final document dimensions before attributing a difference to the CSS change.
- Report the artifact directory.
- The run mutates the requested CSS file temporarily and creates screenshots, reports, HTML, and comparison PNGs in the output directory; those artifacts may contain private page content and should stay out of version control unless explicitly requested.
