# jtasks usage

The reference of every command. What jtasks is and why it exists: the [README](../README.md). The design is in
[`PLAN.md`](PLAN.md) (Portuguese); departures from it are in [`DEVIATIONS.md`](DEVIATIONS.md); the skills for each
agent are in [`skills/README.md`](../skills/README.md). The same commands work in the CLI, the Claude Code mod
(`claude/`) and the OpenCode plugin (`opencode/`). Answers come in your language (see [Languages](#languages)).

Windows first: jlock was validated on Windows, and so was this.

## Install

From a clone, with [bun](https://bun.sh) and `git`: `bun install`, `bun link` (a `jtasks` command; or
`bun D:/jtasks/cli/jtasks.ts <action>`), then:

```
jtasks doctor               # is this machine ready? eight checks, each with what to do
jtasks doctor --fix         # what it would install (writes nothing)
jtasks doctor --fix --yes   # installs it: jlock, the OpenCode agents, the skills
```

`jtasks doctor` checks, in this order: the version (jtasks and the runtime); `git`; `jlock` (in `PATH`, at least
0.1.0, 0.1.1 for `--release-on-eof`, 0.2.0 for `jlock renew`, and its own `jlock doctor --json`); `JTASKS_HOME` (a writable folder, the
global ledger); OpenCode (the agents `execute`, `execute-deep`, `review` in `~/.config/opencode/agents/`, the
project's `.opencode/agents/` or `opencode.json`, and whether the plugin is configured); Claude Code (found, and
whether the mod is installed; informative); the skills `to-jtasks` and `jtasks` of every agent installed
(Claude Code, OpenCode, Codex); and the language with where it came from. Exit 0 with no failure (warnings do not
change it), 20 with one; `--json` gives `{ result, checks: [{ name, status, detail, fix }], summary }`.

`--fix --yes` installs jlock through its official installer (which puts it in its own folder and adds that to the
user's `PATH`, as it does when you run it by hand), and copies the three OpenCode agents and the skills from this
repository. A file that already exists is never replaced (it is reported). Each file it creates is an effect in the
global ledger (`jtasks ledger --all-projects`, ids `g-…`), and `jtasks undo <g-id>` removes it. It never installs the
mod in Claude Code nor the plugin in OpenCode (see below), and only the CLI runs `--fix`; in the mod and the plugin
`doctor` only diagnoses. `JTASKS_USER_HOME` makes it look and install somewhere else than the user's home.

- **CLI:** the `jtasks` command above. jlock comes by itself: in every form, the first command that may need it
  installs a missing jlock through its official installer, records it in the global ledger (`jtasks undo <g-id>`
  removes it), uses it at once and says where; the mod and the plugin do it as soon as they load. `JLOCK_BIN` (your
  own jlock) or `JTASKS_NO_JLOCK_INSTALL=1` turns this off.
- **Claude Code mod:** `claude --plugin-dir D:/jtasks/claude` for one session, or add the repository as a
  marketplace and install `jtasks`. The tool is `mcp__jtasks__jtasks`; the pane opens with `/jtasks`
  (Claude Code has its own `/tasks`). See [`claude/README.md`](../claude/README.md).
- **OpenCode plugin:** `"plugins": ["D:/jtasks/opencode"]` in an `opencode.jsonc`. See
  [`opencode/README.md`](../opencode/README.md).

The mod and the plugin carry their own copy of the core (`core/core.js`, built from `src/` by
`bun scripts/build.ts`) and take the same commands as the CLI: `{ "command": "start T04" }`, and
`{ "command": "plan --add", "json": [...] }` for JSON.

## The plan

```json
{
  "feature": "login-por-email",
  "objective": "Login por link mágico",
  "source": "https://github.com/acme/app/issues/42",
  "serialize": ["bun test"],
  "shared": ["src/session/types.ts"],
  "sharedPolicy": "serialize",
  "profiles": { "execute": { "claude": { "agent": "jtasks:execute", "model": "sonnet", "effort": "medium", "role": "backend-developer" }, "opencode": { "agent": "execute" } } },
  "tasks": [
    { "id": "T01", "title": "Tipos de sessão", "files": ["src/session/types.ts"], "acceptance": ["bun test passa"] },
    { "id": "T02", "title": "Token", "dependsOn": ["T01"], "files": ["src/session/token.ts", "tests/session/**"], "touchesShared": ["src/session/types.ts"] },
    { "id": "T03", "title": "Integração", "dependsOn": ["T02"], "exclusive": true, "profile": "execute" }
  ]
}
```

- `source`: the spec, issue or document the plan came from (a path or a URL); every ticket shows it as `Source`, and
  a task may name its own. `what` is the behaviour the task delivers; `acceptance`, the criteria its `done` answers.
- `files`: files and folders relative to the repository; a folder owns everything inside it; `dir/**` is the
  folder; any other pattern (`src/*.ts`) is refused.
- Two tasks with no dependency between them may not share ownership (by jlock's rule: same path, or a folder above
  the other). `exclusive: true` holds `*` and runs alone.
- `shared`: the registry files, indexes, schemas and central types several tasks touch (the manifest every adapter
  adds a line to, say). A task that touches one without owning it lists it in `touchesShared` (it claims it when it
  needs it; an entry outside `shared` is an error). `validate` and `plan` **warn** when two tasks with no dependency
  between them touch the same shared file, and say how to order them: chain them with `dependsOn`, leave the file to
  one of them, or `"sharedPolicy": "serialize"`. With `serialize` there is no warning: the frontier never runs two
  tasks touching the same shared file at the same time (`next` holds the second back with `🔗 T01: <file>
  (compartilhado)`, and its `start` is refused), and the file enters neither ownership. The default, `"warn"`, only
  warns. After a run, `jtasks status --claims` lists the files that were most contested: the next plan's `shared`.
- Without `profiles`: `execute`, `execute-deep`, `review`. Their agents come with the packages: in OpenCode the
  agents of the same names (`opencode/agents/`, installed by `jtasks doctor --fix`); in Claude Code the mod's own
  `jtasks:execute`, `jtasks:execute-deep`, `jtasks:review` (`claude/agents/`, generated from the OpenCode ones). A
  profile may name any agent you already have (`claude.agent`, `opencode.agent`). In Claude Code, `claude.model`
  is the subagent's model and `claude.effort` (`low` to `max`) the effort of every request it makes; in OpenCode,
  `opencode.model` (`providerID`, `modelID`, and `variant` for the reasoning level), otherwise the session's. `maxAttempts` (default 2), `holdTtl` (default `"2h"`: a
  task's locks expire by themselves after this long if nobody renews or gives them back, a window that died; the mod
  and the plugin renew the locks of their tasks in progress, so a long task keeps them), `branch` (`"run"`: commit on
  `gt/<run>`, the default; `"current"`: on the current branch).

The full schema is [`schema.json`](../skills/claude-code/to-jtasks/schema.json), beside the `to-jtasks` skill,
which turns a conversation into this plan and delivers it. The skills (`to-jtasks` to plan, `jtasks` to carry a
run out) exist for Claude Code, OpenCode and Codex; where they go and how to install them: [`skills/README.md`](../skills/README.md)
(the mod carries its own copy).

## Actions

Without `--run`, an action uses the run bound to the session (mod, plugin), `JTASKS_RUN`, or the only active
run of the repository. `--json` prints `{ ok, code, text, data }`.

| Group | Action | What it does |
|---|---|---|
| plan | `validate <json\|@file\|dir>` | validates a plan (or a folder of tickets) without writing; prints the warnings about shared files |
| | `plan <json\|@file> [--name slug]` | creates the run: `run.json`, `tasks.json`, tickets, branch `gt/<run>`, `.scratch/` in `.git/info/exclude`, ledger |
| | `plan --draft [--name s] [--objective t] [--source r]` | opens a draft (not a run yet) |
| | `plan --add <json\|@file>` | adds a batch; refused whole on any error of the batch |
| | `plan --fix <id> <json\|@file>` | replaces one task of the draft |
| | `plan --show` | ids, titles, dependencies and ownership of the draft |
| | `plan --commit` | complete validation; creates the run and removes the draft |
| | `import <dir> [--check\|--yes]` | Markdown tickets → run (a ticket without Files becomes `exclusive`) |
| run | `runs` | the runs of the repository, with status and progress |
| | `status [--claims]` | `feitas F/T (P%) · … · restam N`, waits, ready and blocked tasks, active locks; `--claims` adds the run's most contested files, from its log (claims, timeouts, deadlocks and yields per file, with the tasks; `claims` in `--json`) |
| | `pause` / `unpause` | paused: `start` refused, and the keepalive stays quiet; `unpause` of a [transient pause](#transient-failures) takes back expired locks and names the agent to resume |
| | `keepalive on\|off` | the host reopens the loop when the orchestrator stops with ready tasks (default on; see [With `/goal`](#with-goal)) |
| | `resume <run> [--keep-owners] [--from-archive]` | binds the session, leaves pause, releases in-progress tasks whose locks are gone |
| task | `next [limit]` | the ready tasks (can run in parallel): profile, criteria, ownership, ticket |
| | `start <id> [--fresh]` | in progress; holds the ownership (`jlock hold --no-wait`); reapplies the edits an earlier attempt left as patches (`--fresh`: leaves them out) |
| | `claim <id> [<file…>] [--timeout 60s]` | one more file; waits in jlock's queue; `timeout` and `deadlock` answered; without files, takes back what the task yielded |
| | `yield <id> [<file…>]` | gives back only the contested files (without files: the ones that close the cycle of its last deadlock); the task stays in progress, its edits of them kept as patches, reapplied when they are its again (see [Deadlock and yield](#deadlock-and-yield)) |
| | `done <id> --evidence "…"` | checks git and the locks, commits the ownership only (`T04: title`), releases |
| | `skip <id> --reason "…"` / `fail <id> --error "…"` | skipped (frees dependents) / failed (blocks them) |
| | `release <id>` | in progress → pending (failed at `maxAttempts`); its uncommitted edits are kept as patches and the tree is left clean (see [Releasing keeps the edits](#releasing-keeps-the-edits)) |
| | `retry <id>` / `retry --all-failed` | skipped or failed → pending |
| | `exec -- <command…>` | runs a command; one of `serialize` runs through `jlock run name:gt/<repo>/<command>` |
| ledger | `ledger [--all-projects]` | every effect the tool created, and its state |
| | `undo <e-id> \| --task <id> \| --run <run> [--force]` | undoes newest first (revert, branch, exclude line, folder) |
| | `effects --check` | compares the ledger with disk and git: what disappeared, what was left |
| machine | `doctor [--json] [--fix [--yes]]` | is this machine ready? `--fix --yes` installs what is missing, in the global ledger |
| cleanup | `clean <run>\|--all [--yes]` | lists the active effects; with `--yes` removes the run's folder |
| | `archive <run>` | moves the run to `JTASKS_HOME/archive/<repo>/<run>` |
| | `gc --scan <root> [--depth 4]` | read-only report: worktrees (orphan or not), runs, archived runs |
| | `gc --remove <path> --yes` | removes one path the report lists |

Exit codes of the CLI: 0 ok, 1 refused or invalid (the text says why), 2 wrong usage; `exec` passes the command's
code through.

## Locks

Owner `gt:<run>/<task>`, group `<run>`, intent = the task's title, meta `task`, `run`, `tool`, `session`. So
`jlock list --group <run> --json` is the run's locks and `jlock list --under <repo> --json` everything locked in the
repository. Every hold carries the run's `holdTtl` (`--ttl`), the safety net when nobody gives a lock back. How a
host holds them: the CLI and the mod use `jlock hold --detach` (one call, the answer in hand; jlock's own keeper
holds the lock until `jtasks done`/`skip`/`fail`/`release`, which run `jlock release --group <run> --owner <owner>`,
or until the ttl); the OpenCode plugin, which stays open, uses `jlock hold --release-on-eof` with the hold's
standard input open, so OpenCode dying frees its locks at once (jlock 0.1.1 or newer; an older jlock gets
`--detach`). The tool needs jlock 0.1.0 at least and checks `jlock --version` once per process. A lock that
expired or was broken shows up in `jtasks status` as `posse perdida`; `jtasks resume` gives the task back to the
queue.

jlock's `--ttl` expires a hold that long after it was granted, even with its owner alive. So the hosts that stay
open (the mod and the plugin) look every minute at the tasks in progress they started, and the hold that expires in
less than 10 minutes (or half the `holdTtl`, if that is shorter) gets a new deadline (`renew` in `log.jsonl`): with
jlock 0.2.0, `jlock renew` pushes it back in place, and the lock is never let go; with an older jlock, it is given
back and taken again at once (`jtasks doctor` warns and suggests `jlock update`). One that already expired is taken
again (`retake`). `jtasks done`,
from any host and the CLI, takes back its own expired keys when nobody else took them, and refuses only when someone
did. The ttl still frees the locks of a window that died, since nobody renews them.

### Deadlock and yield

When tasks pick files up as they go, two of them can wait for each other: T04 holds `core/run/index.ts` and asks for
`core/plan/adapters.ts`, T05 holds `core/plan/adapters.ts` and asks for `core/run/index.ts`. jlock sees the cycle and
refuses the last to ask (`claim-deadlock` in `log.jsonl`); the answer tells that task to yield:

```
jtasks yield T05                      # gives back the keys of T05 that close the cycle (from jlock's chain)
jtasks yield T05 core/plan/adapters.ts  # or the ones you name (an entry of its ownership, a whole folder)
```

For each file given back, the uncommitted edit is saved as a patch of the run
(`.scratch/jtasks/runs/<run>/patches/<task>/<n>-<file>.patch`: the diff against HEAD, or the whole content of a new
file), the file goes back to HEAD (a new file is deleted), and the key is released in jlock, so the other task gets
it at once and its commit takes none of these edits. The task stays `in_progress` with its other locks; the entries
move from `files`/`claimed` to `yielded`, the guard refuses its edits there, `status`, the pane and the sidebar show
`⏳ cedeu …` (`waits for …`), and no new task starts on those keys meanwhile. They come back to the task:

- by themselves, as soon as they are free: after another task's `done`/`release`/`skip`/`fail`, on `jtasks next`, and
  on every pass (each minute) of the mod and the plugin;
- or with `jtasks claim <id>` (no files: what it yielded; it waits in jlock's queue like any claim), which also says
  when they already came back.

When the key comes back, each patch is reapplied over the new HEAD with `git apply --3way`: clean, the file is edited
again and the patch moves to `patches/<task>/applied/`; with a conflict, the file keeps the markers, the answer lists
it, and the patch stays where it was. The index is left at HEAD. Every step is an effect in the ledger: `patch` (the
patch file), `restore` (the file put back to HEAD; `jtasks undo <e-id>` puts the edit back, never over another task
in progress, and only on a clean file) and `reapply` (`jtasks undo <e-id>` takes the reapplied edit out). These are
undone one by one, never by `undo --task` or `undo --run`. A file whose key someone else holds by now is never
touched (listed as such), and a key whose edit could not be saved is not given back.

### Releasing keeps the edits

A task that leaves `in_progress` without a commit (`release`, `release --agent-ended` when its subagent ended,
`resume` releasing a task whose locks are gone, a lost lock, `maxAttempts`, `fail`, `skip`) does what `yield` does,
for every file of its ownership with an uncommitted edit: the edit becomes a patch (`by: "release"`), the file goes
back to HEAD (a new file is deleted), all through the ledger. So the tree is left clean, and no other task's `done`
is refused for those files or commits them. The next `start` of the task reapplies the patches with `--3way` and
lists what came back and any conflict; `start <id> --fresh` leaves them out (they stay in the run folder and the
ledger, for anyone who wants them back with `jtasks undo <e-id>`).

Only the task's own files are touched: those in its `files` and `claimed`, whose key is still its own in jlock (or
free, and taken by no other task since, by the log). A file whose key another owner holds by now is left as it is,
and the answer says so. If a patch cannot be made, the file stays on disk and is listed as `uncommitted` in the
log; another task's `done` then neither refuses for it nor commits it, and says `T04, released, has pending edits
in: …` (the same for a run from before this). The orchestrator never has to hold such files with a `jlock hold` of
its own.

### The guard

In the mod and the plugin, a subagent bound to a task edits only inside its ownership: an `Edit`/`Write` outside it
is refused with `jtasks claim <id> <file>` as the way out, git that changes the repository is refused, and nobody
edits `tasks.json`, `run.json` or the tickets by hand. A `Bash` (or OpenCode `shell`) command is read like the shell
reads it: quotes, `&&`/`||`/`;`/`|`, comments, redirections (`>`, `>>`, `&>`, `>|`; `2>&1` and `>&-` are not files),
heredocs (the body is data; `cat > file <<'EOF'` writes `file`), `cd`, the variables the command assigns itself
(`S=/tmp/x; bun test > $S/run.log`, `export S=…`, `S=… cmd`), `~` and `$HOME`. `sed -i` writes only its files (not
the `-e`/`-f` script; `-i.bak`, `-i ''` too) and `cp` only its destination. A path that keeps a variable, a `$(…)`, a
backquote or a glob cannot be checked: it passes when it is plainly outside the repository (`/tmp/$X/f`), and is
refused otherwise with "the path … cannot be checked; use the literal path, or Edit/Write", never with a `claim` of a
path with `$`. The main agent is only kept out of the run's own files.

## Variables

| Variable | Default | Use |
|---|---|---|
| `JTASKS_HOME` | `%USERPROFILE%\.jtasks` | global ledger index and archived runs |
| `JTASKS_USER_HOME` | the user's home | where `jtasks doctor` looks for and installs agents and skills |
| `JTASKS_RUN` | unset | the CLI's bound run |
| `JTASKS_LANG` | unset | the language of the answers (see [Languages](#languages)) |
| `JLOCK_BIN` | `jlock` | the jlock executable |
| `JTASKS_NO_JLOCK_INSTALL` | unset | `1`: never install a missing jlock by itself |
| `JTASKS_KEEPALIVE_TRIES` | `2` | keepalive messages with no progress before the host gives up and tells the person (`0`: give up at once) |
| `JLOCK_HOME`, `JLOCK_HEARTBEAT_MS`, `JLOCK_STALE_MS` | jlock's | passed through to jlock (only tests change them) |

## Languages

The answers, the help, the pane and the sidebar speak the language chosen by, in order: `--lang <tag>` on the
command, `JTASKS_LANG`, `JLOCK_LANG` (so one variable sets both tools), the system's language, and English.
Available, the same eleven as jlock: `en`, `pt-BR`, `es`, `fr`, `de`, `it`, `zh-CN`, `ja`, `ru`, `ar`, `hi`
(their status is in [`CONTRIBUTING.md`](../CONTRIBUTING.md)). A tag resolves like jlock's: `pt` and
`pt_PT.UTF-8` give `pt-BR`, `en-US` gives `en`; an unknown `--lang` answers in English with a warning on the first
line. Every `jlock` the tool starts gets `JLOCK_LANG` with the same tag, so the jlock messages it quotes match.

What does not change with the language: action and option names, `--json` (the data is the same in every
language), ids, `tasks.json`, `run.json`, `log.jsonl`, the ledger, the section headings of the generated tickets
(`What to build`, `Source`, `Blocked by`, `Status`, `Files`, `Scope boundary`), and what the model reads: the protocol
injected into its prompt is English and quotes the tool's answers (`restam 0`, `0 left`) in the tool's language.

```
jtasks next --lang en
jtasks help claim --lang pt-BR
```

## With `/goal`

```
Planejar     to-jtasks (passos 1–4, com "quais arquivos") → jtasks plan --draft / --add / --commit
Claude Code  /goal todas as tarefas da execução <run> estão done ou skipped (jtasks status responde "restam 0")
OpenCode     create_goal com o mesmo objetivo; update_goal com a saída de jtasks status
Retomar      em qualquer janela: jtasks resume <run> → /goal de novo
```

While a run is bound, the mod and the plugin inject the execution protocol: `jtasks next`; one subagent per ready task
(all in one response), whose prompt carries `--run <run> --task <id>`, and which calls `jtasks start`, `jtasks claim`
when it needs another file, never git, and `jtasks done` with evidence (or `jtasks fail`); then `jtasks status` until
"restam 0". When something depends on the person, the orchestrator calls `jtasks pause` and asks.

**Keepalive.** The goal does not notice a turn that ends with a task ready and nothing running (after a compaction,
say, the summary still thinks a finished task is running). So when the orchestrator's turn ends, the mod and the
plugin ask the core: if the run is not paused, has a ready task (or one in progress that nobody works on), has
`keepalive` on and no subagent of the session is alive, they send the session a message themselves:

```
jtasks: run fase-4-261025-2byp is idle · done 7/9 · 2 left · ready: T08 · no subagent is running.
This is a fact read from tasks.json now, not from the conversation's summary. Continue the protocol now: call jtasks
next and open the subagents. If something depends on the person, call jtasks pause and ask them.
```

- Claude Code: on `turn.complete` of the main loop with `reason: "answer"`, in an interactive session; live agents
  from `$.agent.list()`; the message goes through `$.prompt.submit` and is checked again just before it enters (a
  subagent that started meanwhile drops it). A draft in the prompt box makes it wait until the box is empty.
- OpenCode: on `session.idle` of the root session after an execution that succeeded; live agents are the child
  sessions still running or holding a task; the message is a `session.synthetic` queued on the root session.
- Never after a turn the person interrupted (quiet until the run moves). After an API error or a refusal (an OpenCode
  execution that failed) nothing is sent, since it could fail the same way: the person is told at once instead.
- The same progress (done, skipped, failed, in progress) twice more than `JTASKS_KEEPALIVE_TRIES` times: the host
  gives up and tells the person in their language (Claude Code: a toast, a notification, the status line and a line
  in the pane; OpenCode: a line in the sidebar and a toast), and stays quiet until the run moves.
- What it sent lives in the run's `keepalive.json` and in `log.jsonl` (`keepalive-nudge`, `keepalive-stalled`);
  `jtasks status` shows `retomada: desligada` or the last message or give-up. `jtasks keepalive off` turns it off for
  the run, `jtasks keepalive on` back on (forgetting a give-up, not a count in progress); a plan with
  `"keepalive": false` starts off. A real `unpause` (or a `resume` that leaves a pause) starts the count over; on a run
  that was not paused they change nothing, so a model that answers the message with them cannot loop it.
- Codex (the CLI alone) has no keepalive: the loop depends on the model.

### Transient failures

A subagent (or the orchestrator) that dies on a failure of the provider that clears by itself does not give its task
back: the host pauses the run (`run.json`'s `pause`, `log.jsonl`'s `auto-pause`) and keeps every task in progress with
its locks and claims (the host keeps renewing them while it lives). Transient: a rate limit, a usage, session or
weekly limit, a quota or credit (`429`, `402`, `insufficient_quota`, `usage limit`, `session limit`), an overloaded
or failing server (`529`, `503`, `5xx`, `overloaded`), the connection (`ECONNRESET`, `ETIMEDOUT`, `fetch failed`,
`socket hang up`), a timeout, the provider's retries running out. Not transient, and handled as before: an invalid
key or login, a refusal or content filter, a context that overflows, an output cap, a model that does not exist, a
bug. The classifier is the core's (`src/transient.ts`), a table of kinds and patterns tested with real samples of
Claude Code, opencode/zen, OpenRouter (the upstream's error inside the body), Anthropic, OpenAI, Moonshot/Kimi and
OpenAI-compatible servers.

- Claude Code: `turn.complete` with `reason: "error"` carries no text, so the mod keeps each loop's classic
  `StopFailure` (`error`, the kind Claude Code gave it; `error_details`; `last_assistant_message`, the error as shown;
  `agent_id` inside a subagent). A StopFailure that comes after its loop's end still pauses the run. The subagent's
  place stays in the mod (its guard still knows the task), and a second subagent for the task is refused.
- OpenCode: `session.execution.failed` (the structured error: `type`, `status`, `response.body`, `retryAfterMs`), the
  retry status (`session.status` `retry`, `session.retry.scheduled`) and v1's `session.error` (`APIError` with
  `statusCode` and `isRetryable`). A child session that failed this way and goes idle keeps its task.
- The reset: the time the error gave (`resets 12:50am`, `resets Oct 27, 9am (Europe/Lisbon)`, `try again in 2s`,
  `retry-after`, `x-ratelimit-reset`, `anthropic-ratelimit-unified-reset`, an epoch in the text or in OpenRouter's
  echoed headers, `retryAfterMs`). The host resumes the run by itself 30 s after it (`pause.resumeAt`); with no reset
  given, after 5 minutes, doubling at each new pause at the same progress, up to an hour; after three automatic
  resumes in a row with no progress, only `jtasks unpause` resumes it. Claude Code's own `quota_auto_resume_fired`
  notification (it went on after a usage limit) resumes it at once.
- The way back (`unpause`, the clock, the reset): the run is active, the tasks kept in progress take back any lock
  that expired meanwhile, and the orchestrator reads which agent to resume for each task (Claude Code:
  `SendMessage` to the agent id; OpenCode: the subagent tool's `task_id`), not to open a new one, not to call `start`
  again. A `resume` from another session after such a pause also takes the locks back instead of releasing the task.
- While it lasts, the keepalive stays quiet (no "run is idle", no give-up), `jtasks status` shows the failure, what it
  kept and when it ends, the pane or sidebar says the same, and the protocol tells the orchestrator to wait. A
  `pause` by hand over it keeps the tasks but stops the automatic resume.

## Demonstration and tests

```
bun scripts/demo.ts            # the whole flow in a temporary repository, with its own jlock and ledger homes
bun test                       # core and CLI (real git and jlock in temporary folders under D:\claude-cache)
cd opencode && bun test        # the OpenCode plugin (a fake host, a scripted model)
claude plugin test claude      # the Claude Code mod (a fake machine; the real run is in docs/evidence/mod-herdr-2026-10-24.md)
bun run typecheck              # core, CLI, tests and mod
```

No test calls a model.
