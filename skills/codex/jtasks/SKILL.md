---
name: jtasks
description: Carry out a jtasks run (a task list with dependencies and file ownership, held as jlock locks) with the `tasks` tool: take the next ready tasks, work each one inside its ownership, ask for more files with claim, finish with evidence, and loop until the run has nothing left. Use it when a run exists (or a plan was just handed to the tool with to-tickets) and the user asks to execute it, with or without /goal.
---

# jtasks: carry out a run

A **run** is a list of tasks in `tasks.json`, written only by the `tasks` tool. Each task has dependencies, acceptance
criteria and an **ownership**: the files and folders it may change, held as locks in jlock while it runs, so tasks run
in parallel in the same checkout without stepping on each other. The tool commits one task at a time and keeps a
ledger of everything it creates, so any task can be undone.

Run every `tasks …` command below in the shell (`tasks` is the jtasks CLI). JSON goes in a file you write first (`tasks plan --add @batch1.json`) or on standard input (`-`).

**Never edit `tasks.json`, `run.json`, the tickets or the git history by hand**, and never run git that changes the
repository (`commit`, `checkout`, `reset`, `stash`, `add`, `switch`, `merge`, `rebase`, `push`): the tool does it.

## Before the first use

- `tasks doctor` checks the machine: jlock installed and recent enough, git, the agents and skills. If something
  fails, tell the user the line it printed and the fix it suggests (`tasks doctor --fix --yes` installs what is
  missing).
- `tasks runs` lists the runs of the repository. With more than one active, pass `--run <id>` to every command (or
  `resume <id>` once to bind it to this session).

## The loop

1. `tasks next` lists the ready tasks: id, title, profile, criteria, ownership and the path of each ticket. Ready
   tasks can always run in parallel: their ownerships never overlap.
2. For each ready task, work on it yourself, one task at a time; if your setup runs several agents, give each one a task instead, with a first message that starts with `--run <run> --task <id>` and asks it to follow step 3.
3. Whoever works on a task:
   - calls `tasks start <id>` first. The answer says the ownership is locked; if it says the task was not ready
     (a file is in use), pick another task;
   - reads the ticket, then edits **only inside the ownership** (a folder covers everything in it);
   - needs one more file? `tasks claim <id> <file>`. It waits in jlock's queue up to `--timeout` (60 s by default);
   - runs the build and the tests as usual (commands the run serializes go through `tasks exec -- <command>`);
   - when every criterion holds: `tasks done <id> --evidence "<what was run and what it showed>"`. The tool commits
     the ownership's changes and gives the locks back. If the task cannot be finished:
     `tasks fail <id> --error "<why>"`. If it is not needed any more: `tasks skip <id> --reason "<why>"`.
4. When they finish, `tasks status`. It ends with the count of tasks left; when nothing is left ("0 left", or the
   same phrase in the tool's language) the run is done. If it says the run is paused, stop. Otherwise go back to 1.

## When something is in the way

- **`claim` timed out**: the answer names who holds the file and your place in the queue. Do the part that does not
  depend on it, ask again with a longer `--timeout`, or `tasks fail`.
- **Deadlock**: the claim is refused with the waiting cycle; whoever asked last yields: do another part, or
  `tasks release <id>` to give the task back to the queue.
- **Ownership lost** (`tasks status` shows it, or `done` refuses): someone broke the lock, or its time limit ran
  out. `tasks resume <run>` gives the task back to the queue; the edits stay on disk for the next attempt.
- **`done` refused for files outside the ownership**: `tasks claim` them, or undo those changes.
- **A task failed**: the tasks that depend on it stay blocked; the rest goes on. `tasks retry <id>` reopens it.

## Orchestrating

- **Without /goal**: repeat the loop yourself until `tasks status` says nothing is left. Report the final status line
  to the user as the evidence.
- **With /goal**: set the goal to "every task of run `<id>` is done or skipped", with the output of `tasks status`
  as the evidence. Each turn, run one pass of the loop.
- **Resuming** in another window or session: `tasks resume <run>`, then the loop again.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | refused or invalid (the text says why; nothing was written) |
| 2 | wrong usage (a missing argument, an unknown action) |

`tasks exec` passes the command's own code through. Add `--json` to any command for a machine-readable answer.
