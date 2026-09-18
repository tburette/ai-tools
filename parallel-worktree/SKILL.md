---
name: parallel-worktree
description: Create an isolated Git worktree for an implementation task and launch a completely independent Codex CLI instance in a new GNOME Terminal. Use when the user wants to delegate a task to another Codex instance for parallel work, review, and later merge.
---

# Codex parallel worktree

Use this skill to delegate the user's task to a **separate Codex CLI process** working in its own Git worktree and terminal.

All scripts are relative to the skill directory (`cd` into it first or call by absolute path). The preflight and launch commands must still run with the user's project as their working directory, because `../<slug>` is relative to that directory; when the project is not the skill directory, call the bundled script by its absolute path.

## Core rule

The spawned Codex instance is completely independent.

After launching it:

- Do **not** interact with, monitor, steer, or resume the spawned Codex process.
- Do **not** use its terminal.
- Do **not** inspect its working tree while it is working.
- Do **not** wait for its completion.
- Your only responsibilities are:
  1. validate the current repository state;
  2. choose/create the worktree and branch;
  3. construct a high-quality handoff prompt;
  4. launch a new GNOME Terminal containing the new Codex instance;
  5. report to the user where the worktree is and what branch was created.

The user will manage the other Codex instance directly.

## Intended workflow

The user gives a task such as:

> Implement the new responsive navigation behavior described in ...

You will then :

- create a dedicated git worktree (in the parent directory). It will also result in a new branch
- new Gnome terminal in that directory, In that new terminal an independant codex instance is started with its instructions.

The user's current Codex session remains in its original state.

## Before creating anything

Run the bundled read-only preflight script before choosing a slug. It takes no arguments and prints the repository root, current status, local branch names, existing worktrees, every entry in the current working directory's parent (`..`), and the rules for selecting a collision-free slug. Do not call extra commands.

Invoke the bundled script using its path relative to the skill directory (or its absolute path while keeping the project as the working directory):

```bash
scripts/preflight-worktree.sh
```

Read the labeled output, then choose a short slug. The slug must be used exactly as the local branch name and sibling worktree directory name; never prepend `codex/`.

Do not destroy, stash, reset, or commit the user's existing changes.

## Worktree and branch naming

Derive a short slug from the user's task.

Use it for the branch and the matching worktree directory.

Use the sibling directory `../<slug>` relative to the current working directory.
Do not create a worktree inside another worktree.

Use the preflight output to check whether the target branch, worktree, or `../<slug>` parent entry already exists. If any does, do not overwrite it. Choose another slug or add a suffix such as `-2`, `-3`, etc., and tell the user.

Create it with native Git:

```bash
git worktree add "../<slug>"
```

Create and launch in one command. Replace `scripts/spawn-codex-worktree.sh` below with the absolute path to that bundled script when this command runs from the project directory. Because the launcher opens GNOME Terminal, run this entire command with the tool's `sandbox_permissions: require_escalated` GUI permission; do not first attempt the launcher in the sandbox, since that only creates an avoidable display-access failure:

```bash
git worktree add "../<slug>" && \
git -C "../<slug>" status --short --branch && \
scripts/spawn-codex-worktree.sh \
  "../<slug>" \
  "<delegated-prompt>"
```

The post-create status check is sufficient verification; do not run a second `git worktree list` unless the command fails or the user asks for it.

## Prepare the delegated prompt

The spawned agent must receive the user's original task verbatim, plus operational instructions.

The launcher's second argument is the complete prompt constructed below, passed as one shell-quoted argument. `<delegated-prompt>` in the command example is only a placeholder; it is not a predefined environment variable.

Construct a prompt with these sections:

### Task

Start the handoff with the user's task for the new Codex instance copied verbatim. Preserve the exact wording, punctuation, paths, mentions, parenthetical notes, examples, requirements, constraints, and acceptance criteria. Do not paraphrase, summarize, correct, or silently omit any part of the task. Keep skill invocations such as `$parallel-worktree` in the copied task. Put any operational instructions in separate sections after the verbatim task.

### Working context

Tell the agent:

- it is working in a dedicated Git worktree;
- it must not touch other worktrees;
- it must work only on the task;
- it should follow existing project conventions;

### Implementation focus

The primary objective is to **implement the user's requested changes**.

Tell the agent to:

1. Understand the relevant architecture before editing.
2. Before starting to implement the task, It should stop and ask the user if there is a major issue, multiple valid implementation, an important question or anything else critical he has to answer before implementation starts. This exchange is expected to take place most of the time unless the time is simple, focused and has no ambiguity.
3. Implement the task completely rather than merely describing a solution.
4. Keep the diff focused.
5. Prefer the simplest implementation that satisfies the request.
6. Avoid speculative improvements and unrelated cleanup.
7. Do not turn the task into a broad refactoring exercise.

### Testing and validation

Testing is intentionally **lightweight**.

The user will perform the heavy validation, including interactive website/WordPress testing, visual checks, and other runtime verification.

Tell the agent to:

- run only relevant, inexpensive validation that is already available and useful for catching obvious mistakes;
- use existing project commands where appropriate;
- perform basic syntax/build/lint checks when they are directly relevant;
- avoid creating new test frameworks, test scripts, fixtures or elaborate validation infrastructure just for this task;
- do not spend substantial time reproducing interactive website behavior that the user can easily test themselves;
- do not start a persistent development environment such as `wp-env` merely to perform routine validation unless the task specifically requires it and doing so is clearly appropriate. Yu must ask the user for permission before you start one.;
- when additional testing would be useful, **suggest it in the completion report**.

The agent should stop testing once it has reasonable confidence that the implementation is internally consistent and ready to be tested by the user.

### Git expectations

Tell the agent:

- create a clean, reviewable commit when the implementation is complete;
- you can create multiple commits if it makes sense;
- do not push;
- do not merge anything;
- do not modify the user's main checkout.

### Completion report

Require the agent's final response to use exactly this structure:

```text
STATUS: DONE | BLOCKED

TASK
<one-sentence summary>

SUMMARY
- <important implementation result>
- <important implementation result>

VALIDATION
- <lightweight validation performed, or "None beyond implementation review">

SUGGESTED TESTS
- <tests or manual checks the user should consider>
- <or "None">

NOTES / FOLLOW-UPS
- <important assumption, limitation, investigation idea, possible improvement, technical debt, project/workflow improvement, or other useful follow-up>
- <or "None">
```

The report is a handoff for the human reviewer, not a claim that the work is perfect. Mention uncertainties, deferred improvements, worthwhile investigations, and useful workflow/project follow-ups when they exist.

## Launching the new terminal

Use the bundled launcher (relative to this skill file):

```bash
scripts/spawn-codex-worktree.sh \
  "../<slug>" \
  "<delegated-prompt>"
```

The script launch new terminal and the instance of codex inside of it.
Do not use `codex exec` for this workflow: the user explicitly wants an interactive Codex CLI instance in a separate terminal.

## Final response to the user

After launching, report:

- the task delegated;
- branch name;
- worktree path;
- that a new GNOME Terminal/Codex instance was launched;
