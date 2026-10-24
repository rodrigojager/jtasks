# goal-tasks for OpenCode

The OpenCode v2 plugin of [goal-tasks](../README.md): the `tasks` tool with the same contract as the CLI, the run
bound to the root session, the execution protocol and the run's progress in every model request (and in
compaction), the agent of each task's profile on its `subagent` call, and the ownership guard on `edit` and
`shell` permissions.

The package is self-contained: `core/core.js` (the core, generated from `../src` by `bun scripts/build.ts`) and
`core/node-host.js` travel with it. It needs `jlock` in `PATH` and `git`.

## Install (not done by this repository)

Point a configuration file at this folder; nothing here touches your OpenCode configuration:

```jsonc
// opencode.jsonc (project or ~/.config/opencode)
{
  "plugins": ["D:/goal-tasks/opencode"]
}
```

OpenCode loads the folder's `server.ts`; the package also exports `./tui` (`tui.tsx`, the sidebar section) and
`./rpc` (`goal-tasks.state`, the data the section reads).

## Agents

A task's profile names the OpenCode agent its `subagent` call must use (`opencode.agent`). The default profiles name
`implement`, `implement-deep` and `review`, and the package brings those three agents ready in `agents/`
(`mode: subagent`, the task protocol in the body: `tasks start` first, `tasks claim` for one more file, never git,
`tasks done` with evidence or `tasks fail`). A plugin cannot create agents, so they have to be installed where
OpenCode reads them: `tasks doctor --fix --yes` copies them to `~/.config/opencode/agents/` (recorded in the global
ledger, undone by `tasks undo`), or copy them yourself. A profile may name any agent you already have instead; a
profile with `opencode.model` gives that agent the model for the session (see `docs/DEVIATIONS.md`). After
`plan --commit` and `resume`, the tool warns about a profile whose agent does not exist; the run is created anyway.

## Language

The sidebar section and the tool's answers speak the language picked when OpenCode starts (the server and the TUI
each pick it the same way): `GOAL_TASKS_LANG`, then `JLOCK_LANG`, then the system's language, then English (`en`
and `pt-BR` today). A single call can ask for another with `--lang <tag>`. The tool's description and the protocol
injected into each request are English, for the model; `--json` data is the same in every language.

## The sidebar section

In a session bound to a run, the sidebar shows `▾ Tasks · <run>`, the bar with `done/total · skipped · failed`,
and one line per task (☑ done with its commit, ◐ running with its profile, ☐ pending with ⛔/🔒/⏳ and the reason,
⊘ skipped, ✗ failed). A click on the header folds it to `▸ Tasks 7/12 · 58%`. Without a bound run it lists the
repository's runs.

## The tool

```
tasks { "command": "next" }
tasks { "command": "start T04" }
tasks { "command": "claim T04 src/x.ts --timeout 2m" }
tasks { "command": "done T04 --evidence \"bun test: 12 passed\"" }
tasks { "command": "plan --add", "json": [ { "id": "T05", "title": "…", "files": ["src/y.ts"] } ] }
```

`help` lists every action. A session bound to a run refuses `--run` naming another one.

## When a subagent or OpenCode dies

A subagent's session that goes idle (or is deleted) while its task is still in progress gives the task back to the
queue: `release --agent-ended` (the attempt was counted at `start`; at `maxAttempts` the task fails), its locks are
released, the edits stay on disk and the log says `agent-ended`. The root session going idle is the orchestrator
waiting and changes nothing. If OpenCode itself dies, each `jlock hold --release-on-eof` reads the end of its input
and the locks are freed at once; `tasks status` then shows `posse perdida` and `tasks resume` gives the tasks back.

## Tests

```
bun install
bun test        # a fake OpenCode host with a scripted model; real jlock and git in temporary folders
bun run typecheck
```

No test calls a model.
