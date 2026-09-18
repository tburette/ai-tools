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

Run a single read-only preflight command to collect all state needed for the decision. Do not make separate calls for each check. assume `scripts/spawn-codex-worktree.sh` exists (at the skill path).

Substitute the chosen short slug (see below for slug explanation) for `<slug>` in this example:

```bash
SLUG="<slug>"
PARENT_DIR="$(dirname "$PWD")"
WORKTREE_PATH="$PARENT_DIR/$SLUG"
BRANCH="codex/$SLUG"

printf 'repository: '; git rev-parse --show-toplevel
git status --short --branch
git worktree list --porcelain
printf 'parent entries:\n'
find "$PARENT_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort
printf 'candidate branch: %s\n' "$BRANCH"
printf 'candidate worktree: %s\n' "$WORKTREE_PATH"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo 'candidate branch already exists'
fi
if [[ -e "$WORKTREE_PATH" || -L "$WORKTREE_PATH" ]]; then
    echo 'candidate worktree path already exists'
fi
```

Do not destroy, stash, reset, or commit the user's existing changes.

## Worktree and branch naming

Derive a short slug from the user's task.

Use it for the branch and the matching worktree directory.

Use a directory in the parent directory (so the current working directory and the new one will be alongside in the same parent directory).
Do not create a worktree inside another worktree.

Use the preflight output to check whether the target branch or worktree already exists. If either does, do not overwrite it. Choose a unique suffix such as `-2`, `-3`, etc., and tell the user.

Create it with native Git:

```bash
git worktree add -b "codex/<slug>" "$WORKTREE_PATH" HEAD
```

Create and launch in one command. Because the launcher opens GNOME Terminal, run this entire command with the tool's `sandbox_permissions: require_escalated` GUI permission; do not first attempt the launcher in the sandbox, since that only creates an avoidable display-access failure:

```bash
git worktree add -b "codex/<slug>" "$WORKTREE_PATH" HEAD && \
git -C "$WORKTREE_PATH" status --short --branch && \
/home/tburette/.codex/skills/parallel-worktree/scripts/spawn-codex-worktree.sh \
  "$WORKTREE_PATH" \
  "$DELEGATED_PROMPT"
```

The post-create status check is sufficient verification; do not run a second `git worktree list` unless the command fails or the user asks for it.

## Prepare the delegated prompt

The spawned agent must receive the user's original task verbatim, plus operational instructions.

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
