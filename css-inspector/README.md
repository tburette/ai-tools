# CSS Inspector (on hold)

## Status and intent

Research and an initial extraction experiment were completed; no reusable CSS
inspection tool has been implemented in this repository.

The goal is a simple agent-facing tool that inspects a rendered element like a
browser's DevTools Rules/Styles panel. It should return matching CSS rules and
their sources so an agent can use that information alongside the static code.

The tool should do the browser work itself. Agents should not need to research
protocols or write one-off scripts for each inspection. A short `SKILL.md` can
explain how to use it.

The first version uses Chromium and a small interface. Its output must be
accurate and clear about unavailable information.

## Proposed initial public interface

This is an illustrative interface, not an existing command or a fixed CLI design:

```bash
inspect-css 'http://site.test/page' \
  --selector '.page-title' \
  --viewport 1440x1100
```

- Accept a page URL and a CSS selector for the element.
- By default, return all matching rules for the selected element.
- Report invalid selectors, missing elements, and ambiguous matches clearly.
  Do not silently inspect the first match.

## Output

- Return machine-readable JSON containing the matching rules and declarations,
  including inline styles and relevant inherited rules.
- Include source locations and specificity/cascade information supplied by the
  browser or inspector. Keep inherited and pseudo-element rules distinguishable
  from rules on the selected element.
- Preserve declaration order and duplicate properties.
- Include computed values separately from declarations and their statuses.
- Identify the inspected page, element, and viewport.
- Put incidental diagnostics on stderr and report operational failures clearly
  with a nonzero exit status.

## Accuracy

- Reuse existing browser or inspector information where practical and preserve
  its meaning. Do not guess missing information or invent winning declarations.
- Do not report a successful inspection if navigation, element selection, or
  collection failed.
- Keep inspection read-only.

## Possible later improvements

- Optional property filtering for focused output.
- Set an element's state, such as hover, before inspecting it.
- Run supplied JavaScript before inspection, for example to keep an overlay open.
- Select a frame, such as the WordPress Gutenberg editor canvas.

## Tests

Possible tests :

- Exact-one-target resolution; invalid/absent/ambiguous selectors.
- Source-order ties decider, `:is()`/`:where()`, and nesting.
- Inline/stylesheet importance, layer ordering and important reversal.
- Inheritance; variable fallback.
- Shorthand/longhand partial overrides and logical/physical collisions under
  different writing modes/directions.
- Media/supports/container; pseudo-elements.
- Failed navigation/collection; optional metadata warnings; stdout/stderr/exit contract.

Test code, if added, should have a very simple, readable structure.
One folder per test. The folder contains:

- the .html, .css,...
- A simple (independant) script that : starts the web server, calls the tool, check its result (error code, output,..).

A simple web server is used (eg. `npx serve`) to access the page.

A developer unfamiliar with the project should be able to read a single test (one folder) and understand easily what is being tested.

This simple structure does not preclude the use of common code for the script to use (common utils) or doing things like avoiding starting and stopping the test web server for each test by running it once for all the tests (it's just an example..).

## Existing work and research

- [Web Inspector](../web-inspector/SKILL.md) already provides rendering and browser
  runtime helpers that may be reusable.
- The [CDP extraction experiment](experiments/cdp-probe/README.md) is preserved
  with its fixtures, run instructions, results, and limitations.
- [Research and planning notes](research.md) contain the tool survey, source
  references, and earlier implementation ideas.
