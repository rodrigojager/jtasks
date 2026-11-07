# jtasks skills for AI agents

Two skills teach an AI coding agent to use jtasks:

- **`to-jtasks`** turns a plan, a spec or the conversation into tasks, each with the tasks that block it and the
  files it owns, and hands them to the `jtasks` tool in batches (the tool validates them and writes the run). It
  writes the run's shared **context** once (a summary, the plan files and ADRs to read first, the standing
  constraints); the tool renders it into the `## Context` section of every ticket, because the agent that runs a
  task starts with a fresh context and the ticket is its whole brief.
- **`jtasks`** carries a run out: `jtasks next`, one task per agent (in parallel when the host has subagents),
  `jtasks start`, work inside the ownership, `jtasks claim` for one more file, `jtasks done` with evidence, and
  `jtasks status` until nothing is left; what to do on a timeout, a deadlock or a lost lock; with or without `/goal`.
  Each task agent starts fresh and is pointed at its ticket: in Claude Code the `Agent` tool (the `jtasks:execute`
  agents), in OpenCode a new subagent session, in Codex `spawn_agent` with `fork_turns="none"` and a message whose
  first line is exactly `jtasks-task: <run-id> <task-id>` (a local hook may key on that line, so the format is fixed).

With the Claude Code mod or the OpenCode plugin installed, the execution protocol comes injected into the prompt and
`jtasks` is a reference; without them (a terminal, Codex), it is the protocol. The three versions of each skill
say the same thing; each one calls the tool the way its host does.

| Agent | Skills | Installed for the user at | Or for one project at |
|---|---|---|---|
| Claude Code | [`claude-code/to-jtasks`](claude-code/to-jtasks/SKILL.md), [`claude-code/jtasks`](claude-code/jtasks/SKILL.md) | `~/.claude/skills/<skill>/` | `.claude/skills/<skill>/` |
| OpenCode | [`opencode/to-jtasks`](opencode/to-jtasks/SKILL.md), [`opencode/jtasks`](opencode/jtasks/SKILL.md) | `~/.config/opencode/skills/<skill>/` | `.opencode/skills/<skill>/` |
| Codex | [`codex/to-jtasks`](codex/to-jtasks/SKILL.md), [`codex/jtasks`](codex/jtasks/SKILL.md) | `~/.codex/skills/<skill>/` | `.agents/skills/<skill>/` |

The Claude Code mod already carries both skills (`claude/skills/`), as `jtasks:jtasks` and `jtasks:to-jtasks`: with
the mod installed, do not copy them to `~/.claude/skills` too. Codex gets `~/.codex/skills` rather than
`~/.agents/skills` because OpenCode also reads `~/.agents/skills` and would see the Codex build next to its own.
jtasks itself and jlock have to be installed first (see [`docs/USAGE.md`](../docs/USAGE.md)).

## Install with one command

`jtasks doctor --fix --yes` installs both skills for the three agents (and records each file in the ledger, so
`jtasks undo` removes them). By hand, Linux and macOS:

```
# Claude Code
for s in to-jtasks jtasks; do mkdir -p ~/.claude/skills/$s && for f in SKILL.md schema.json example-plan.json; do curl -fsSL https://raw.githubusercontent.com/rodrigojager/jtasks/main/skills/claude-code/$s/$f -o ~/.claude/skills/$s/$f 2>/dev/null; done; done
# OpenCode
for s in to-jtasks jtasks; do mkdir -p ~/.config/opencode/skills/$s && for f in SKILL.md schema.json example-plan.json; do curl -fsSL https://raw.githubusercontent.com/rodrigojager/jtasks/main/skills/opencode/$s/$f -o ~/.config/opencode/skills/$s/$f 2>/dev/null; done; done
# Codex
for s in to-jtasks jtasks; do mkdir -p ~/.codex/skills/$s && for f in SKILL.md schema.json example-plan.json; do curl -fsSL https://raw.githubusercontent.com/rodrigojager/jtasks/main/skills/codex/$s/$f -o ~/.codex/skills/$s/$f 2>/dev/null; done; done
```

Windows (PowerShell):

```
# Claude Code
foreach ($s in 'to-jtasks','jtasks') { New-Item -ItemType Directory -Force "$HOME\.claude\skills\$s" | Out-Null; foreach ($f in 'SKILL.md','schema.json','example-plan.json') { try { irm "https://raw.githubusercontent.com/rodrigojager/jtasks/main/skills/claude-code/$s/$f" -OutFile "$HOME\.claude\skills\$s\$f" } catch {} } }
# OpenCode
foreach ($s in 'to-jtasks','jtasks') { New-Item -ItemType Directory -Force "$HOME\.config\opencode\skills\$s" | Out-Null; foreach ($f in 'SKILL.md','schema.json','example-plan.json') { try { irm "https://raw.githubusercontent.com/rodrigojager/jtasks/main/skills/opencode/$s/$f" -OutFile "$HOME\.config\opencode\skills\$s\$f" } catch {} } }
# Codex
foreach ($s in 'to-jtasks','jtasks') { New-Item -ItemType Directory -Force "$HOME\.codex\skills\$s" | Out-Null; foreach ($f in 'SKILL.md','schema.json','example-plan.json') { try { irm "https://raw.githubusercontent.com/rodrigojager/jtasks/main/skills/codex/$s/$f" -OutFile "$HOME\.codex\skills\$s\$f" } catch {} } }
```

(`jtasks` has only `SKILL.md`; the two JSON files belong to `to-jtasks`, which reads them beside it.)

For a single project, put the same folders under the project path from the table instead, and commit them, so every
agent working on the repository gets them. From a clone, copying works too: `cp -r skills/claude-code/* ~/.claude/skills/`.
Start a new session of the agent afterwards: skills are read when a session starts.

## Updating

Run the same command again (or `jtasks doctor --fix --yes`): it replaces the files with the current ones.

## Editing the skills

The six folders are generated: edit `skills/source/<skill>/` (one text, with `{{…}}` where the hosts differ; the
host texts are in `scripts/build.ts`, `HOSTS`) and run `bun scripts/build.ts`. `bun scripts/build.ts --check` and
`test/skills.test.ts` fail when a generated copy is stale or the versions drift apart.
