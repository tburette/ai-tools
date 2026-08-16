# AGENTS.md

This repository is the source for a collection of agent tools, skills, and command-line utilities. Each top-level component is independently maintained.

## Repository map

- `pagefetch/` is a Node.js CLI. Its shared implementation is under `src/`, its CLI entry point is under `bin/`, and its OpenCode and MiMoCode adapters live under `tools/`.
- `pagefetch/delay-server/` is a separate local development utility with its own package manifest, CLI, README, and tests. It is not a root-level test runner.
- `web-inspector/` is a `SKILL.md`-based Playwright inspection tool. Its Codex metadata is in `agents/openai.yaml`, and its runner, profile commands, and smoke tests are in `scripts/`.
- `wordpress-inspector/` is a `SKILL.md`-based read-only WordPress/Gutenberg adapter over the sibling `web-inspector/` tool. Its fixture smoke test and CLI are in `scripts/`.
- `session-search/` is a standalone Node.js skill for searching local Codex and OpenCode session stores. Its runtime requirement and privacy boundary are documented in its `SKILL.md`.
- `lastscreenshot/` is a user-local Bash utility. It depends on `xclip` and the user's `~/Pictures/Screenshots` directory, and it writes the path to the last screenshot taken to the clipboard.

Treat each component directory as independently understandable and usable unless its documentation explicitly describes a nested component.

## Compatibility and component boundaries

- The compatibility goal for new or changed agent-facing tools is Codex and OpenCode where adapters exist. Each component must document and validate its actual supported hosts; do not claim compatibility based only on the repository-wide goal.
- Keep reusable mechanisms independent from agent-, platform-, or application-specific adapters. Put shared behavior in the component's core and keep adapters thin.
- For every user-visible tool or skill change, keep its documentation current: supported hosts, prerequisites, installation/copy/link steps, runnable examples, outputs and side effects, limitations, security considerations, and validation.
- Keep `SKILL.md` front matter, trigger descriptions, instructions, and any agent metadata accurate. Move detailed, optional material to tool-local documentation or references rather than duplicating it in this root file.

## Before making changes

- Confirm the repository root with `git rev-parse --show-toplevel` and inspect `git status --short` before editing.
- Preserve unrelated user changes. If dirty files overlap the intended change or their ownership is unclear, stop and ask for direction. Otherwise, leave them untouched and work around them.
- Read the closest `README.md`, `SKILL.md`, package manifest, tests, and platform adapter before changing a component. Search for existing conventions and reusable helpers before adding files or abstractions.
- Treat nested `AGENTS.md` or `AGENTS.override.md` files as more-specific guidance when they exist; do not duplicate their component-specific instructions in this root file. Preserve the Codex/OpenCode layering they define and continue to apply this root file's invariant safety rules.

## Source of truth, installation, and dependencies

- Change the source in this repository first. Do not edit installed, generated, cached, copied, or linked copies instead of their source.
- Never edit `node_modules/`, global package directories, browser caches, or installed copies under locations such as `~/.codex`, `~/.config/opencode`, or `~/.config/mimocode` as a substitute for a source change.
- Before synchronizing or installing a changed component into `~/.codex`, `~/.config/opencode`, `~/.config/mimocode`, or another host-owned directory, warn the user and obtain approval; source validation comes first.
- Do not treat historical implementation plans as executable authorization: verify paths, commands, ownership, and current behavior before using them.

## Design and documentation principles

- Keep public interfaces explicit. Use the simplest design that meets the demonstrated need, and record meaningful limitations instead of adding speculative complexity.
- Update documentation in the same change as user-visible behavior. Keep examples runnable and consistent with current interfaces, and document relevant defaults, precedence, persistent state, security considerations, limitations, and troubleshooting.
- Skill instructions should identify the correct tool for the task, and explain how to validate results without embedding application-specific facts in generic skills.
- Do not conceal failures with broad exception handling, unconditional success exit codes, or undocumented fallbacks.
- Do not place application-specific behavior in a generic tool just because one immediate consumer needs it.

## Validation and artifacts

- There is no root package manifest, Makefile, or root-wide test command. Run the validation documented by the component you changed; do not invent a repository-wide install step.
- Prefer syntax checks and component-local smoke tests before broader integration checks. Existing browser tests resolve already-installed Playwright runtimes and must not download dependencies implicitly.
- Keep generated screenshots, reports, fetched pages, session-search output, and other sensitive captures out of commits unless the user explicitly requests them.
