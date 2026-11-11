# jtasks for OpenCode

The OpenCode v2 plugin of [jtasks](../README.md): the `jtasks` tool with the same contract as the CLI, the run bound
to the root session, the execution protocol and the run's progress in every model request (and in compaction), the
agent of each task's profile on its `subagent` call, the ownership guard on `edit` and `shell` permissions, and the
keepalive: when the root session goes idle with a task ready and no subagent alive, the plugin sends it a synthetic
message (`session.synthetic`) that resumes the loop; after two with no progress it stops and shows a notice in the
sidebar (and a toast). `jtasks pause` and `jtasks keepalive off` keep it quiet. Every minute the plugin also renews
the locks of the tasks its sessions started (in place with jlock 0.2.0's `jlock renew`), before the run's `holdTtl`
expires them, so a task that runs for hours keeps its files and is never given back as lost.

The package is self-contained: `core/core.js` (the core, generated from `../src` by `bun scripts/build.ts`) and
`core/node-host.js` travel with it. It needs `git`; `jlock` comes by itself: when it is missing, the plugin installs
it through jlock's official installer as soon as it loads, and the first tool answer says where
(`JTASKS_NO_JLOCK_INSTALL=1` turns this off).

## Install (not done by this repository)

Point a configuration file at this folder; nothing here touches your OpenCode configuration:

```jsonc
// opencode.jsonc (project or ~/.config/opencode)
{
  "plugins": ["D:/jtasks/opencode"]
}
```

OpenCode loads the folder's `server.ts`; the package also exports `./tui` (`tui.tsx`, the sidebar section) and
`./rpc` (`jtasks.state`, the data the section reads).

## Agents

Recognized task delegations always use `background: true`, even when omitted or explicitly false and even when
the requested profile agent is already correct. This includes markerless resumptions of the same bound child
(`task_id`). Unrelated and unbound delegations are unchanged. Paused runs reject new task launches and resumptions.
A launch acknowledgment is not completion: the child keeps running independently, and admission counts as live
work before its first `start`. Do not poll or create a second session for the same task.

Long commands run in the child's foreground through `jtasks exec --task <id> -- <command>`, while the parent stays
responsive. Explicitly interrupting that child passes OpenCode's cancellation signal to its native command tree
and clears its command deadline. It never kills by name, scans other projects' process lists, or releases another
task's locks. Interrupting only the parent delegation does not cancel an independent background child. Command
cancellation returns 130 when its result is observed; it does not mark the task done or retry it.

A task's profile names the OpenCode agent its `subagent` call must use (`opencode.agent`). The default profiles name
`execute`, `execute-deep` and `review`, and the package brings those three agents ready in `agents/`
(`mode: subagent`, the task protocol in the body: `jtasks start` first, `jtasks claim` for one more file, never git,
`jtasks done` with evidence or `jtasks fail`). A plugin cannot create agents, so they have to be installed where
OpenCode reads them: `jtasks doctor --fix --yes` copies them to `~/.config/opencode/agents/` (recorded in the global
ledger, undone by `jtasks undo`), or copy them yourself. A profile may name any agent you already have instead; a
profile with `opencode.model` gives that agent the model for the session (see `docs/DEVIATIONS.md`). After
`plan --commit` and `resume`, the tool warns about a profile whose agent does not exist; the run is created anyway.

## Language

The sidebar section and the tool's answers speak the language picked when OpenCode starts (the server and the TUI
each pick it the same way): `JTASKS_LANG`, then `JLOCK_LANG`, then the system's language, then English (`en`
and `pt-BR` today). A single call can ask for another with `--lang <tag>`. The tool's description and the protocol
injected into each request are English, for the model; `--json` data is the same in every language.

## The sidebar section

In a session bound to a run, the sidebar shows a `▾ Tasks` header. The first row is `Progress`: the bar (in the
opencode-hud style), the percent and `done/total`. Then comes one row per task, showing only its title, after a mark:

- a green `✓` when the task is done;
- OpenCode's spinner while it runs: the 3×2 grid of squares with two neighbouring squares missing, the gap going
  round, animated in the theme's hue;
- nothing, and the title in dim gray, while it is pending;
- a red `✗` when it failed.

```
▾ Tasks
Progress ██████▋███ 66% · 2/3
✓ Pane model: claude-hud bar and task rows
⠶ Pane render and spinner
  Pane documentation
```

A click on the header folds the section to `▸ Tasks 2/3 · 66%`, and another click opens it again. Without a bound
run the section lists the repository's runs.

## The tool

```
tasks { "command": "next" }
tasks { "command": "start T04" }
tasks { "command": "claim T04 src/x.ts --timeout 2m" }
tasks { "command": "yield T05" }
tasks { "command": "done T04 --evidence \"bun test: 12 passed\"" }
tasks { "command": "plan --add", "json": [ { "id": "T05", "title": "…", "files": ["src/y.ts"] } ] }
```

`help` lists every action. A session bound to a run refuses `--run` naming another one. A claim refused for a
deadlock is answered with `yield`: the task gives back only the contested files, its edits kept as patches, and stays
in progress; the sidebar shows "title · espera c.ts" until it gets them back, which happens by itself as soon as they are free (each minute, or when another task finishes)
or with `claim T05`. A plan may list in `shared` the registry files several tasks touch; with
`"sharedPolicy": "serialize"` two tasks touching the same one never run together, and `status --claims` shows the
most contested files of a run.

## When a subagent or OpenCode dies

A subagent's session that goes idle (or is deleted) while its task is still in progress gives the task back to the
queue: `release --agent-ended` (the attempt was counted at `start`; at `maxAttempts` the task fails), its locks are
released, its edits are kept as patches (the tree is left clean; the next `start` of the task reapplies them) and
the log says `agent-ended`. The root session going idle is the orchestrator
waiting and changes nothing. If OpenCode itself dies, each `jlock hold --release-on-eof` reads the end of its input
and the locks are freed at once; `jtasks status` then shows `posse perdida` and `jtasks resume` gives the tasks back.

A session whose execution fails on a transient failure of the provider (`session.execution.failed` with a
`RateLimit`, `QuotaExceeded`, `ProviderInternal`, `Transport` or `Timeout` error, a `429`/`5xx` status, or the words
of a usage limit, an overloaded server or a dropped connection in the message or body; v1's `session.error` with
`APIError` too) does not give its task back: the run is paused, the task stays in progress with its locks, and every
15 s the plugin looks for the pause's `resumeAt` (the reset the error gave, or a backoff). Then the run is active again
and the root session is told to resume the same subagent session (`task_id`). See
[Transient failures](../docs/USAGE.md#transient-failures).

A child session that goes idle while a process of its task runs (one `jtasks exec --task` started, or
`jtasks wait <id> --pid <pid>` declared) does not give its task back either: the task waits for the process, in
progress with its locks and the session's binding. OpenCode does not reopen that session when the process ends, so
the plugin tells the root session to resume it (`task_id`); if it does not come back within the run's `awaitGrace`, the
task goes back to the queue, without spending an attempt. Whatever the run does without the root session asking
reaches it at once as a synthetic message with the status line, and the TUI as a toast; every subagent call's result
carries the status line too. See [Waiting for a process](../docs/USAGE.md#waiting-for-a-process).

## Tests

```
bun install
bun test        # a fake OpenCode host with a scripted model; real jlock and git in temporary folders
bun run typecheck
```

No test calls a model.

The opt-in `test/real-lifecycle.test.ts` runs the installed OpenCode executable and real plugin loader against a
loopback scripted provider (no paid models). Set `OPENCODE_BIN` to the native executable and optionally
`JTASKS_E2E_PACKAGE` to a separately installed jtasks release root. It uses isolated configuration, storage and lock
registries, proves the parent responds while the child is gated in native work, then interrupts only the child and
checks descendant death. It never opens or resumes existing sessions or runs.

## Foreground execution safety (0.8)

The optional Windows launcher [`scripts/opencode-isolated.ps1`](../scripts/opencode-isolated.ps1) is a compatibility entrypoint for OpenCode v2,
using the complete original profile: provider connections, model choices, preferences and session history stay available. The historical script name is retained for wrapper compatibility; it no longer creates a private server or copies credentials. It does not restart, reload or unlock an existing service. Install plugin updates separately when safe; an already running service retains its loaded version.

Requires **jlock 0.4.2** or newer. Every `jtasks exec -- <command...>` uses the same native
supervisor in the CLI, OpenCode plugin and Claude Code mod. The deadline includes waiting for serialization.
The CLI and OpenCode default to 10 minutes; Claude defaults to and accepts at most 9 minutes 45 seconds,
reserving 15 seconds inside its runtime ceiling for cleanup. `--timeout` sets an explicit command deadline.
Timeout returns **124** (`data.timedOut: true`) after descendant cleanup. It leaves the task in progress,
its task locks and existing edits intact; it does not retry, release, commit or mark work done.

Windows Job Objects contain descendants before they start, even if a shell exits first or the supervisor dies.
Unix process groups cover ordinary descendants, with no guarantee for deliberately detached sessions or hard
supervisor death. Persistent background services, Docker daemon workloads and remote jobs need explicit
lifecycle management. Node/Bun output retains the last 1 Mi characters per stream, with a truncation marker,
while continuing to drain pipes. Claude retains its runtime output limit and now marks truncation explicitly.
Process registration refers to the supervisor, whose lifetime covers the command.

A nonzero result is evidence of a failed command, not proof that the task is complete. Inspect the output and
saved edits before retrying. If native cleanup reports `cleanup pending`, preserve the locks and investigate
that command; never unlock by age or kill processes by name. Install new versions in separate directories and
select them only for new sessions while existing agents finish on their original binaries and plugin files.
The event log, task generations, patch recovery, same-agent waits and in-place renewal remain unchanged.
