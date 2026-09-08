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

- Make authentication reports easier to find. When `wordpress-inspector authenticate` is run, it writes its result under a randomly named directory in `/tmp`; this avoids collisions and accidentally reusing old reports, but makes the result difficult for a user or agent to locate afterward. Keep that safe random directory as the default, and document an explicit option such as `--output-dir /tmp/wordpress-inspector/auth` for workflows that need a predictable location.

- Make the successful `check-editor` result less confusing. At present, a healthy Gutenberg editor is reported as `AUTHENTICATED`, even though that command checks more than login status: it also verifies that the editor loaded correctly and that no fatal editor problems were detected. Rename this result to `EDITOR_HEALTHY` for `check-editor` only. Continue using `AUTHENTICATED` for admin/authentication checks and `EDITOR_SNAPSHOT_CAPTURED` for successful snapshots, and update the implementation, documentation, and tests accordingly.

- reduce the number of needed arguments:
  - make it possible to use wordpress-inspector (and web-inspector!) without
    `--profile`. It would then use a default (permanent) profile. Then
    `--profile` could be de-emphasized in SKILL.md.
    Make a test (with a fresh agent) to check if the tool works without passing
    profile. There is a default profile right? I'm not sure now..
  - Make --base-url optional if it can be inferred (by --editor-url).
    and also update SKILL.md (and its examples!) to reflect that.
  - make `authenticate` headed by default

- Give the ability to wordpress-inspector to enter the admin login and password.
  If the user gave the agent the login and password (or the information is
  already known) then the login would be automated. Not even show the headed
  browser. I think that with web-inspector you can simulate clicks and entering
  input so that could be made to work.

- Make `authenticate` go faster. At the moment it seems that the browser being
  closed by the user is not detected. If the user sets the login and password
  and close the browser then nothing happens. Either the user stops the agent
  waiting on the call to the tool it made and tell it that he did the job,
  otherwise a (long) timeout is hit.
  Could the script (tool) call end immediately when the browser is manually
  closed? That would be great to do that.
  Could the detection of whether login worked or not be automated?
  I wonder how the agent would know if the login was successful.. Is there an
  easy way? I guess for now assuming it worked (unless timeout was hit) is best..

- Make `find-post` work on non-public content (drafts/private) too if that is possible.
  Through the web or well published methods only: authenticated REST API or by retrieving the page. No
  hacks, no wp-cli, no direct database access.
  The SKILL.md "Retrieve post ID from frontend URL" section will have to be updated accordingly.
