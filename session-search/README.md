# session-search

Skill: find AI-tool sessions (opencode and codex) whose conversation contains a
string, and get back the session id and the directory each was started from.

Conversation text lives in tool-specific stores: opencode's SQLite database
and codex's JSONL session logs.

## Usage

```bash
node scripts/search_sessions.mjs "search term"
```
The search is case insensitive.
Output the conversation(s) found.

## Install

To register it:

- **opencode** — copy the whole directory to
  `~/.config/opencode/skills/session-search/`
- **codex** — copy the whole directory to `~/.codex/skills/session-search/`.
