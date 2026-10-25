---
name: to-jtasks
description: Break a plan, spec, issue or the current conversation into jtasks tasks (tracer-bullet vertical slices, each with what it delivers, acceptance criteria that fail today, the tasks that block it and the files it owns) and hand them to the `jtasks` tool in batches; the tool validates them, writes tasks.json and generates the tickets.
disable-model-invocation: true
---

# To jtasks

Break a plan, spec, issue or conversation into **tasks**: tracer-bullet vertical slices, each declaring what it
delivers, how to tell it works, the tasks that **block** it and the **files it owns**. The plan is delivered through
the `jtasks` tool, never written by hand: the tool validates it, writes `tasks.json` and generates one ticket per
task. Every task is picked up by a subagent that has never seen this conversation, so the task must carry
everything it needs.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue
number or URL) as an argument, fetch it and read its full body and comments. That reference is the plan's
**source**: it goes in the plan (`source`) and every ticket points back to it.

Do NOT close, edit or comment on the source issue or spec. The plan lives in the tool; the source stays as it was.

### 2. Explore the codebase

If you have not already explored the codebase, do so to understand the current state of the code. Before
exploring, read the project's domain docs when they exist, and proceed silently when they do not:

- `GLOSSARY.md` at the repository root, or `GLOSSARY-MAP.md`, which points at one `GLOSSARY.md` per context: task
  titles and descriptions use its terms, not synonyms it avoids;
- `docs/adr/` (and `src/<context>/docs/adr/` in a repository with several contexts): read the decisions that touch
  the area you are changing. A task that contradicts one is flagged to the user in step 5, never planned silently.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the
easy change."

There is a lower limit: if the whole change fits in one context window and a handful of files, it does not need a
plan. Tell the user, and do it directly.

### 3. Draft vertical slices

Break the work into **tracer bullet** tasks.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own: "what can I demo when this is done?" has an answer, and the answer is behaviour, not a layer
- Each slice is sized to fit in a single fresh context window
- Each slice can be finished by an agent alone, with no person in the loop
- Any prefactoring should be done first

</vertical-slice-rules>

Give each task its **blocking edges**: the other tasks that must complete before it can start. A task with no
blockers can start immediately.

**A task never waits for a person.** A subagent cannot ask for a credential, a product decision, a purchase or a check
on a real device; it would fail the task after spending an attempt. Settle those questions with the user in step 5,
before the plan exists. What is still left for a person goes to the user as a note beside the plan, not into it.

**Wide refactors are the exception to vertical slicing.** A wide refactor is one mechanical change (rename a column,
retype a shared symbol) whose blast radius fans across the whole codebase, so a single edit breaks thousands of call
sites at once and no vertical slice can land green. Sequence it as expand–contract: expand (add the new form beside
the old, so nothing breaks), migrate the call sites in batches sized by blast radius (per package, per folder), each
its own task blocked by the expand, then contract (delete the old form, blocked by every migrate batch). When even the
batches cannot stay green alone, keep the sequence and end it with an integrate-and-verify task on the `review`
profile, blocked by every batch: green is promised only there. The run already works on its own branch (`gt/<run>`),
so nothing reaches the base branch until the user merges it; that branch is the integration branch.

Pick each task's **profile**, the kind of agent that will run it:

- `execute` (the default): a clear task;
- `execute-deep`: the design is not settled, several parts must change together, or it is a bug that resisted a
  first attempt;
- `review`: checks the work of other tasks against their criteria, such as the final integrate-and-verify task.

### 4. Write each task

Each task becomes one ticket, the only thing its subagent reads before starting. Write it for that reader:

- **`id`**: `T01`, `T02`… numbered in dependency order (blockers first). The ticket files are numbered from the ids,
  so the folder reads top to bottom.
- **`title`**: short and descriptive, in the glossary's words.
- **`what`**: the end-to-end behaviour this task makes work, from the user's side, not a layer-by-layer list of
  steps. No file paths (they go in `files`) and no code: both go stale fast. Exception: when a prototype produced a
  snippet that encodes a decision more precisely than prose (a state machine, a reducer, a schema, a type shape),
  keep only its decision-rich part and say it came from a prototype.
- **`acceptance`**: at least one criterion, each an observation someone can check. For each one, name the observation
  that would show it false and confirm it is false at the commit the task starts from. Three shapes are wrong: a
  criterion already true today, one that only another task can make true, and one that restates the request instead
  of deriving from the result. The subagent finishes the task with evidence for these criteria.
- **`files`**: the files and folders the task touches (its ownership; step 5 says how).
- **`touchesShared`**, when the task will touch a file of the plan's `shared` it does not own (step 5).
- **`boundary`**, when it helps: what this task does not do, so the subagent does not drift into the next one.
- **`source`**, only when this task came from somewhere other than the plan's source.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each task, show:

- **Title**: short descriptive name
- **Blocked by**: which other tasks (if any) must complete first
- **What it delivers**: the end-to-end behaviour this task makes work
- **Demo**: what can be shown when it is done
- **Criteria**: its acceptance criteria
- **Files**: which files and folders this task touches (its ownership)
- **Profile**: `execute`, `execute-deep` or `review`

The ownership is what lets tasks run in parallel in the same checkout, so get it right now:

- List **files and folders**, relative to the repository. A folder owns everything inside it. `dir/**` is accepted
  and becomes `dir`. **No other patterns**: `src/*.ts` is refused (jlock locks files and folders, not patterns).
- Two tasks with **no dependency between them must not share** a file or folder (the tool refuses the plan). Decide
  the order now (add a dependency) or split the file.
- A **hub** file many slices touch (a central `types.ts`, a giant `routes.ts`) serializes everything: prefactor it
  into modules in an early task, so the ownership of the rest is fine-grained again.
- **Registry files** are the hubs that are hard to see: the manifest of adapters, the index that registers each
  module, the schema of the result, the central run types. Each parallel slice adds one line to them, so each slice
  will claim them mid-run, and two slices waiting for each other's registry file is a deadlock. Ask now which
  registries, indexes, schemas and central types several tasks will touch, and list them in the plan's **`shared`**.
  Then, for each one, either give it to a single task (`files`, and the others depend on it), chain the tasks that
  touch it (`dependsOn`), or keep them parallel and declare the touch: the task lists it in **`touchesShared`** (it
  will claim it when it needs it) and the plan sets **`"sharedPolicy": "serialize"`**, so two tasks touching the same
  shared file never run at the same time. `jtasks validate` (and `plan`) warns about two parallel tasks touching one
  shared file without any of this. After a run, `jtasks status --claims` lists the files that were most contested:
  they are the next plan's `shared`.
- A task that touches too much or unknown files is `"exclusive": true`: it runs alone.

Ask the user:

- Does the granularity feel right? (too coarse / too fine) Over-decomposition is the usual mistake: tasks too small
  to demo anything on their own should be merged.
- Are the blocking edges correct: does each task only depend on tasks that genuinely gate it?
- Is each task's ownership right (files and folders it will touch)? Which registry files, indexes, schemas and
  central types will several of them touch, and how is each one ordered (`shared`, step 5)?
- Does any task contradict an ADR, or need a person (a decision, a credential, a manual check)? Settle it now.
- Should any tasks be merged or split further?

Iterate until the user approves the breakdown.

### 6. Hand the plan to the `jtasks` tool, in batches

In Claude Code with the jtasks mod, every `jtasks …` command below goes through the `mcp__jtasks__jtasks` tool: `command` is the command line without `jtasks`, and JSON goes in `json` (`{ "command": "plan --add", "json": [ ... ] }`). Without the mod, run the same commands in the shell, with the JSON in a file you write first (`jtasks plan --add @batch1.json`) or on standard input (`-`).

Turn the approved breakdown into JSON (schema in `schema.json` beside this file; a small example in
`example-plan.json`) and deliver it through the tool, in batches of up to ~20 tasks, so no single answer has to hold
the whole plan:

1. `jtasks plan --draft --name <feature-slug> --objective "<one line>" --source "<spec path or issue URL>"` opens a
   draft (not a run yet).
2. `jtasks plan --add` with the first batch as `json` (a list of tasks, or `{ "tasks": [...], "profiles": ...,
   "serialize": [...] }`). The tool validates what it can inside the batch (schema, repeated ids, profiles, patterns
   in `files`) and refuses the whole batch on any error, listing every error.
3. Repeat `jtasks plan --add` for the next batches. A task may depend on a task of a later batch.
4. `jtasks plan --show` prints ids, titles, dependencies and ownership: check it against the approved breakdown.
5. `jtasks plan --commit` runs the complete validation (dependencies across batches, cycles, ownership shared by
   independent tasks). On success it writes `tasks.json`, generates the tickets, creates the run's branch and binds
   the run to this session.

When the tool returns errors, fix **only the task named**: `jtasks plan --fix <id>` with that task's corrected JSON.
Never resend the other tasks, and never work around a refusal by removing ownership: add the dependency or split the
file, as the message says. Then `--commit` again.

A small plan can also go in one call: `jtasks plan` with the whole plan as `json`.

The plan may also say `"keepalive": false` (optional; the default is `true`): the run is created with the host's
keepalive off, so nothing reopens the loop when the orchestrator stops with tasks ready. Leave it out unless the user
wants to drive every turn by hand; `jtasks keepalive on|off` changes it later.

**Never edit `tasks.json`, the tickets, `run.json` or the git history by hand**: every change goes through the tool.
After the plan, tell the user what was left out for a person, if anything. The execution follows the protocol the mod injects into the prompt (`jtasks next`, one subagent per ready task, `jtasks status` until nothing is left); without the mod, the `jtasks` skill.
