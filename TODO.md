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

## CSS inspection tool for agents (planning stage)

A possible agent-facing tool for actual rendered CSS information for an element.
Similar to a browser devtools Rules view.
See `css-inspector/`.

## wordpress-inspector

- [x] Make authentication reports easier to find. When `wordpress-inspector authenticate` is run, it writes its result under a randomly named directory in `/tmp`; this avoids collisions and accidentally reusing old reports, but makes the result difficult for a user or agent to locate afterward. Keep that safe random directory as the default, and document an explicit option such as `--output-dir /tmp/wordpress-inspector/auth` for workflows that need a predictable location.

- [x] Make the successful `check-editor` result less confusing. At present, a healthy Gutenberg editor is reported as `AUTHENTICATED`, even though that command checks more than login status: it also verifies that the editor loaded correctly and that no fatal editor problems were detected. Rename this result to `EDITOR_HEALTHY` for `check-editor` only. Continue using `AUTHENTICATED` for admin/authentication checks and `EDITOR_SNAPSHOT_CAPTURED` for successful snapshots, and update the implementation, documentation, and tests accordingly.

- [x] reduce the number of needed arguments:
  - [x] make it possible to use wordpress-inspector (and web-inspector!) without
        `--profile`. It would then use a default (permanent) profile. Then
        `--profile` could be de-emphasized in SKILL.md.
        Make a test (with a fresh agent) to check if the tool works without passing
        profile. There is a default profile right? I'm not sure now..
  - [x] Make --base-url optional if it can be inferred (by --editor-url).
        and also update SKILL.md (and its examples!) to reflect that.
  - [x] make `authenticate` headed by default

- [x] Give the ability to wordpress-inspector to enter the admin login and password.
      If the user gave the agent the login and password (or the information is
      already known) then the login would be automated. Not even show the headed
      browser. I think that with web-inspector you can simulate clicks and entering
      input so that could be made to work.

- [x] Make `authenticate` go faster. At the moment it seems that the browser being
      closed by the user is not detected. If the user sets the login and password
      and close the browser then nothing happens. Either the user stops the agent
      waiting on the call to the tool it made and tell it that he did the job,
      otherwise a (long) timeout is hit.
      Could the script (tool) call end immediately when the browser is manually
      closed? That would be great to do that.
      Could the detection of whether login worked or not be automated?
      I wonder how the agent would know if the login was successful.. Is there an
      easy way? I guess for now assuming it worked (unless timeout was hit) is best..

- [x] Make `find-post` work on non-public content (drafts/private) too if that is possible.
      Through the web or well published methods only: authenticated REST API or by retrieving the page. No
      hacks, no wp-cli, no direct database access.
      The SKILL.md "Retrieve post ID from frontend URL" section will have to be updated accordingly.

- [x] wordpress-inspector/scripts/wordpress_inspector.mjs:145 (automatedLoginActions)
      is not checking the checkbox to remain connected

- [x] It turns out that (in codex) WEB_INSPECTOR_STATE_DIR is not needed. As long as
      the command that launches Chromium has elevated permission it will work fine.
      Modify SKILL.md in that light.Remove the section `Profile storage` from `Managed Codex sandbox` (wordpress-inspector/SKILL.md:59)
      Do not change the code (keep WEB_INSPECTOR_STATE_DIR in the code).

- A single higher-level command that does the entire job of `snapshot-editor` in a
  single command. It would trigger the command authenticate if needed, check the
  editor, report if there is an issue retrieving the gutenberg data, and take
  the snapshot, all in a single script call. This would make using the skill way
  easier

## website-visual-diff

- The visual comparison produces noisy diffs when a change shifts content vertically: every pixel below the shift is reported as changed even when the same content is only displaced. This makes it difficult to identify the actual visual differences and the location of the layout shift.

- make it possible to process in batch. At the moment an AI has to perform
  calls to the runner script one by one.
  There would instead be the possibility for the AI to gather a list of CSS Rule
  locations. have the tool run on all of them. then the AI could just use the result as
  it wish for example to extract result and inject it above the CSS rule.
  The idea comes from an agent doing :
  ```
    $ set -u
        runner=/home/tburette/dev/ai/ai-tools/website-visual-diff/scripts/run_visual_diff.mjs
        css=themes/lepaysanurbain/assets/css/theme.css
        ranges=(1140:1144 1146:1150 1152:1155 1157:1160 1177:1189 1191:1201 1203:1206)
        labels=(button-link-transition button-link-hover-focus button-link-focus-outline button-on-color button-arrow button-arrow-icon button-arrow-state)
        for i in "${!ranges[@]}"; do
          r=${ranges[$i]}
          outdir=$(mktemp -d /tmp/website-visual-diff.XXXXXX)
          errfile=$(mktemp /tmp/website-visual-diff-run.XXXXXX)
          result=$(node "$runner" 'http://lepaysanurbain.test:8888/lpu-sections-patterns-test/' --css-file "$css" --range "$r" --full-page --output-dir "$outdir" 2> "$errfile") || { cat
        "$errfile"; exit 1; }
          printf '%s\n' "$result" > "$outdir/run.json"
          cp "$errfile" "$outdir/run.stderr"
          comp="$outdir/comparison/01-lepaysanurbain.test-8888-lpu-sections-patterns-test/visual-diff.json"
          jq -r --arg rr "$r" --arg nm "${labels[$i]}" --arg od "$outdir" --arg vw "$(jq -r '.viewerPath' "$outdir/run.json")" '"\($rr)\t\($nm)\t\($od)\t\($vw)\t" + (.pairs |
        map("\(.name)=\(.changedPixels); height-changed=\(.dimensionMismatch)") | join(" | "))' "$comp"
        done
  ```

```

```

## session-search

- Compressed Codex session logs (`.jsonl.zst`) are skipped, so the skill answers
  "No session contains this string" when the match is only in archived history.
  That is the common case, not an edge case: on 2026-11-06 the stores held 1691
  compressed logs against 148 plain ones, so most of the corpus was invisible.
  `scripts/search_sessions.mjs` walks the log directories and keeps only names
  ending in `.jsonl` (`listCodexRollouts`), and its filename fallback for the
  session id anchors on `\.jsonl$`, so compressed logs need both the extension
  and that regex extended — otherwise the ones whose `session_meta` fails to
  parse all collapse into a single empty-id result. Observed: searching
  `--_wait_until` matched nothing while the string appeared on 23 lines of
  `~/.codex/sessions/2026/10/19/rollout-2026-10-19T22-09-31-*.jsonl.zst`.
  Accept `.jsonl.zst` too and decompress with the built-in
  `zlib.zstdDecompressSync` (Node 22.15+; the `node:sqlite` floor alone only
  needs 22.5), detecting it with `typeof` rather than a version string and
  falling back to `zstd -dc` when absent. Report compressed and plain counts
  separately in the Method section, and warn there instead of skipping silently
  when decompression is unavailable. Update SKILL.md "Where the data lives" and
  the "Node built-ins only; Node 22+" line at SKILL.md:41, and add a scripted
  check (no test harness exists today) that builds a temp store with one plain
  and one compressed log and asserts both match.

## run-at

- Drop the vestigial self re-execution in `bin/run-at`. The script `exec`s itself
  with an internal `--_wait_until <epoch>` mode that sleeps and then execs the
  command. That two-phase split originally existed so the wait could run as a
  child of `systemd-inhibit`, which can only wrap an external command (recorded
  in the authoring session `01a155c8-982d-7e60-a0a8-b9f6c234ee67`; the repo
  history is a single commit). The inhibitor was later replaced by setting
  GNOME's plugged-in "Automatic Suspend" to `nothing`, so the second phase now
  has nothing wrapping it. What remains is dead complexity plus a hard `readlink`
  dependency that exists only to feed the re-exec, and a message prefix that
  changes mid-run when invoked through a symlink (`foo: waiting until ...`
  becomes `run-at: starting command`, because the inner process re-derives
  `${0##*/}` from the resolved path). Move the wait — `date`, `sleep`, then
  `exec "$@"` — into the main path, delete the `--_wait_until` branch and the
  now-unused `script_path=$(readlink -f ...)` line, and drop `readlink` from
  README.md:7. Keep the messages and exit status identical; derive the printed
  target from `$target` (the epoch), not `$when`, or the absolute/TZ formatting
  changes. Verify with `bash -n` and the one-minute check in README.md:71.
