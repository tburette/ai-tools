# Installation

Expose the source to both hosts with links, after checking that the two destinations are absent or already point to this source:

```bash
mkdir -p ~/.codex/skills ~/.config/opencode/skills
ln -s /home/tburette/dev/ai/ai-tools/website-visual-diff ~/.codex/skills/website-visual-diff
ln -s /home/tburette/dev/ai/ai-tools/website-visual-diff ~/.config/opencode/skills/website-visual-diff
```

Do not replace an existing directory or link silently.

The skill `web-inspector` must be installed as a sibling of this skill.

## Local websites and Codex permissions

When capturing a local website, Codex's network permissions must allow the browser to reach the local service. This applies to `localhost`, `127.0.0.1`, and DNS names that resolve to a local service, such as `my-site.test`.

Add or adapt a permission profile in the project's `.codex/config.toml` (the profile must be active for the Codex session):

```toml
default_permissions = "local-website"

[features]
network_proxy = true

[permissions.local-website]
description = "Local website visual testing"
extends = ":workspace"

[permissions.local-website.network]
enabled = true
allow_local_binding = true

[permissions.local-website.network.domains]
"my-site.test" = "allow"
"*.my-site.test" = "allow"
```

`allow_local_binding = true` enables access to local bindings such as `localhost` and `127.0.0.1`. Add each DNS hostname that points to the local service to the `domains` allowlist; add a wildcard when subdomains are needed. Keep the allowlist limited to the development hosts you trust, then start a new Codex session so the configuration is applied.

## Validation

From the skill source directory, run:

```bash
python3 /home/tburette/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
node scripts/smoke_test.mjs
```

The smoke test uses temporary files under `/tmp` and removes them. Browser smoke testing belongs to the companion `web-inspector` skill; this skill's end-to-end runner can be tested with an injected capture adapter when Chromium is not appropriate for a unit test.

The generated viewer opens automatically for the CSS experiment runner. By default, the complete report bundle is copied to `~/Downloads/website-visual-diff/` before it is opened; the original artifacts remain in the requested output directory. Pass `--no-viewer-relocation` to open the requested output path directly, or `--no-open` to skip launching a viewer. A symlink is not sufficient for Firefox Snap confinement because it would still resolve to the inaccessible original directory.

CSS experiments rewrite the target stylesheet in place to preserve its inode. This keeps changes visible through Docker Desktop bind mounts; the saved state file is still written atomically and the stylesheet is restored after the run.
