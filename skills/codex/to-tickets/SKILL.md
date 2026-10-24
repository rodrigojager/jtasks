---
name: to-tickets
description: Break a plan, spec, or the current conversation into tracer-bullet tasks, each with its blocking edges and the files it owns, and hand them to the jtasks `tasks` tool in batches (it validates, writes tasks.json and generates the tickets).
---

# To Tickets

Break a plan, spec, or conversation into **tasks**: tracer-bullet vertical slices, each declaring the tasks that
**block** it and the **files it owns**. The plan is delivered through the `tasks` tool (jtasks), never written
by hand: the tool validates it, writes `tasks.json` and generates the tickets from it.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue
number or URL) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Task titles and
descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the
easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tasks.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each task its **blocking edges**: the other tasks that must complete before it can start. A task with no
blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A wide refactor is one mechanical change whose blast radius
fans across the whole codebase. Sequence it as expand–contract: expand (add the new form beside the old), migrate the
call sites in batches (each its own task, blocked by the expand), then contract (delete the old form, blocked by every
migrate batch).

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each task, show:

- **Title**: short descriptive name
- **Blocked by**: which other tasks (if any) must complete first
- **What it delivers**: the end-to-end behaviour this task makes work
- **Files**: which files and folders this task touches (its ownership)

The ownership is what lets tasks run in parallel in the same checkout, so get it right now:

- List **files and folders**, relative to the repository. A folder owns everything inside it. `dir/**` is accepted
  and becomes `dir`. **No other patterns**: `src/*.ts` is refused (jlock locks files and folders, not patterns).
- Two tasks with **no dependency between them must not share** a file or folder (the tool refuses the plan). Decide
  the order now (add a dependency) or split the file.
- A **hub** file many slices touch (a central `types.ts`, a giant `routes.ts`) serializes everything: prefactor it
  into modules in an early task, so the ownership of the rest is fine-grained again.
- A task that touches too much or unknown files is `"exclusive": true`: it runs alone.

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each task only depend on tasks that genuinely gate it?
- Is each task's ownership right (files and folders it will touch)?
- Should any tasks be merged or split further?

Iterate until the user approves the breakdown.

### 5. Hand the plan to the `tasks` tool, in batches

Run every `tasks …` command below in the shell (`tasks` is the jtasks CLI). JSON goes in a file you write first (`tasks plan --add @batch1.json`) or on standard input (`-`).

Turn the approved breakdown into JSON (schema in `schema.json` beside this file; a small example in
`example-plan.json`) and deliver it through the tool, in batches of up to ~20 tasks, so no single answer has to hold
the whole plan:

1. `tasks plan --draft --name <feature-slug> --objective "<one line>"` opens a draft (not a run yet).
2. `tasks plan --add` with the first batch as `json` (a list of tasks, or `{ "tasks": [...], "profiles": ...,
   "serialize": [...] }`). The tool validates what it can inside the batch (schema, repeated ids, profiles, patterns
   in `files`) and refuses the whole batch on any error, listing every error.
3. Repeat `tasks plan --add` for the next batches. A task may depend on a task of a later batch.
4. `tasks plan --show` prints ids, titles, dependencies and ownership: check it against the approved breakdown.
5. `tasks plan --commit` runs the complete validation (dependencies across batches, cycles, ownership shared by
   independent tasks). On success it writes `tasks.json`, generates the tickets, creates the run's branch and binds
   the run to this session.

When the tool returns errors, fix **only the task named**: `tasks plan --fix <id>` with that task's corrected JSON.
Never resend the other tasks, and never work around a refusal by removing ownership: add the dependency or split the
file, as the message says. Then `--commit` again.

A small plan can also go in one call: `tasks plan` with the whole plan as `json`.

**Never edit `tasks.json`, the tickets, `run.json` or the git history by hand**: every change goes through the tool.
After the plan, the execution follows the `jtasks` skill (`tasks next`, the tasks, `tasks status` until nothing is left).
