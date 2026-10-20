# Chromium/CDP extraction experiment

Preserves the initial CSS extraction experiment from 2026-10-19. It exercises
a fixed local fixture and checks selected outcomes; it does not implement a
general-purpose CSS inspection tool. The broader proposal is recorded in the
[tool notes](../../README.md).

The original temporary copy lived at `/tmp/css-rules-probe/probe.mjs`. This
preserved version uses relative source/fixture paths and creates a fresh
temporary output directory for each run.

## Original investigation context

During the original investigation, the Browser plugin reported no connected
browser, while standalone Playwright worked. The official DevTools MCP/CLI was
not installed or runtime-tested. The experiment ran independently of an in-app
browser connection.

## Files

- [`probe.mjs`](probe.mjs): original experiment with portable source/fixture
  paths and a fresh temporary output directory for each run.
- [`index.html`](index.html): target element, inline style attribute, and
  document stylesheet.
- [`external.css`](external.css): competing declarations, layers, variables,
  hover, and a pseudo-element.

## Prerequisites

- Node.js; the original experiment ran with Node.js 24.19.0 on Linux.
- An already-installed Playwright package and its Chromium runtime. The original
  run used Chromium 151.0.7922.34. This experiment requires the CDP CSS methods and
  CSS features used by its fixtures; it does not target Firefox.
- The sibling `web-inspector/` directory from this repository. The experiment
  imports its existing [Playwright resolver](../../../web-inspector/scripts/lib/playwright.mjs).
  Keep the repository layout when copying the experiment.

The resolver can use an existing project/global/runtime-cache installation.
Set `PLAYWRIGHT_PACKAGE` to an existing Playwright package path if necessary.
Nothing is installed or downloaded automatically. No Codex/OpenCode skill
installation, MCP server, or in-app browser connection is needed; this is a Node
script. It has been exercised through the Codex shell, not separately validated
as an installed host adapter.

## Run and validate

From the repository root:

```bash
node --check css-inspector/experiments/cdp-probe/probe.mjs
node css-inspector/experiments/cdp-probe/probe.mjs
```

The script resolves the fixture relative to itself, so it also works when
invoked from another directory. It takes no arguments and always inspects
`#probe` in the bundled fixture at an 800 × 600 viewport.

It launches headless Chromium with a temporary browser profile, loads the local
HTML/CSS files, collects CSS evidence, forces `:hover`, and closes the browser in
`finally`. It does not attach to an existing browser or use a persistent user
profile. Chromium launches with `--no-sandbox`, as in the original experiment;
use this reviewed local fixture in an isolated environment. Managed Codex
environments may require elevated browser-process permission even for a local
file, as described in [Web Inspector](../../../web-inspector/SKILL.md#managed-codex-sandbox).

On success, stdout is a JSON summary containing the browser version, `checks: 14`,
the observed values, selected matched-rule metadata, and `outputDir`. Each run
creates a new `css-inspector-probe-*` directory under the OS temporary directory
(normally `/tmp` on Linux), containing:

- `evidence.json`: stylesheet headers/text, raw matched/computed styles before
  hover, matched styles with forced hover, and the hovered color.
- `render.png`: the fixture screenshot before hover is forced.

These outputs are retained for inspection and are not written into the source
directory. An assertion or browser/protocol failure exits nonzero. A failed run
can leave a temporary directory or partial screenshot; it is not a successful
inspection report.

## What the experiment checks

The script resolves the target using `DOM.getDocument` and `DOM.querySelector`,
then collects `CSS.getMatchedStylesForNode`, stylesheet headers/text, and
`CSS.getComputedStyleForNode`. It uses `CSS.forcePseudoState` for the hover
comparison.

Fourteen assertions check seven computed outcomes plus inline/external source
metadata, inherited/pseudo-element evidence, and hover behavior:

| Property/state | Expected result | Fixture purpose |
| --- | --- | --- |
| `color` | `rgb(255, 0, 0)` | An ID selector beats a competing class selector. |
| `margin-top` | `22px` | A later declaration wins a specificity tie. |
| `letter-spacing` | `2px` | A later document stylesheet beats an equal-specificity external declaration. |
| `margin-bottom` | `7px` | Important `margin-block-end` overrides normal inline `margin-bottom` in horizontal writing mode. |
| `padding-left` | `11px` | The earlier layer wins between important declarations, despite lower selector specificity. |
| `width` | `222px` | The later layer wins between normal declarations. |
| `border-top-color` | `rgb(20, 30, 40)` | A border declaration uses an inherited custom property. |
| Forced hover color | `rgb(0, 128, 0)` | The hover rule appears in matched rules and changes the computed color. |

The metadata assertions check the inline margin declaration, external and inline
stylesheet headers, inherited style groups, and `::before` evidence. The summary
also records available specificity, layers, matching selector indexes, and
source ranges; it does not independently assert all of those fields.

## Limits of the evidence

This is an extraction experiment, not a general cascade-analysis implementation.
The assertions describe known fixture outcomes. The script does not calculate
winning declarations, active/overridden statuses, or explanations for arbitrary
CSS. Matching a computed value does not prove its source attribution.

The stdout rule summary includes regular author rules and declarations with
source ranges. Use `evidence.json` for the raw target, inherited, pseudo-element,
and expanded declaration data collected by CDP. Do not treat the summary as a
complete DevTools Rules panel. Source ranges retain raw CDP coordinates and
stylesheet-relative offsets; they have not been converted into human-facing
document line/column locations.

The fixture does not validate arbitrary selectors, real-page readiness or
interactive state replay, frames/shadow trees, source maps, dynamic stylesheet
mutations, or the full modern cascade. See the [main README](../../README.md) for
the potential tool's current scope and [research notes](../../research.md) for
background findings.
