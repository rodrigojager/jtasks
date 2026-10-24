# goal-tasks for Claude Code

The Claude Code mod of [goal-tasks](../README.md): the `tasks` tool (`mcp__goal-tasks__tasks`, the same contract as
the CLI), the run bound to the session (`$.state`, shared by subagents), the execution protocol in the system
prompt while a run is bound, a "Tasks" pane with the checklist and `/jtasks` (Claude Code has its own `/tasks`), the model of each subagent from its
task's profile, and the ownership guard on `Edit`/`Write`/`NotebookEdit`/`Bash` of subagents.

The folder is self-contained: `core/core.js` is the core (generated from `../src` by `bun scripts/build.ts`), and
the hooks module runs it with no Node and no `node_modules`. It needs `jlock` in `PATH` and `git`.

## Use it (not done by this repository)

For one session, from this folder's parent:

```
claude --plugin-dir D:/goal-tasks/claude
```

Or add the repository as a marketplace and install it; nothing here changes your Claude Code configuration.

## Language

The pane, `/jtasks` and the tool's answers speak the language picked when the session starts: `GOAL_TASKS_LANG`,
then `JLOCK_LANG`, then the system's language, then English (`en` and `pt-BR` today). A single call can ask for
another with `--lang <tag>` (`{ "command": "status --lang en" }`). The tool's description and the protocol in the
system prompt are English, for the model; `--json` data is the same in every language. Set the variable before
starting Claude Code, for example `GOAL_TASKS_LANG=en claude --plugin-dir D:/goal-tasks/claude`.

## Check it

```
claude plugin validate claude          # manifest, hooks module, state contract
claude plugin test claude              # the tests in claude/tests (a fake machine: no git, jlock or model calls)
bunx tsc -p tsconfig.claude.json       # types, against vendor/claude-code.d.ts (Claude Code 2.1.310)
```

## The tool

```
tasks { "command": "next" }
tasks { "command": "start T04" }
tasks { "command": "claim T04 src/x.ts --timeout 2m" }
tasks { "command": "done T04 --evidence \"bun test: 12 passed\"" }
tasks { "command": "plan --add", "json": [ { "id": "T05", "title": "…", "files": ["src/y.ts"] } ] }
```

`help` lists every action. A session bound to a run refuses `--run` naming another one.
