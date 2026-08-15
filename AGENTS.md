# AGENTS.md

This repository contains source code, skills, command-line utilities.

## Repository scope

- Tools should be built for both opencode and codex.
- Each top-level directory is the directory of a tool (or skill or ...). It should be possible to just copy and paste it into the proper Agentic tool directory and it should work.
- The tools should remain independenty understandable and usable. Do not create unnecessary coupling between unrelated tools. One directory = one tool.
- Keep generic mechanisms separate from application-, platform-, or project-specific adapters when that boundary improves reuse or safety.

## Source of truth and installed copies

- Treat this Git repository as the source of truth not the directories where the tools where installed.
- Do not edit generated, cached, copied, or installed versions of a tool as a substitute for changing its source here.
- When an  installed tool needs to be changed, update the source here first, validate it, and perform an eventual installation or synchronization only after warning the user and having obtained his approval to install.
- Never edit dependency directories such as `node_modules/`.

## Before making changes

- Confirm the repository root and inspect `git status` before editing.
- Preserve unrelated user changes. If the worktree is dirty, warn the user and stop work if (really) necessary. Distinguish the user's changes from the current task and avoid overwriting them.
- Search for existing conventions and reusable helpers before adding new files or abstractions.
- Clarify or document assumptions that materially affect public behavior, security, portability, or compatibility.

## Design principles

- Keep public interfaces explicit. Avoid hidden environment discovery, surprising side effects, and silent fallback behavior unless they are part of a documented contract.
- Use the simplest design that meets the demonstrated need. Record meaningful limitations rather than adding speculative complexity.

## Documentation and skill packaging

- Update documentation in the same change as user-visible behavior.
- Keep command examples runnable and consistent with current interfaces.
- Document defaults, precedence, side effects, persistent state, security considerations, limitations, and troubleshooting relevant to the feature.
- If a directory is an agent skill, keep its `SKILL.md` complete and accurate and update any agent metadata when its purpose or invocation changes.
- Skill instructions should identify the correct tool for the task, define safety boundaries, and tell the agent how to validate results without embedding project-specific facts in a generic skill.
- Keep implementation plans clearly marked as plans. Do not present planned commands or files as already available.

## Do not

- Do not edit files outside this repository as part of a tool change unless the user explicitly puts those files in scope.
- Do not conceal failures with broad exception handling, unconditional success exit codes, or undocumented fallbacks.
- Do not place application-specific logic into a generic tool merely because one immediate consumer needs it.
