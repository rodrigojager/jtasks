---
name: jtasks
description: Carry out a jtasks run (a task list with dependencies and file ownership, held as jlock locks) with the `jtasks` tool: take the next ready tasks, work each one inside its ownership, ask for more files with claim, finish with evidence, and loop until the run has nothing left. Use it when a run exists (or a plan was just handed to the tool with to-jtasks) and the user asks to execute it, with or without /goal.
---

# jtasks: carry out a run

A **run** is a list of tasks in `tasks.json`, written only by the `jtasks` tool. Each task has dependencies, acceptance
criteria and an **ownership**: the files and folders it may change, held as locks in jlock while it runs, so tasks run
in parallel in the same checkout without stepping on each other. The tool commits one task at a time and keeps a
ledger of everything it creates, so any task can be undone.

In OpenCode with the jtasks plugin, every `jtasks …` command below goes through the `jtasks` tool: `command` is the command line without `jtasks`, and JSON goes in `json` (`{ "command": "plan --add", "json": [ ... ] }`). Without the plugin, run the same commands in the shell, with the JSON in a file you write first (`jtasks plan --add @batch1.json`) or on standard input (`-`).

**Never edit `tasks.json`, `run.json`, the tickets or the git history by hand**, and never run git that changes the
repository (`commit`, `checkout`, `reset`, `stash`, `add`, `switch`, `merge`, `rebase`, `push`): the tool does it.

## Before the first use

- `jtasks doctor` checks the machine: jlock installed and recent enough, git, the agents and skills. If something
  fails, tell the user the line it printed and the fix it suggests (`jtasks doctor --fix --yes` installs what is
  missing).
- `jtasks runs` lists the runs of the repository. With more than one active, pass `--run <id>` to every command (or
  `resume <id>` once to bind it to this session).

## The loop

1. `jtasks next` lists the ready tasks: id, title, profile, criteria, ownership and the path of each ticket. Ready
   tasks can always run in parallel: their ownerships never overlap.
2. For each ready task, call the `subagent` tool, all of them in the same response so they run in parallel. Its prompt starts with `--run <run> --task <id>`, then the title, the criteria, the ownership and the ticket's path, and asks it to follow step 3. With the plugin, the call gets the agent of the task's profile. Without subagents, do the tasks yourself, one at a time.
3. Whoever works on a task:
   - calls `jtasks start <id>` first. The answer says the ownership is locked; if it says the task was not ready
     (a file is in use), pick another task;
   - reads the ticket, then edits **only inside the ownership** (a folder covers everything in it);
   - needs one more file? `jtasks claim <id> <file>`. It waits in jlock's queue up to `--timeout` (60 s by default);
     refused for a deadlock? `jtasks yield <id>` (below);
   - runs the build and the tests as usual (commands the run serializes go through `jtasks exec -- <command>`);
   - when every criterion holds: `jtasks done <id> --evidence "<what was run and what it showed>"`. The tool commits
     the ownership's changes and gives the locks back. If the task cannot be finished:
     `jtasks fail <id> --error "<why>"`. If it is not needed any more: `jtasks skip <id> --reason "<why>"`.
4. When they finish, `jtasks status`. It ends with the count of tasks left; when nothing is left ("0 left", or the
   same phrase in the tool's language) the run is done. If it says the run is paused, stop. Otherwise go back to 1:
   never end your turn with a task ready and nothing running.
5. If something depends on the user (an account, a credential, a decision the plan does not cover), call
   `jtasks pause`, then ask them; `jtasks unpause` when they answer. Pausing is the way to stop and ask: it also
   stops the host from reopening the loop.

## When your turn ends

With the plugin, when the session goes idle while the run is not paused, has a ready task (or one in progress that nobody works on) and no subagent is running, the plugin sends it a message that starts with `jtasks: run <id> is idle`. It is read from `tasks.json` at that moment, not from the conversation (which a compaction may have left stale): answer it with `jtasks next` and the subagents, not with text. After two such messages with no progress it stops and shows a notice in the sidebar. It never fires after an interrupted turn, until the run moves. `jtasks keepalive off` turns it off for the run (`jtasks keepalive on` turns it back on and forgets the
messages already sent); `jtasks status` says when it is off or has given up.

## When something is in the way

- **`claim` timed out**: the answer names who holds the file and your place in the queue. Do the part that does not
  depend on it, ask again with a longer `--timeout`, or `jtasks fail`.
- **Deadlock**: the claim is refused with the waiting cycle, and whoever asked last yields. Run `jtasks yield <id>`:
  it gives back only the contested files (your edits of them are kept as a patch, the files go back to HEAD), the
  task stays in progress with the rest of its ownership, and you go on with the parts that do not need them. They
  come back by themselves once free, or with `jtasks claim <id>` (no files: it waits for what was yielded). When
  they come back, read the answer: the patches reapplied, and any file left with conflict markers to resolve before
  `done`. Only if nothing else can move, `jtasks release <id>`.
- **Ownership lost** (`jtasks status` shows it, or `done` refuses): someone broke the lock, or its time limit ran
  out. A long task is not a reason by itself: the mod and the plugin renew the locks of tasks in progress, and
  `done` takes back its own expired keys when nobody took them. If `done` still refuses, someone else holds them
  now: `jtasks resume <run>` gives the task back to the queue; its edits are kept as patches (a file someone else
  holds now is left alone), and the next `jtasks start <id>` reapplies them (`--fresh` starts without them).
- **A task you start again** (after a release, a failure or a lost lock) gets its earlier edits back: the answer of
  `start` lists the patches reapplied and any file left with conflict markers; resolve those before `done`.
- **`done` refused for files outside the ownership**: `jtasks claim` them, or undo those changes.
- **`start` refused for a shared file** (`🔗` in `next` and `status`): the plan's `sharedPolicy` is `serialize` and
  another task in progress touches the same shared file; take another ready task. After the run,
  `jtasks status --claims` lists the most contested files, for the next plan's `shared`.
- **A task failed**: the tasks that depend on it stay blocked; the rest goes on. `jtasks retry <id>` reopens it.

## Orchestrating

- **Without /goal**: repeat the loop yourself until `jtasks status` says nothing is left. Report the final status line
  to the user as the evidence.
- **With /goal**: set the goal to "every task of run `<id>` is done or skipped", with the output of `jtasks status`
  as the evidence. Each turn, run one pass of the loop. The goal does not notice a turn that ends with a task ready
  and nothing running; the section above says who reopens the loop then.
- **Resuming** in another window or session: `jtasks resume <run>`, then the loop again.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | refused or invalid (the text says why; nothing was written) |
| 2 | wrong usage (a missing argument, an unknown action) |

`jtasks exec` passes the command's own code through. Add `--json` to any command for a machine-readable answer.
