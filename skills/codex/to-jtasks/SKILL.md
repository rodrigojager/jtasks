---
name: to-jtasks
description: Break a plan, spec, issue or the current conversation into jtasks tasks (tracer-bullet vertical slices, each with what it delivers, acceptance criteria that fail today, the tasks that block it and the files it owns) and hand them to the `jtasks` tool in batches; the tool validates them, writes tasks.json and generates the tickets.
---

# To jtasks

Break a plan, spec, issue or conversation into **tasks**: tracer-bullet vertical slices, each declaring what it
delivers, how to tell it works, the tasks that **block** it and the **files it owns**. The plan is delivered through
the `jtasks` tool, never written by hand: the tool validates it, writes `tasks.json` and generates one ticket per
task. Every task is picked up by a subagent that starts with a fresh context and has never seen this conversation,
so its ticket must carry everything it needs. What all tasks share (the problem, the decisions, the shared
interfaces and conventions, the standing rules) goes **once** in the run's **common brief**, a Markdown file you write
(step 6); the tool copies its text, verbatim, to the top of every ticket's `## Context`. Each task then carries only
what is its own, and every piece of information appears in a ticket exactly once.

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
- **`context`**, the task's **exclusive** context: only the HOW-relevant knowledge this task needs and the brief does
  not give. Decide per task what goes where:
  - **inline it** in `summary` (the default): the decisions, interfaces, signatures, pitfalls and the existing code
    to start from (`src/x.ts:fnName`), short and precise. The executor should be able to act without researching
    and, ideally, without opening anything else;
  - **`read`** (required reading) only when the material cannot reasonably be inlined, such as source code to port
    or a long fixture; point to a section (`PLAN.md#tokens`, `src/x.ts:120-180`) rather than a whole document;
  - **`consult`** for documents to open only in case of doubt, each with the doubt it settles:
    `{ "path": "<abs>/_work/30-plan/PLAN-email.md#template", "why": "if the email's layout seems ambiguous" }`;
  - **`constraints`** for a rule only this task follows.

**Each piece of information appears once in a ticket.** The ticket already shows `what`, the criteria, `files`,
`boundary` and the common brief, so the task's `context` never restates them: `what` says WHAT the task delivers;
`context` says only how-relevant facts. Never copy text of the brief, a path or rule the run already gives every
ticket, or the task's own `what` into its `context` (`jtasks plan`, `--commit` and `validate` warn when they see it).
A task with nothing of its own leaves `context` out.

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

- List **files and folders**, relative to the repository (in a jproject container, the repository is `product/`:
  relative to it, not to the container). A folder owns everything inside it. `dir/**` is accepted and becomes `dir`.
  **No other patterns**: `src/*.ts` is refused (jlock locks files and folders, not patterns).
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
- A task that touches too much or unknown files is exclusive. `"exclusive": "project"` (or `true`) holds the whole
  repository: it runs alone in this repository and never touches another project's locks. `"exclusive": "machine"`
  also takes the whole machine: it waits until every jtasks task running on this machine (any run, any project) has
  finished, and no new one starts while it runs. Use `"machine"` only when the numbers depend on a quiet machine
  (benchmarks, timing or load tests); everything else that must run alone is `"project"`.
- **What a task uses besides files** goes in **`uses`**, so tasks of every run that need the same thing wait for
  each other instead of colliding: `"uses": ["desktop"]` (the real mouse, keyboard and windows: UI automation,
  computer use, screenshots of the real screen), `"clipboard"`, `"browser"` (the user's own logged-in browser
  profile), `"audio"`, `"gpu"`, `"network"` (big transfers, network-sensitive tests), `"port:8080"` (a fixed port a
  server listens on), `"machine"`. Each is exclusive by default; `{ "resource": "gpu", "mode": "shared" }` lets tasks
  that can share it run together. `jlock resources` lists the names (the user's own ones too); an unknown name is
  refused with the closest one. Every task already holds `machine` shared: declare `machine` only through
  `"exclusive": "machine"`. `validate` warns when a task's text talks about the mouse or keyboard, the clipboard, a
  fixed port or measurements and `uses` does not say so; and when two independent tasks use one resource
  exclusively (they will run one at a time).

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

Run every `jtasks …` command below in the shell (`jtasks` is the jtasks CLI). JSON goes in a file you write first (`jtasks plan --add @batch1.json`) or on standard input (`-`).

Turn the approved breakdown into JSON (schema in `schema.json` beside this file; a small example in
`example-plan.json`) and deliver it through the tool, in batches of up to ~20 tasks, so no single answer has to hold
the whole plan.

First write the **common brief**, once: a Markdown file with only the text every task needs (an example in
`example-brief.md` beside this file). Distill it from the plan; never point the executors at the whole plan:

- the problem and the goal, in a few sentences;
- the decisions every task must respect (and that are not to be reopened);
- the shared interfaces, types, names and paths several tasks build on or against;
- the conventions and standing rules: the user's rules for the project (language, how to test, what never to
  touch) and the plan's out-of-scope lines a task could drift into.

Inline the facts, short and precise, rather than sending executors to read documents: every executor reads the
brief, so every line in it must matter to most tasks. What only some tasks need goes in those tasks' `context`. No
research history, alternatives considered or per-task detail.

Write it to the scratch path `jtasks plan --draft` prints (`jtasks-brief-<run>.md`, in a jproject container under
`<work_dir>/00-tmp/`, elsewhere in the system's temporary folder). Never write it inside the run's data folder: only
the tool writes there, and the guard refuses your edit. The plan's `context` then names it; `read`, `consult` and
`constraints` there are only for what truly applies to every task, usually nothing:

```json
"context": { "brief": "<the scratch path plan --draft printed>" }
```

The tool reads the file (a missing or empty one refuses the batch), keeps its text as `brief.md` in the run's folder
(its one copy) and removes the scratch file once the batch is accepted. It renders, deterministically, the brief at the top of the `## Context` section of every ticket, then each task's
exclusive context (its `summary`, **Read first**, **If in doubt, consult**, **Constraints**). `jtasks context --set`
with `{ "brief": "<file>" }` replaces it later and rewrites the tickets not finished yet.

1. `jtasks plan --draft --name <feature-slug> --objective "<one line>" --source "<spec path or issue URL>"` opens a
   draft (not a run yet) and prints the scratch path for the brief. Write it there now.
2. `jtasks plan --add` with the first batch as `json`: `{ "context": { "brief": "<path>" }, "tasks": [...] }` (it
   may also carry `"profiles"`, `"serialize"`…; later batches can be a plain list of tasks). The tool validates what
   it can inside the batch (schema, repeated ids, profiles, patterns in `files`, the context block and the brief file)
   and refuses the whole batch on any error, listing every error.
3. Repeat `jtasks plan --add` for the next batches. A task may depend on a task of a later batch.
4. `jtasks plan --show` prints ids, titles, dependencies and ownership: check it against the approved breakdown.
5. `jtasks plan --commit` runs the complete validation (dependencies across batches, cycles, ownership shared by
   independent tasks). On success it writes `tasks.json`, generates the tickets, creates the run's branch and binds
   the run to this session.

When the tool returns errors, fix **only the task named**: `jtasks plan --fix <id>` with that task's corrected JSON.
Never resend the other tasks, and never work around a refusal by removing ownership: add the dependency or split the
file, as the message says. Then `--commit` again.

A small plan can also go in one call: `jtasks plan` with the whole plan as `json`. With no draft there is no
printed path: write the brief to a scratch file (in a jproject container, `<work_dir>/00-tmp/`), and delete that file
once the plan is accepted (the run keeps the copy).

The plan may also say `"keepalive": false` (optional; the default is `true`): the run is created with the host's
keepalive off, so nothing reopens the loop when the orchestrator stops with tasks ready. Leave it out unless the user
wants to drive every turn by hand; `jtasks keepalive on|off` changes it later.

**Never edit `tasks.json`, the tickets, `run.json` or the git history by hand**: every change goes through the tool.
After the plan, tell the user what was left out for a person, if anything. The execution follows the `jtasks` skill (`jtasks next`, the tasks, `jtasks status` until nothing is left).
