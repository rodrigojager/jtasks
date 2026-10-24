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

OpenCode loads the folder's `server.ts`. The agents named by the profiles (`impl`, `impl-deep`, `review` by
default) are your own agents in `opencode.json`; a profile with `opencode.model` gives that agent the model for
the session (see `docs/DEVIATIONS.md`).

## The tool

```
tasks { "command": "next" }
tasks { "command": "start T04" }
tasks { "command": "claim T04 src/x.ts --timeout 2m" }
tasks { "command": "done T04 --evidence \"bun test: 12 passed\"" }
tasks { "command": "plan --add", "json": [ { "id": "T05", "title": "…", "files": ["src/y.ts"] } ] }
```

`help` lists every action. A session bound to a run refuses `--run` naming another one.

## Tests

```
bun install
bun test        # a fake OpenCode host with a scripted model; real jlock and git in temporary folders
bun run typecheck
```

No test calls a model.
