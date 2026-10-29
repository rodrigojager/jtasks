---
name: jtasks
description: Carry out a jtasks run (a task list with dependencies and file ownership, held as jlock locks) with the `jtasks` tool: take the next ready tasks, work each one inside its ownership, ask for more files with claim, finish with evidence, and loop until the run has nothing left. Use it when a run exists (or a plan was just handed to the tool with to-jtasks) and the user asks to execute it, with or without /goal.
---

# jtasks: carry out a run

A **run** is a list of tasks in `tasks.json`, written only by the `jtasks` tool. Each task has dependencies, acceptance
criteria and an **ownership**: the files and folders it may change, held as locks in jlock while it runs, so tasks run
in parallel in the same checkout without stepping on each other. The tool commits one task at a time and keeps a
ledger of everything it creates, so any task can be undone.

In Claude Code with the jtasks mod, every `jtasks …` command below goes through the `mcp__jtasks__jtasks` tool: `command` is the command line without `jtasks`, and JSON goes in `json` (`{ "command": "plan --add", "json": [ ... ] }`). Without the mod, run the same commands in the shell, with the JSON in a file you write first (`jtasks plan --add @batch1.json`) or on standard input (`-`).

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
2. For each ready task, open a subagent with the Agent tool, all of them in the same response so they run in parallel. Its prompt starts with `--run <run> --task <id>`, then the title, the criteria, the ownership and the ticket's path, and asks it to follow step 3. With the mod, the task's profile sets the subagent's model. Without subagents, do the tasks yourself, one at a time.
3. Whoever works on a task:
   - calls `jtasks start <id>` first. The answer says the ownership is locked; if it says the task was not ready
     (a file is in use), pick another task;
   - reads the ticket, then edits **only inside the ownership** (a folder covers everything in it);
   - needs one more file? `jtasks claim <id> <file>`. It waits in jlock's queue up to `--timeout` (60 s by default);
     refused for a deadlock? `jtasks yield <id>` (below);
   - runs the build and the tests as usual (commands the run serializes go through `jtasks exec -- <command>`); a
     long one (a whole test suite, an end-to-end run) goes through `jtasks exec --task <id> -- <command>`, which
     registers its process in the task; to end the turn and wait for a process left running in the background,
     declare it first with `jtasks wait <id> --pid <pid>` (below, "Waiting for a process");
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

With the mod, when your turn ends while the run is not paused, has a ready task (or one in progress that nobody works on) and no subagent is running, the mod sends you a message that starts with `jtasks: run <id> is idle`. It is read from `tasks.json` at that moment, not from the conversation (which a compaction may have left stale): answer it with `jtasks next` and the subagents, not with text. After two such messages with no progress it stops and tells the user. It never fires after the user interrupts a turn, until the run moves. `jtasks keepalive off` turns it off for the run (`jtasks keepalive on` turns it back on and forgets the
messages already sent); `jtasks status` says when it is off or has given up.

## Waiting for a process

The end of a subagent's loop with its task in progress is not always a death: it may have left a long command
running and ended its turn to wait for it. So the host's end of a subagent looks first at the processes the task
registered (`jtasks exec --task <id>` registers the one it starts, `jtasks wait <id> --pid <pid>` declares one started
otherwise; `jtasks wait <id>` lists them): while one lives, the task stays **in progress, waiting for a process**,
with its locks and without spending anything, and `jtasks status` says so. With the mod, a command a subagent runs with the Bash tool in the background is seen by the mod too, and so is Claude Code's own word that the agent waits on background work it owns: its task waits, and Claude Code reopens the same subagent when the work ends (the wait ends with it). If the host says the process ended and the subagent did not come back, resume it with SendMessage.

When the process ends, the subagent is expected back; if it does not come back within the run's `awaitGrace` (5 min
by default), the task counts as ended. A subagent that ends without finishing sends the task back to the queue
without spending an attempt; after `maxAgentEnded` such ends (3 by default) the task fails and the run pauses for a
person, with the reason in `jtasks status`: tell the user, and after they decide, `jtasks retry <id>` and
`jtasks unpause`.

As the orchestrator: leave a task waiting for a process alone (no `release`, no second subagent, not doing it
yourself, and never `jtasks wait` or `jtasks exec` on it: declaring its processes is its subagent's job, even with the
same pids) and go on with the others. Whatever the run does without your asking (a subagent ended, a task went back
to the queue, failed or waits for a process, a lock was lost, the run paused for a person) reaches you at once as a
message that starts with `jtasks: run <id> changed without your asking`, with the status line: act on it, it is read
from the run's log, not from the conversation. Every notification of a subagent's end carries the same status line.

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
- **A shell write refused because its path "cannot be checked"**: the path keeps a variable, a `$(…)` or a glob.
  Write the literal path (a variable the same command assigns is fine: `S=/tmp/x; … > $S/f`), or use Edit/Write.
- **`start` refused for a shared file** (`🔗` in `next` and `status`): the plan's `sharedPolicy` is `serialize` and
  another task in progress touches the same shared file; take another ready task. After the run,
  `jtasks status --claims` lists the most contested files, for the next plan's `shared`.
- **A task failed**: the tasks that depend on it stay blocked; the rest goes on. `jtasks retry <id>` reopens it.
- **A provider failure that clears by itself** (the host paused the run; `jtasks status` names the failure and when it resumes):
  With the mod, a subagent (or you) dying on a provider failure that clears by itself (a usage, session or rate limit, an overloaded API, the network, a timeout) pauses the run by itself: the task stays in progress with its locks and claims, and `jtasks status` says why and when it resumes. Do not release it, do not open another subagent for it (the mod refuses one), and do not call `next` or `start` meanwhile: end your turn. When the run is active again (at the reset the error gave, when Claude Code goes on after a usage limit, or after `jtasks unpause`), the mod sends you a message naming the agent of each kept task: resume that same agent with SendMessage and tell it to go on where it stopped, without calling `start` or `claim` again for what it holds. If that subagent no longer exists, continue the task yourself, or `jtasks release <id>` and open a
  new one. An invalid key, a refusal of the model or an overflowing context are ordinary failures: they go on as
  before.

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
