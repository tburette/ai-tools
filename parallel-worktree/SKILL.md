---
name: parallel-worktree
description: Create a Git worktree and launch an independent Codex CLI session in a new GNOME Terminal when the user explicitly wants a separate interactive agent. Use an in-session subagent for ordinary delegation.
---

# Codex parallel worktree

Use this skill to delegate the user's task to a **separate Codex CLI process** working in its own Git worktree and terminal.

## When this skill is needed

Use this workflow when the user specifically wants an independent Codex CLI process and isolated worktree/terminal. Use a direct subagent when it can handle the task and do not launch a separate terminal just to delegate.

## Expedited workflow

Use this workflow when the user requests expedite (for example, `expedite parallel-worktree` or `$parallel-worktree expedite`). It skips repository discovery and generates a worktree name automatically. If the user also requires a specific branch or worktree name, or requires preflight checks, use the standard workflow because expedited mode cannot honor those constraints.

In expedited mode, the only judgment required before launch is constructing the delegated prompt described in **Prepare the delegated prompt**. Do not inspect repository status, branches, worktrees, or sibling directories. Do not choose a slug. Do not run `preflight-worktree.sh`, `git status`, `git worktree list`, or other preliminary commands.

Invoke `scripts/expedite-codex-worktree.sh` with the complete delegated prompt as its sole argument. Use the script's absolute path.

```bash
scripts/expedite-codex-worktree.sh \
  "<delegated-prompt>"
```

Because the script launches GNOME Terminal, run it with the tool's `sandbox_permissions: require_escalated` GUI permission; do not first attempt it in the sandbox.

The script prints the generated branch name and worktree path as its response. Do not perform separate verification unless the script fails.

The standard workflow below does not apply in expedited mode except for **Launching multiple tasks**, **Prepare the delegated prompt**, the independence rules after launch, and **Final response to the user**.

## Core rule

The spawned Codex instance is completely independent.

After launching it:

- Do **not** interact with, monitor, steer, or resume the spawned Codex process.
- Do **not** use its terminal.
- Do **not** inspect its working tree while it is working.
- Do **not** wait for its completion.
- Your only responsibilities are:
  1. follow either the expedited or standard creation workflow;
  2. construct a high-quality handoff prompt;
  3. launch a new GNOME Terminal containing the new Codex instance;
  4. report to the user where the worktree is and what branch was created.

The user will manage the other Codex instance directly.

## Intended workflow

The user gives a task such as:

> Implement the new responsive navigation behavior described in ...

You will then:

- create a dedicated Git worktree at `../<slug>` relative to the current working directory, with a new branch;
- launch an independent Codex CLI session in a new GNOME Terminal opened at that worktree.

The user's current Codex session remains in its original state.

## Before creating anything

This section applies only to the standard workflow. Skip it entirely in expedited mode.

Run the bundled read-only preflight script before choosing a slug. It reports the repository root, current worktree status, local branches, existing worktrees, entries in the current working directory’s parent (`..`), and naming rules. The repository root is informational for Git checks; it does not determine the new worktree path. Use the output for repository and collision checks instead of repeating those inventories. Task-specific read-only checks, such as checking a requested service port, are still allowed.

Invoke the bundled script by its absolute path under the skill directory, keeping the current project directory as the command working directory. Do not change to the Git root:

```bash
"<absolute-skill-path>/scripts/preflight-worktree.sh"
```

Read the output. Honor an exact name supplied by the user; otherwise choose a short slug. Use it exactly as the local branch name and sibling worktree directory name; never prepend `codex/`.

Do not destroy, stash, reset, or commit the user's existing changes.

## Worktree and branch naming

This section applies only to the standard workflow. In expedited mode, the bundled script generates both names automatically.

Use the exact branch/worktree name if the user supplied one. Otherwise derive a short slug from the task.

Use the same slug for the branch and matching worktree directory.

Use `../<slug>` relative to the current working directory. Do not derive the target path from the Git root or change directories before creating it. Do not create a worktree inside another worktree.

Use the preflight output to check whether the target branch or path already exists. Never overwrite either. If a user-specified exact name collides, pause and ask which alternate name to use. For a derived name, choose a unique suffix such as `-2` or `-3` and tell the user.

A new worktree contains the committed state at its starting ref. It does not inherit staged, unstaged, or untracked files from the current checkout. If needed context is in a dirty file accessible at a shared absolute path, include that path and tell the spawned agent whether it may read or edit it. If the task requires uncommitted code itself to exist in the new worktree, explain that it will not transfer and ask how the user wants to provide it. Do not copy, stash, stage, or commit existing changes without explicit authorization. Leave unrelated dirty changes untouched and tell the spawned agent they are absent.

Create it with native Git:

```bash
git worktree add "../<slug>"
```

Create and launch in one command. Use the absolute bundled-launcher path shown below. Because the launcher opens GNOME Terminal, run this command with `sandbox_permissions: require_escalated`; do not first attempt it in the sandbox:

```bash
git worktree add "../<slug>" && \
git -C "../<slug>" status --short --branch && \
"<absolute-skill-path>/scripts/spawn-codex-worktree.sh" \
  "../<slug>" \
  "<delegated-prompt>"
```

The post-create status check is sufficient verification. If a step fails, determine whether worktree creation succeeded before retrying; do not remove or recreate it automatically. If the launcher alone failed, report the existing worktree and provide the command to retry the launch.

## Launching multiple tasks

When the user requests several worktrees in one turn, prepare a separate task prompt and collision-free name for each. Create and launch each task independently so a failure in one does not prevent the remaining tasks from starting. Include user-specified per-task settings, such as distinct test ports, in the matching prompt. Report the result for every requested task, including any launch that failed.

## Prepare the delegated prompt

The launcher takes the worktree path first and the delegated prompt second. Pass the complete prompt as one shell-safe argument. `<delegated-prompt>` in the command example is only a placeholder.

Construct a prompt with these sections:

### Task

Preserve the user’s requested task, acceptance criteria, paths, visual references, and constraints. The new Codex session does not inherit this conversation or its attachments: include necessary context in the prompt and provide accessible file paths for images and documents. Omit only orchestration directions meant for the launching session (for example, “use this skill” or “create a worktree”). Keep instructions intended for the spawned agent, including user-provided authorization and environment constraints. If the user asks to combine tasks, preserve every acceptance criterion. Do not paraphrase details where wording or exact values matter.

### Working context

Tell the agent:

- it is working in a dedicated Git worktree;
- it must not touch other worktrees;
- it must work only on the task;
- it should follow existing project conventions;

### Implementation focus

The primary objective is to **implement the user's requested changes**.

Tell the agent to understand the relevant architecture, implement the requested change completely, and prefer a simple focused solution. Ask the user only when missing information or a consequential choice materially affects the result and cannot reasonably be inferred; otherwise state material assumptions and proceed. Avoid broad refactoring and speculative cleanup. Note limitations and useful follow-ups in the completion report.

### Testing and validation

Testing defaults to **lightweight** when the user has not specified otherwise. Follow any explicit testing scope and environment authorization included in the delegated prompt; those instructions override these defaults, and the spawned agent should not ask again for already-granted authorization.

Tell the agent to:

- run only relevant, inexpensive validation that is already available and useful for catching obvious mistakes;
- use existing project commands where appropriate;
- perform basic syntax/build/lint checks when they are directly relevant;
- avoid creating new test frameworks, test scripts, fixtures or elaborate validation infrastructure just for this task;
- do not spend substantial time reproducing interactive website behavior that the user can easily test themselves;
- when additional testing would be useful, **suggest it in the completion report**.

The agent should stop testing once it has reasonable confidence that the implementation is internally consistent and ready to be tested by the user.

### Git expectations

Tell the agent:

- follow the user’s explicit commit instructions; otherwise, create clean, reviewable commits when the implementation is complete. Multiple commits are fine if they make the changes clearer;
- do not include pre-existing or unrelated changes in the commit;
- do not push or merge;
- do not modify the user’s main checkout.

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

POSSIBLE IMPROVEMENTS, NEXT TASKS AND OTHER FOLLOW-UPS
- list of items
```

The report is a handoff for the human reviewer, not a claim that the work is perfect. Mention uncertainties, deferred improvements, worthwhile investigations, and useful workflow/project follow-ups when they exist.

## Launching the new terminal

After creating the worktree, launch the new terminal from the same current working directory. Use the absolute path to the bundled launcher and pass the worktree path and delegated prompt as its two arguments:

```bash
"<absolute-skill-path>/scripts/spawn-codex-worktree.sh" \
  "../<slug>" \
  "<delegated-prompt>"
```

The standard workflow above combines creation and launch in one command; this is the launch portion shown separately. The expedited helper invokes the launcher itself. Do not use `codex exec`: this workflow is for an interactive Codex CLI session in a separate terminal.

## Final response to the user

After launching, report:

- the task delegated;
- branch name;
- worktree path;
- that a new GNOME Terminal/Codex instance was launched;
