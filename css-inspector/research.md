# CSS Inspector research and planning notes

Research from 2026-10-19 and 2026-10-20, including source audits, alternatives,
and earlier implementation ideas. These are background notes, not additional
first-version requirements. The [main README](README.md) defines the current
scope. Recheck upstream interfaces and findings before relying on them.

From `codex resume 01a154a8-59d6-7512-8087-cf264b7c77a5`.

## Research findings to revisit

Three review agents examined the plan (Astra medium as an experienced web
developer, Sol 6.1 xhigh as a research-oriented developer, and a tooling
maintainer perspective). They agreed on one executable and a short usage skill.
They challenged smart filtering, optimistic status labels, and assumptions that
the official tool could simply be wrapped unchanged. Two wanted reliable
declaration status in the first release; the maintainer proposed extraction
first. The user subsequently emphasized that a misleading or only partially
useful tool is unacceptable. Do not interpret the extraction-first suggestion
as an accepted product scope.

Three additional **Sol 6.1 max** agents researched existing tools,
articles/discussions, and browser-native APIs/testing. These were documentation
and source audits, not runtime comparisons of the candidate tools.

It is absolutely fine to use existing libraries and tools if it work for our needs.

**Strongest existing foundation: official Chrome DevTools.**

- Research verified published `chrome-devtools-mcp` **1.11.0**, including the
  experimental `chrome-devtools` CLI. The CLI has structured JSON output and
  reuses a background daemon/browser across commands; its lifecycle and page
  isolation need consideration.
- `get_css_styles` uses DevTools `CSSModel`/`CSSMatchedStyles` and already provides
  matched/inherited/pseudo declarations, conditional context, and declaration
  statuses. It is paginated; a wrapper must retrieve all required pages.
- Its public CSS endpoint takes a snapshot UID, not an arbitrary selector. Some
  DOM nodes are absent from accessibility snapshots. Returning a DOM element
  from `evaluate_script` does not create such a UID.
- The reviewed formatter reduces full URLs to basenames/lines, omits important
  identity/range/specificity details and computed values, defaults unavailable
  property state to `active`, and does not expose per-longhand status. Its
  description's "authoritative and complete" wording should not become our own
  guarantee without verification.
- DevTools has an explicit `mcp` entrypoint exporting relevant SDK machinery, but
  it is not established as a stable standalone CSS-analysis library. Assess a
  focused fork/adapter versus a pinned integration; do not casually import
  private bundles or assume `npm install` yields an ordinary reusable module.
- References: [release](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.11.0),
  [CLI](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.11.0/docs/cli.md),
  [CSS tool](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.11.0/src/tools/css.ts),
  [formatter](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.11.0/src/formatters/CssFormatter.ts),
  [cascade model](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/core/sdk/CSSMatchedStyles.ts),
  [MCP entrypoint](https://github.com/ChromeDevTools/devtools-frontend/blob/main/mcp/mcp.ts),
  [integration notes](https://github.com/ChromeDevTools/devtools-frontend/blob/main/mcp/README.md).

**Alternatives have useful interfaces, but their reviewed comparators did not
meet the reliability requirement when checked. Recheck before adopting; do not treat anything here as authoritative.**

| Candidate                                                                             | Useful design precedent                                                                                                      | Source-audit concern                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Visionaire Engine](https://github.com/mi60dev/visionaire-engine)                     | Selector/UID/coordinate targeting, launch/attach, explanations, source maps, stylesheet owner IDs and WordPress attribution. | [Reviewed comparator](https://github.com/mi60dev/visionaire-engine/blob/314af809bf17fd6c381218d91f87326c7e008486/src/engine/cascade.ts) orders layer names lexicographically, takes the first matching selector, assumes custom properties inherit, and has logical-property gaps. |
| [chrome-cdp-ex](https://github.com/EndeavorYen/chrome-cdp-ex)                         | Selector/property CLI, existing tabs, JSON and source/edit pointers.                                                         | [Reviewed implementation](https://github.com/EndeavorYen/chrome-cdp-ex/blob/428075e6e668a21bb50007d952f85be1a29cc3f2/skills/chrome-cdp-ex/scripts/lib/cdp-flow.mjs) partly selects winners by agreement with computed text and guesses some source identities.                     |
| [csstruth](https://github.com/ikraamg/csstruth)                                       | Selector/property CLI and MCP, with source-map support.                                                                      | [Reviewed explanation code](https://github.com/ikraamg/csstruth/blob/22a13d6cf2cdc1cf3fca1742325464e883c77ac7/src/core/explain.ts) uses importance/specificity/order without inherited candidates or layer context.                                                                |
| [browser-inspector-mcp](https://github.com/betson-g/browser-inspector-mcp)            | Compact per-element inspection and attached-page workflow.                                                                   | [Reviewed collection](https://github.com/betson-g/browser-inspector-mcp/blob/4b2314b776550baab7c8d3d7c4c701e1e1653c94/tools/inspect-styles.js) drops generic selectors/custom-property declarations and has no active/overridden engine.                                           |
| [devtoolcss/chrome-inspector-mcp](https://github.com/devtoolcss/chrome-inspector-mcp) | Existing Chrome tabs, DOM-expression targeting, matched/computed calls.                                                      | [Formatter](https://github.com/devtoolcss/chrome-inspector-mcp/blob/main/extension/src/styleUtils.ts) loses provenance; its independent parser mixes element and pseudo-element applied-property state.                                                                            |

Other audited leads included gstack's `browse inspect`, PicassoWeb, and
StyleSpeak. Reasons not to prioritize them included specificity-only ordering,
rule limits/property-map collapse, and first-occurrence winner guesses labeled
as exact. The research did not establish a ready-made replacement satisfying
the complete contract.

**Browser-native capabilities and limitations:**

- Current CDP provides `CSS.getLayersForNode` with an actual layer tree/order,
  `CSS.getLonghandProperties` for browser shorthand expansion, and
  `CSS.resolveValues` for contextual value resolution. Experimental capabilities
  must be checked against the selected browser. `resolveValues` is not a cascade
  oracle and has documented limits, including `revert`/`revert-layer`.
- `CSS.getMatchedStylesForNode` supplies matched evidence, not a universal
  engine-emitted winner/reason field. DevTools derives additional status in
  frontend code. [CDP CSS definitions](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/CSS.pdl)
- Firefox's real DevTools RDP offers `PageStyleActor.getApplied` and
  `getMatchedSelectors`, with applied rules, property attribution, sources, and
  selector metadata. It is a credible alternative backend, but involves
  privileged/browser-specific APIs and a versioned compatibility window.
  [PageStyleActor](https://github.com/mozilla-firefox/firefox/blob/main/devtools/server/actors/page-style.js),
  [InspectorUtils](https://github.com/mozilla-firefox/firefox/blob/main/dom/chrome-webidl/InspectorUtils.webidl),
  [compatibility policy](https://firefox-source-docs.mozilla.org/devtools/release.html#remove-backwards-compatibility-code)
- Firefox property attribution and Rules-view strikeouts are also partly
  JavaScript-derived. [Bug 1845075](https://bugzilla.mozilla.org/show_bug.cgi?id=1845075)
  documents a logical margin overriding a physical shorthand component without
  the expected strikeout; it was still NEW in the research snapshot. Reusing
  inspector code does not remove the need to test its semantics.
- Chrome's own AI-assistance
  [GetStyles tool](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/ai_assistance/tools/GetStyles.ts)
  is another integration example, but the reviewed JSON exports requested
  computed/active values rather than full candidates, sources, and reasons.
- WebDriver BiDi did not offer a standardized matched-rule/cascade API in the
  reviewed specification. It was not a ready replacement for CDP or Firefox RDP.

## Later workflow example

The optional JavaScript idea came from using a script such as
`/home/tburette/dev/lepaysanurbain/site/keep-overlay-open.js` to keep an overlay
open before inspection. This remains a later-stage idea.

## Earlier prototype and implementation ideas

The favored direction after research was a **small extension/adapter around the
official Chrome inspector implementation**, adding arbitrary DOM targeting and
retaining evidence discarded by its public formatter. Keep this provisional
until the integration is tested. Prefer existing matching/analysis code over
writing another cascade resolver, and avoid a new server/daemon/profile system
unless a concrete requirement justifies it.

1. Recheck upstream releases and prove a maintainable way to resolve an arbitrary
   DOM selector into the official DevTools model, obtain its matched styles and
   statuses, and preserve full source identity. Compare a focused upstream-style
   extension with reuse of the DevTools MCP entrypoint. Pin the tested browser
   and frontend/dependency combination.
2. Build the smallest prototype that can expose computed values, competing
   declarations, exact source identity, and partial-longhand status under one
   invocation. Inspect a decorative element absent from the accessibility tree,
   not just a heading/button that happens to have a snapshot UID.
3. Evaluate correctness using the tests below, plus a real page with generated
   styles. Compare observed output with browser rendering and expected source
   attribution. The prototype must resolve the hard status/provenance questions,
   not merely repeat the successful raw CDP collection experiment.
4. Make an explicit backend decision from the results. If a focused integration
   proves fragile or needs a substantial fork, record that rather than quietly
   replacing it with a simplified comparator. An extraction-only experiment may
   inform the decision, but is not an accepted substitute for the user's goal.
5. Package the proven backend behind the simple public command, a versioned
   output contract, concise skill instructions, current documentation, and
   component-local validation. Confirm supported hosts and installation layout.

Open decisions: component placement (new sibling versus web-inspector command),
dependency/licensing and update strategy, exact output/coverage schema, and
readiness controls. Keep automatic prose explanations and local source
correlation separate from the essential evidence contract, without pretending
those capabilities already exist.

## Useful articles and discussions

- [Chrome DevTools MCP issue #86](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/86):
  users describe essentially this requirement, including reusable DOM identity,
  source-linked rules and avoiding repeated evaluation scripts. Older claims
  that official MCP lacks CSS inspection predate its later implementation.
- [PR #2612 adding get_css_styles](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/2612):
  implementation context for official rule/cascade extraction.
- [Chromium discussion on deriving applied rules](https://groups.google.com/a/chromium.org/g/chromium-discuss/c/WXqX5ewGNXk):
  directly distinguishes matched candidates from active-declaration analysis.
- [CSS-in-JS support in DevTools](https://developer.chrome.com/blog/css-in-js):
  how engine-matched rules and reparsed/synthetic stylesheet text are joined for
  ranges; explains why generated locations need careful labeling.
- [DevTools CSS value parsing redesign](https://developer.chrome.com/blog/devtools-css-value-parsing):
  concrete failures of regex parsing for nested variables/fallbacks and the use
  of syntax trees. Value parsing is not itself a full cascade engine.
- [How browser-inspector-mcp was built](https://github.com/betson-g/browser-inspector-mcp/blob/main/building.md):
  lessons about live DOM identity, token budgets, viewport assumptions and
  attached interactive state. Treat its completeness claims separately from
  the actual filtering implementation.
- [Firefox starting-style discussion](https://bugzilla.mozilla.org/show_bug.cgi?id=1893409):
  different cascade contexts can make a declaration relevant in one situation
  and overridden in another.
- [Chrome DevTools MCP shadow-root inheritance report](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2949):
  a regression fixture to revisit; reported ancestor labels/UIDs were shifted.
  The investigation did not reproduce it or establish which release fixes it.
