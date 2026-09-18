---
name: parallel-worktree
description: Create an isolated Git worktree for an implementation task and launch a completely independent Codex CLI instance in a new GNOME Terminal. Use when the user wants to delegate a task to another Codex instance for parallel work, review, and later merge.
---

# Codex parallel worktree

Use this skill to delegate the user's task to a **separate Codex CLI process** working in its own Git worktree and terminal.

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

1. Verify this is a Git repository.
2. Inspect:

```bash
git status --short --branch
git branch --show-current
```

3. Do not destroy, stash, reset, or commit the user's existing changes.
4. If the current checkout has uncommitted changes, normally create the new worktree from the current `HEAD`, **not** by copying uncommitted changes into the new worktree. Tell the user that the delegated agent starts from `HEAD` and therefore will not see uncommitted work from the current checkout.
   If the task clearly depends on current uncommitted changes, stop and ask the user whether those changes should be committed first or otherwise made available. Do not guess.

## Worktree and branch naming

Derive a short slug from the user's task.

Use itfor the branch and the matching worktree directory.

Use a directory in the parent directory (so the current working directory and the new one will be alongside in the same parent directory).
Do not create a worktree inside another worktree.

Before creation, check whether the target branch or worktree already exists. If it does, do not overwrite it. Choose a unique suffix such as `-2`, `-3`, etc., and tell the user.

Create it with native Git:

```bash
git worktree add -b "codex/<slug>" "$WORKTREE_PATH" HEAD
```

Then verify:

```bash
git -C "$WORKTREE_PATH" status --short --branch
git worktree list
```

## Prepare the delegated prompt

The spawned agent must receive the user's original task, plus operational instructions.

Construct a prompt with these sections:

### Task

Copy the user's task faithfully. Preserve important paths, requirements, constraints, examples, and acceptance criteria.

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
- You can create multiple commits if it makes sense;
- do not commit unrelated changes;
- do not push;
- do not merge anything;
- do not modify the user's main checkout.

Use a concise commit message appropriate to the task.

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

Do **not** include a changed-files list or commit information. The user can inspect Git status/diff/history themselves.

The report is a handoff for the human reviewer, not a claim that the work is perfect. Mention uncertainties, deferred improvements, worthwhile investigations, and useful workflow/project follow-ups when they exist.

## Launching the new terminal

Use the bundled launcher (relative to this skill file):

```bash
scripts/spawn-codex-worktree.sh \
  "$WORKTREE_PATH" \
  "$DELEGATED_PROMPT"
```

The launcher opens:

```bash
gnome-terminal --working-directory="$WORKTREE_PATH" -- ...
```

and starts a fresh interactive `codex` process there.

The terminal deliberately remains open after Codex exits so the user can inspect the final output and shell state.

Do not use `codex exec` for this workflow: the user explicitly wants an interactive Codex CLI instance in a separate terminal.

## Final response to the user

After launching, report:

- the task delegated;
- branch name;
- worktree path;
- that a new GNOME Terminal/Codex instance was launched;
- that the spawned instance is independent and will report its completion there.

Do not claim that the task has been completed.
