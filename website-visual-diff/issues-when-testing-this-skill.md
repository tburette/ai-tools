### 1. The local WordPress site appeared to be offline even though it was running

The visual diff targeted a local WordPress URL:

`http://lepaysanurbain.test:8888/lpu-sections-patterns-test/`

The WordPress environment was running on the host machine, but the diagnostic commands were executed inside a restricted sandbox. From there, `curl` reported errors such as:

```text
Could not resolve host: lepaysanurbain.test
Couldn't connect to server
```

The sandbox’s `wp-env status` check also reported `stopped`, which was not reliable in this situation. The successful elevated run later returned HTTP 200 for both captures, proving that the WordPress site itself was available.

The problem is that the skill does not explain that a sandbox may be unable to access services running on the host machine. An agent could incorrectly conclude that WordPress is stopped and ask the user to restart or reset it.

A better instruction would be:

> When testing a local `.test`, `localhost`, or host-mapped Docker URL, sandbox networking may make a running site appear unavailable. Do not recommend starting, stopping, or resetting the environment based only on sandbox-local `curl` or status results. If the user says the site is running, retry the browser capture with the required elevated permissions.

Potential solution using Codex permissions:

> Run the skill under a permission profile with command network access and the network proxy enabled, `allow_local_binding = true`, and an allowlist for `lepaysanurbain.test` and `*.lepaysanurbain.test`. This is a likely fix for sandboxed `curl`/Playwright being unable to reach the running host service, provided the runtime is actually using permission profiles; otherwise retry the capture with elevated execution.

---

### 2. Chromium failed before it ever reached the website

The first browser attempt failed during browser startup, before navigation or CSS inspection. The visual-diff runner only reported:

```text
before capture ... failed: exit 1
```

A separate diagnostic was needed to expose the real Chromium error:

```text
FATAL:content/browser/sandbox_host_linux.cc:41
Check failed: . shutdown: Operation not permitted (1)
```

This error should have been visible right away

This is an operating-system restriction imposed by the execution sandbox. It is not a WordPress, CSS, URL, or selector problem.

The issue is that the visual-diff runner hid the useful browser-launch details and presented only a generic exit code. Someone unfamiliar with the runner could waste time investigating the CSS or the WordPress page.

The runner should include the child process’s stderr and browser log in the final error, for example:

```text
Chromium could not start because the execution sandbox denied
sandbox_host shutdown. Retry the capture with elevated execution.
```

The skill should also document this as a known failure mode for local visual testing.

Potential solution

> better diagnostic, inform of the real issue. The runner should preserve the child process's stderr so this cause is visible in the final error.

> using elevated execution: Retry the browser capture with elevated permission. The `sandbox_host_linux.cc:41 Operation not permitted` error occurs before navigation and indicates an OS/browser-sandbox compatibility problem;

---

### 3. Firefox was not a reliable fallback for this local `.test` URL

After Chromium failed, Firefox was tried as an alternative. Firefox did launch, but it could not load the local WordPress URL. Its report contained:

```json
{
  "finalUrl": "about:blank",
  "status": null,
  "failedRequests": [
    {
      "error": "NS_ERROR_OUT_OF_MEMORY"
    }
  ]
}
```

The error message suggested a memory problem, but the page had not loaded at all. The more relevant detail was:

```json
"localMapRequested": true,
"localMapApplied": false
```

The capture system uses Chromium-specific host resolver rules to map `.test` domains to `127.0.0.1`. Firefox does not support that same mapping mechanism and relies on operating-system DNS or `/etc/hosts`.

The skill should explicitly explain:

> Chromium is the preferred browser for local host-mapped domains. Firefox cannot use the runner’s Chromium host mapping and may fail with confusing navigation errors when `.test` DNS is unavailable.

The runner could also detect this situation and report “local hostname resolution unavailable” instead of exposing the misleading Firefox error alone.

Potential solution:
the updated .codex/config.toml of /home/tburette/dev/lepaysanurbain/site/wordpress-lpu/.codex/config.toml might be a solution. If so do nothing.

---

### 4. Reusing an output directory allowed stale screenshots to look current

The first visual-diff attempt used a fixed directory:

```text
/tmp/lpu-split-v2-visual-diff
```

That directory already contained screenshots and reports from an older run. The new attempt failed before writing fresh captures, but the old files remained. It was therefore possible to inspect old screenshots while believing they belonged to the new experiment.

The timestamps showed that the `run.json` was newer than the screenshots and comparison report. This was an important warning sign that I only discovered after inspecting the files.

This is dangerous because stale visual evidence can lead to an incorrect conclusion about a CSS change.

The runner should either:

- refuse to use a non-empty output directory;
- create a unique run directory automatically;
- or clearly mark and remove only its own incomplete artifacts.

The SKILL.md should also recommend a fresh directory, such as:

```bash
--output-dir "$(mktemp -d /tmp/website-visual-diff.XXXXXX)"
```

At minimum, the runner should verify that the screenshot and report timestamps belong to the current run.

---

### 5. Automatic viewer relocation assumed that `~/Downloads` existed

The visual-diff runner automatically attempted to copy the HTML viewer to:

```text
~/Downloads/website-visual-diff/
```

In the container, the parent `Downloads` directory did not exist, so the runner emitted:

```text
Could not prepare the relocated HTML viewer:
ENOENT: no such file or directory,
mkdir '/home/tburette/Downloads/website-visual-diff'
```

This did not prevent the screenshots from being generated, but it added noise and initially made the run look less reliable.

The skill mentions that viewer relocation can fail, but it does not clearly say that this is expected in containers or headless environments.

Possible improvements:

- create the parent directory recursively;
- fall back automatically to the requested output directory;
- provide a `--no-open` option in addition to `--no-viewer-relocation`;
- document `--no-viewer-relocation` as the recommended container option.

If a config.toml file solve this issue then do nothing.

---

### 6. The intended viewport and capture mode were not specified clearly

The user supplied a URL and CSS reference, but no viewport or full-page setting.

The runner’s actual defaults are:

- one viewport: 1440×1100;
- `fullPage: false`.

The example in the SKILL.md uses:

- 1440×1100;
- 390×844;

I followed the example and used both desktop and mobile full-page captures, but that was an assumption.

The skill should define a clear policy:

> If the user does not specify viewports, use the standard matrix of 1440×1100 and 390×844 with full-page capture.

---

### 7. The browser reports required manual schema discovery

The skill correctly requires checking:

- HTTP status;
- navigation errors;
- failed requests;
- page errors;
- action failures;
- image loading;
- final document dimensions.

However, the report structure is not obvious. The values are nested under each entry in `.viewports[]`. Image loading and dimensions are nested further under `.domSummary`.

For example, the final document dimensions are stored as:

```json
.viewports[].domSummary.documentWidth
.viewports[].domSummary.documentHeight
```

The image information is stored as:

```json
.viewports[].domSummary.images[]
```

There is no ready-made summary command in the skill, so I had to inspect the complete JSON to discover the structure.

Either the report file or summary should be simplified or
the SKILL.md could include a standard verification command such as:

```bash
jq '.viewports[] | {
  viewport,
  status,
  navigationError,
  pageErrors,
  failedRequests,
  failedResponses,
  actionResults,
  documentWidth: .domSummary.documentWidth,
  documentHeight: .domSummary.documentHeight,
  images: [.domSummary.images[] | {
    src,
    complete,
    naturalWidth
  }]
}' report.json
```

It would be really nice if the runner could also produce a simple readable
report..

---

### 8 remove symbol-range altogether

context-lines is the only value used.
I'm talking about the human-readable reference copied by the vscode extension
copy-file-ref which can write `path/to/file.css:26 (.selector) [context-lines=20-28]`

---

### 9. The saved metadata was not fully consistent

The command used:

```text
--no-viewer-relocation
```

The main run correctly recorded that setting as false. However, the separately generated `visual-diff.json` still recorded:

```json
"relocateViewer": true
```

because the comparison script used its own default and was not passed the parent run’s setting.

Also, the console output included the final `outputDir` and `viewerPath`, but those final values were not fully persisted in `run.json`.

This makes it harder for someone reviewing the artifacts later to know exactly how the run was performed and where its viewer is located.

relocateViewer should not be part of visual-diff.json, not an interesting info.
