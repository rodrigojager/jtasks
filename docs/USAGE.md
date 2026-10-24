# goal-tasks usage

The reference of every command. What goal-tasks is and why it exists: the [README](../README.md). The design is in
[`PLAN.md`](PLAN.md) (Portuguese); departures from it are in [`DEVIATIONS.md`](DEVIATIONS.md); the skills for each
agent are in [`skills/README.md`](../skills/README.md). The same commands work in the CLI, the Claude Code mod
(`claude/`) and the OpenCode plugin (`opencode/`). Answers come in your language (see [Languages](#languages)).

Windows first: jlock was validated on Windows, and so was this.

## Install

From a clone, with [bun](https://bun.sh) and `git`: `bun install`, `bun link` (a `tasks` command; or
`bun D:/goal-tasks/cli/tasks.ts <action>`), then:

```
tasks doctor               # is this machine ready? eight checks, each with what to do
tasks doctor --fix         # what it would install (writes nothing)
tasks doctor --fix --yes   # installs it: jlock, the OpenCode agents, the skills
```

`tasks doctor` checks, in this order: the version (goal-tasks and the runtime); `git`; `jlock` (in `PATH`, at least
0.1.0, 0.1.1 for `--release-on-eof`, and its own `jlock doctor --json`); `GOAL_TASKS_HOME` (a writable folder, the
global ledger); OpenCode (the agents `implement`, `implement-deep`, `review` in `~/.config/opencode/agents/`, the
project's `.opencode/agents/` or `opencode.json`, and whether the plugin is configured); Claude Code (found, and
whether the mod is installed; informative); the skills `to-tickets` and `goal-tasks` of every agent installed
(Claude Code, OpenCode, Codex); and the language with where it came from. Exit 0 with no failure (warnings do not
change it), 20 with one; `--json` gives `{ result, checks: [{ name, status, detail, fix }], summary }`.

`--fix --yes` installs jlock through its official installer (which puts it in its own folder and adds that to the
user's `PATH`, as it does when you run it by hand), and copies the three OpenCode agents and the skills from this
repository. A file that already exists is never replaced (it is reported). Each file it creates is an effect in the
global ledger (`tasks ledger --all-projects`, ids `g-…`), and `tasks undo <g-id>` removes it. It never installs the
mod in Claude Code nor the plugin in OpenCode (see below), and only the CLI runs `--fix`; in the mod and the plugin
`doctor` only diagnoses. `GOAL_TASKS_USER_HOME` makes it look and install somewhere else than the user's home.

- **CLI:** the `tasks` command above (it needs `jlock` in `PATH`; `tasks doctor --fix --yes` installs it).
- **Claude Code mod:** `claude --plugin-dir D:/goal-tasks/claude` for one session, or add the repository as a
  marketplace and install `goal-tasks`. The tool is `mcp__goal-tasks__tasks`; the pane opens with `/jtasks`
  (Claude Code has its own `/tasks`). See [`claude/README.md`](../claude/README.md).
- **OpenCode plugin:** `"plugins": ["D:/goal-tasks/opencode"]` in an `opencode.jsonc`. See
  [`opencode/README.md`](../opencode/README.md).

The mod and the plugin carry their own copy of the core (`core/core.js`, built from `src/` by
`bun scripts/build.ts`) and take the same commands as the CLI: `{ "command": "start T04" }`, and
`{ "command": "plan --add", "json": [...] }` for JSON.

## The plan

```json
{
  "feature": "login-por-email",
  "objective": "Login por link mágico",
  "serialize": ["bun test"],
  "profiles": { "implement": { "claude": { "model": "sonnet", "effort": "medium", "role": "backend-developer" }, "opencode": { "agent": "implement" } } },
  "tasks": [
    { "id": "T01", "title": "Tipos de sessão", "files": ["src/session/types.ts"], "acceptance": ["bun test passa"] },
    { "id": "T02", "title": "Token", "dependsOn": ["T01"], "files": ["src/session/token.ts", "tests/session/**"] },
    { "id": "T03", "title": "Integração", "dependsOn": ["T02"], "exclusive": true, "profile": "implement" }
  ]
}
```

- `files`: files and folders relative to the repository; a folder owns everything inside it; `dir/**` is the
  folder; any other pattern (`src/*.ts`) is refused.
- Two tasks with no dependency between them may not share ownership (by jlock's rule: same path, or a folder above
  the other). `exclusive: true` holds `*` and runs alone.
- Without `profiles`: `implement`, `implement-deep`, `review` (the OpenCode agents of the same names come with
  the plugin, `opencode/agents/`; a profile may name any agent you already have). `maxAttempts` (default 2), `holdTtl` (default `"2h"`: a task's locks expire by
  themselves after this long if nobody gives them back, an agent or a window that died), `branch` (`"run"`: commit on
  `gt/<run>`, the default; `"current"`: on the current branch).

The full schema is [`schema.json`](../skills/claude-code/to-tickets/schema.json), beside the `to-tickets` skill,
which turns a conversation into this plan and delivers it. The skills (`to-tickets` to plan, `goal-tasks` to carry a
run out) exist for Claude Code, OpenCode and Codex; where they go and how to install them: [`skills/README.md`](../skills/README.md)
(the mod carries its own copy).

## Actions

Without `--run`, an action uses the run bound to the session (mod, plugin), `GOAL_TASKS_RUN`, or the only active
run of the repository. `--json` prints `{ ok, code, text, data }`.

| Group | Action | What it does |
|---|---|---|
| plan | `validate <json\|@file\|dir>` | validates a plan (or a folder of tickets) without writing |
| | `plan <json\|@file> [--name slug]` | creates the run: `run.json`, `tasks.json`, tickets, branch `gt/<run>`, `.scratch/` in `.git/info/exclude`, ledger |
| | `plan --draft [--name s] [--objective t]` | opens a draft (not a run yet) |
| | `plan --add <json\|@file>` | adds a batch; refused whole on any error of the batch |
| | `plan --fix <id> <json\|@file>` | replaces one task of the draft |
| | `plan --show` | ids, titles, dependencies and ownership of the draft |
| | `plan --commit` | complete validation; creates the run and removes the draft |
| | `import <dir> [--check\|--yes]` | Markdown tickets → run (a ticket without Files becomes `exclusive`) |
| run | `runs` | the runs of the repository, with status and progress |
| | `status` | `feitas F/T (P%) · … · restam N`, waits, ready and blocked tasks, active locks |
| | `pause` / `unpause` | paused: `start` refused |
| | `resume <run> [--keep-owners] [--from-archive]` | binds the session, leaves pause, releases in-progress tasks whose locks are gone |
| task | `next [limit]` | the ready tasks (can run in parallel): profile, criteria, ownership, ticket |
| | `start <id>` | in progress; holds the ownership (`jlock hold --no-wait`) |
| | `claim <id> <file…> [--timeout 60s]` | one more file; waits in jlock's queue; `timeout` and `deadlock` answered |
| | `done <id> --evidence "…"` | checks git and the locks, commits the ownership only (`T04: title`), releases |
| | `skip <id> --reason "…"` / `fail <id> --error "…"` | skipped (frees dependents) / failed (blocks them) |
| | `release <id>` | in progress → pending (failed at `maxAttempts`); uncommitted edits stay and are listed |
| | `retry <id>` / `retry --all-failed` | skipped or failed → pending |
| | `exec -- <command…>` | runs a command; one of `serialize` runs through `jlock run name:gt/<repo>/<command>` |
| ledger | `ledger [--all-projects]` | every effect the tool created, and its state |
| | `undo <e-id> \| --task <id> \| --run <run> [--force]` | undoes newest first (revert, branch, exclude line, folder) |
| | `effects --check` | compares the ledger with disk and git: what disappeared, what was left |
| machine | `doctor [--json] [--fix [--yes]]` | is this machine ready? `--fix --yes` installs what is missing, in the global ledger |
| cleanup | `clean <run>\|--all [--yes]` | lists the active effects; with `--yes` removes the run's folder |
| | `archive <run>` | moves the run to `GOAL_TASKS_HOME/archive/<repo>/<run>` |
| | `gc --scan <root> [--depth 4]` | read-only report: worktrees (orphan or not), runs, archived runs |
| | `gc --remove <path> --yes` | removes one path the report lists |

Exit codes of the CLI: 0 ok, 1 refused or invalid (the text says why), 2 wrong usage; `exec` passes the command's
code through.

## Locks

Owner `gt:<run>/<task>`, group `<run>`, intent = the task's title, meta `task`, `run`, `tool`, `session`. So
`jlock list --group <run> --json` is the run's locks and `jlock list --under <repo> --json` everything locked in the
repository. Every hold carries the run's `holdTtl` (`--ttl`), the safety net when nobody gives a lock back. How a
host holds them: the CLI and the mod use `jlock hold --detach` (one call, the answer in hand; jlock's own keeper
holds the lock until `tasks done`/`skip`/`fail`/`release`, which run `jlock release --group <run> --owner <owner>`,
or until the ttl); the OpenCode plugin, which stays open, uses `jlock hold --release-on-eof` with the hold's
standard input open, so OpenCode dying frees its locks at once (jlock 0.1.1 or newer; an older jlock gets
`--detach`). The tool needs jlock 0.1.0 at least and checks `jlock --version` once per process. A lock that
expired or was broken shows up in `tasks status` as `posse perdida`; `tasks resume` gives the task back to the
queue.

## Variables

| Variable | Default | Use |
|---|---|---|
| `GOAL_TASKS_HOME` | `%USERPROFILE%\.goal-tasks` | global ledger index and archived runs |
| `GOAL_TASKS_USER_HOME` | the user's home | where `tasks doctor` looks for and installs agents and skills |
| `GOAL_TASKS_RUN` | unset | the CLI's bound run |
| `GOAL_TASKS_LANG` | unset | the language of the answers (see [Languages](#languages)) |
| `JLOCK_BIN` | `jlock` | the jlock executable |
| `JLOCK_HOME`, `JLOCK_HEARTBEAT_MS`, `JLOCK_STALE_MS` | jlock's | passed through to jlock (only tests change them) |

## Languages

The answers, the help, the pane and the sidebar speak the language chosen by, in order: `--lang <tag>` on the
command, `GOAL_TASKS_LANG`, `JLOCK_LANG` (so one variable sets both tools), the system's language, and English.
Available, the same eleven as jlock: `en`, `pt-BR`, `es`, `fr`, `de`, `it`, `zh-CN`, `ja`, `ru`, `ar`, `hi`
(their status is in [`CONTRIBUTING.md`](../CONTRIBUTING.md)). A tag resolves like jlock's: `pt` and
`pt_PT.UTF-8` give `pt-BR`, `en-US` gives `en`; an unknown `--lang` answers in English with a warning on the first
line. Every `jlock` the tool starts gets `JLOCK_LANG` with the same tag, so the jlock messages it quotes match.

What does not change with the language: action and option names, `--json` (the data is the same in every
language), ids, `tasks.json`, `run.json`, `log.jsonl`, the ledger, the section headings of the generated tickets
(`What to build`, `Blocked by`, `Status`, `Files`, `Scope boundary`), and what the model reads: the protocol
injected into its prompt is English and quotes the tool's answers (`restam 0`, `0 left`) in the tool's language.

```
tasks next --lang en
tasks help claim --lang pt-BR
```

## With `/goal`

```
Planejar     to-tickets (passos 1–4, com "quais arquivos") → tasks plan --draft / --add / --commit
Claude Code  /goal todas as tarefas da execução <run> estão done ou skipped (tasks status responde "restam 0")
OpenCode     create_goal com o mesmo objetivo; update_goal com a saída de tasks status
Retomar      em qualquer janela: tasks resume <run> → /goal de novo
```

While a run is bound, the mod and the plugin inject the execution protocol: `tasks next`; one subagent per ready task
(all in one response), whose prompt carries `--run <run> --task <id>`, and which calls `tasks start`, `tasks claim`
when it needs another file, never git, and `tasks done` with evidence (or `tasks fail`); then `tasks status` until
"restam 0".

## Demonstration and tests

```
bun scripts/demo.ts            # the whole flow in a temporary repository, with its own jlock and ledger homes
bun test                       # core and CLI (real git and jlock in temporary folders under D:\claude-cache)
cd opencode && bun test        # the OpenCode plugin (a fake host, a scripted model)
claude plugin test claude      # the Claude Code mod (a fake machine)
bun run typecheck              # core, CLI, tests and mod
```

No test calls a model.
