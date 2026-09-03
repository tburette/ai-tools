# Possible improvements

## pagefetch

- pagefetch does not check HTTP status codes: 404/500/... pages are returned
  as rendered HTML with no indication the fetch failed. Expose the
  HTTP status (or treating non-2xx as an error) so errors aren't missed.

- Add an option to return plain text or markdown instead of raw HTML. Both can
  be implemented in `src/fetcher.js` without changing the browser launch:
  - **Text** (like web-inspector's `domSummary.bodyText`): in the existing
    `page.evaluate()` return `document.body.innerText` (CSS-aware visible text)
    instead of `document.documentElement.outerHTML`. web-inspector additionally
    normalizes whitespace with `.trim().replace(/\s+/g, " ")`; reuse that.
    See web-inspector `~/dev/ai/ai-tools/web-inspector/scripts/capture_page.mjs:255`.

  - **Markdown** (like the built-in opencode `webfetch` tool): feed the already-fetched
    HTML through TurndownService with webfetch's exact options
    (`headingStyle: "atx"`, `hr: "---"`, `bulletListMarker: "-"`,
    `codeBlockStyle: "fenced"`, `emDelimiter: "*"`) and
    `turndownService.remove(["script", "style", "meta", "link"])`.
    See opencode `packages/opencode/src/tool/webfetch.ts:182-190`
    (https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/webfetch.ts).
    Note for a browser-rendered page you cannot reuse webfetch's plain-HTTP
    path (no JS); instead add `turndown` as a dependency to pagefetch's
    package.json (it is already bundled in the opencode binary, so the code is
    proven) and run it on the `outerHTML` result. This would give pagefetch
    render-based markdown that webfetch cannot produce for SPAs.
    Turndown is a small open-source (MIT) HTML-to-Markdown converter,
    https://github.com/mixmark-io/turndown.

## web-inspector

- Profile concurrency: two commands using the same persistent profile at once
  fail deep inside Chromium ("user data directory in use"). Find a way to make
  it reentrant or add a pre-launch lockfile check with an actionable error.

## wordpress-inspector

- Make `find-post` work on non-public content (drafts/private) too if that is possible.
  Through the web or well published methods only: authenticated REST API or by retrieving the page. No
  hacks, no wp-cli, no direct database access.
  The SKILL.md "Retrieve post ID from frontend URL" section will have to be updated accordingly.

- Make `check-editor` work on any content that can be edited by Gutenberg:
  navigation, template, template part, etc. — not just `post.php` and
  `site-editor.php`. The URL validation in `normalizeEditorUrl` and the
  SKILL.md documentation will need updating.

- A shorter representation of the blocks structure in the file output. It will not replace the 
  snapshot-editor/blocks.json representation but be another (shorter) representation. Represent the 
  blocks structure as an ascii tree with some basic info for each block such as the type (name),
  classes, key attribute,..; not too much to still be readable but enough to be useful.
