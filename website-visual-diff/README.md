# Installation

Expose the source to both hosts with links, after checking that the two destinations are absent or already point to this source:

```bash
mkdir -p ~/.codex/skills ~/.config/opencode/skills
ln -s /home/tburette/dev/ai/ai-tools/website-visual-diff ~/.codex/skills/website-visual-diff
ln -s /home/tburette/dev/ai/ai-tools/website-visual-diff ~/.config/opencode/skills/website-visual-diff
```

Do not replace an existing directory or link silently.

The skill `web-inspector` must be installed as a sibling of this skill.

## Validation

From the skill source directory, run:

```bash
python3 /home/tburette/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
node scripts/smoke_test.mjs
```

The smoke test uses temporary files under `/tmp` and removes them. Browser smoke testing belongs to the companion `web-inspector` skill; this skill's end-to-end runner can be tested with an injected capture adapter when Chromium is not appropriate for a unit test.

CSS experiments rewrite the target stylesheet in place to preserve its inode. This keeps changes visible through Docker Desktop bind mounts; the saved state file is still written atomically and the stylesheet is restored after the run.
