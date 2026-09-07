---
name: session-extract
description: Extract the full conversation of a past AI-tool session (opencode or codex) from its session id, rendered as a readable transcript, --json for structured output. Use when the user gives a session id (a ses_… opencode id or a UUID codex id) and wants the whole conversation back, e.g. to review, replay, feed to another tool, or continue an old thread's work.
---

# Session Extract

Given a session id, print the entire conversation of that session — every user message, assistant reply, reasoning step, and tool call/result — regardless of which tool created it.

- **opencode** ids look like `ses_…` and live in the SQLite store `~/.local/share/opencode/opencode.db`.
- **codex** ids are UUIDs and live as JSONL rollout logs under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` and `~/.codex/archived_sessions/`.

Companion to the session-search skill: session-search goes keyword → session id; session-extract goes session id → full transcript.

## How to run

The script lives next to this SKILL.md at `scripts/extract_session.mjs`. Run it by its absolute path:

```bash
node scripts/extract_session.mjs <session-id>
```

The tool is auto-detected from the id shape (`ses_…` → opencode, UUID → codex). If the id shape is ambiguous, both stores are tried. Force a store with `--tool=opencode|codex`.

Options:

- `--no-reasoning` — omit reasoning blocks from the transcript.
- `--no-tools` — omit tool calls and outputs.
- `--max-output=<n>` — truncate each tool input/output and reasoning block to `<n>` chars (default: unlimited).
- `--json` — emit the full structured transcript (session meta, stats, ordered items) as JSON, for piping into other tools.

`session-search` output gives you the ids to pass here.

## Reading the output

1. **Header** — session id, tool, directory it was started from, slug/title/thread, start time (UTC), model, agent, and counts (user/assistant/reasoning/tool). The `Method:` line names the exact database or rollout files read, so coverage is verifiable.
2. **Transcript** — chronological items:
   - `## user` / `## assistant` — messages, with the codex commentary vs final phases tagged.
   - `### reasoning` — opencode stores plaintext reasoning; codex stores only summaries (full reasoning is E2E-encrypted in the rollout, which the script says explicitly).
   - `### tool <name>` — tool call: input and output, folded back into the call.

## Notes and limitations

- Codex user messages include app-injected blocks (`<recommended_plugins>`, `<environment_context>`, `<turn_aborted>`); they are stripped or reduced to a short annotation so the transcript is the actual conversation.
- Codex reasoning content is encrypted at rest and cannot be reconstructed — only its stored summaries print.
- A session that was continued or archived across days may span several rollout files; all matching files are merged in time order and duplicates are dropped.
- The tool never writes anything; it reads the stores read-only (Node built-ins only; Node 22+ for `node:sqlite`).