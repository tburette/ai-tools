---
name: session-search
description: Find past AI-tool sessions (opencode and codex) by searching their conversation text for a string. Use when the user remembers a phrase or keyword from an earlier conversation and wants the session id, the directory it was started from, or to resume that session.
---

# Session Search

Search the stored conversations of both **opencode** and **codex** for a string, and get back, for each matching session, its **session id** and the **directory it was started from**. Works the same whether this skill is running inside opencode or codex: it always searches both tools' session stores.

Use it when the user says things like "find the session where I …", "I fixed X in a previous session", "resume that conversation about …", or asks which directory a past session was opened from.

## How to run

The script lives next to this SKILL.md at `scripts/search_sessions.mjs`. Run it from the skill directory or by its absolute path:

```bash
node scripts/search_sessions.mjs "the string to search"
```

Pass the string as a single argument. The search is case-insensitive. If nothing matches, suggest a shorter substring or a different keyword before concluding the conversation never happened.

## Reading the output

The script prints three sections:

1. **Method** — how the search was done, as an overview, not the raw queries. For opencode it names the SQLite database and the tables searched (`part`, `message`; joined with `session`). For codex it names the directory of JSONL session logs, how many were scanned, and that the id/cwd came from the first line (`session_meta`). Show this to the user so they can judge coverage.
2. **Results** — one line per match: `[tool] <session-id>  <slug/thread>  <date>  <directory>`.
3. **Resume action** — shaped by the number of matches:

- **Exactly one match:** print the single line `cd <directory> && <tool-resume> <session-id>` as a ready-to-run bash command (`opencode --session <id>` for opencode results, `codex resume <id>` for codex ones). That is the main answer.
- **Several matches:** show the full list, then add the generic resume reminder:
  - `opencode --session <session-id>`
  - `codex resume <session-id>`
- **No matches:** say so plainly; do not fabricate an id.

## Where the data lives

- **opencode** — SQLite database `~/.local/share/opencode/opencode.db` (plus any `opencode.db` under `~/.local/share/opencode/`). Conversation content is JSON in the `part` and `message` tables; the `session` table holds id, slug, directory, and creation time.
- **codex** — JSONL session logs under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` and `~/.codex/archived_sessions/`. The first line of each file (`session_meta`) records the `session_id` and the `cwd`. `~/.codex/session_index.jsonl` optionally maps ids to thread names.

The script is self-contained (Node built-ins only; Node 22+ for `node:sqlite`) and reads everything read-only.

## Resuming a session

- opencode: `opencode --session <session-id>` (resumes in the session's recorded directory; add `--fork` to branch instead).
- codex: `codex resume <session-id>` (or `codex resume --last` for the most recent session).

These commands are printed by the script; use them, or tell the user to run them, rather than opening a session by hand.
