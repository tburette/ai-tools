# session-search

Skill: find past AI-tool sessions (opencode and codex) whose conversation contains a
string, and get back the session id and the directory each was started from.

Conversation text lives in tool-specific stores: opencode's SQLite database
and codex's JSONL session logs.

## Usage

```bash
node scripts/search_sessions.mjs "search term"
```

Output: a "Method" section (which stores/tables/files were searched, as an overview),
then the matches (`[tool] <session-id>  <slug/thread>  <date>  <directory>`), then a
resume action:

- one match  → `cd <directory> && opencode --session <id>` (or `codex resume <id>`)
- many matches → the list + the generic resume command reminder
- none → explicit "no match" message

Case-insensitive. Reads everything read-only.

## What it searches

| Tool | Store | Searched | Metadata source |
|------|-------|----------|-----------------|
| opencode | `~/.local/share/opencode/opencode.db` (SQLite) | `part`, `message` tables (JSON conversation content) | `session` table: id, slug, directory, date |
| codex | `~/.codex/sessions/**/*.jsonl` + `~/.codex/archived_sessions/*.jsonl` | full file contents | first line (`session_meta`): `session_id`, `cwd`; `session_index.jsonl` for thread names |

## Install

The skill is tool-agnostic, so one copy works in both. To register it:

- **opencode** — copy the whole directory to
  `~/.config/opencode/skills/session-search/` (or add the repo path to
  `skills.paths` in `opencode.json`).
- **codex** — copy the whole directory to `~/.codex/skills/session-search/`.

Keep the copy a copy of `~/dev/ai/ai-tools/session-search/` (the source of truth) and
re-sync after editing. The SKILL.md references `scripts/search_sessions.mjs` relative to
itself, so the copy works anywhere.

Requires Node >= 22 (uses `node:sqlite`).
