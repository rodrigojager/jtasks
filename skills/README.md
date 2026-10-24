# goal-tasks skills for AI agents

Two skills teach an AI coding agent to use goal-tasks:

- **`to-tickets`** turns a plan, a spec or the conversation into tasks, each with the tasks that block it and the
  files it owns, and hands them to the `tasks` tool in batches (the tool validates them and writes the run).
- **`goal-tasks`** carries a run out: `tasks next`, one task per agent (in parallel when the host has subagents),
  `tasks start`, work inside the ownership, `tasks claim` for one more file, `tasks done` with evidence, and
  `tasks status` until nothing is left; what to do on a timeout, a deadlock or a lost lock; with or without `/goal`.

With the Claude Code mod or the OpenCode plugin installed, the execution protocol comes injected into the prompt and
`goal-tasks` is a reference; without them (a terminal, Codex), it is the protocol. The three versions of each skill
say the same thing; each one calls the tool the way its host does.

| Agent | Skills | Installed for the user at | Or for one project at |
|---|---|---|---|
| Claude Code | [`claude-code/to-tickets`](claude-code/to-tickets/SKILL.md), [`claude-code/goal-tasks`](claude-code/goal-tasks/SKILL.md) | `~/.claude/skills/<skill>/` | `.claude/skills/<skill>/` |
| OpenCode | [`opencode/to-tickets`](opencode/to-tickets/SKILL.md), [`opencode/goal-tasks`](opencode/goal-tasks/SKILL.md) | `~/.config/opencode/skills/<skill>/` | `.opencode/skills/<skill>/` |
| Codex | [`codex/to-tickets`](codex/to-tickets/SKILL.md), [`codex/goal-tasks`](codex/goal-tasks/SKILL.md) | `~/.agents/skills/<skill>/` | `.agents/skills/<skill>/` |

The Claude Code mod already carries both skills (`claude/skills/`). goal-tasks itself and jlock have to be installed
first (see [`docs/USAGE.md`](../docs/USAGE.md)).

## Install with one command

`tasks doctor --fix --yes` installs both skills for the three agents (and records each file in the ledger, so
`tasks undo` removes them). By hand, Linux and macOS:

```
# Claude Code
for s in to-tickets goal-tasks; do mkdir -p ~/.claude/skills/$s && for f in SKILL.md schema.json example-plan.json; do curl -fsSL https://raw.githubusercontent.com/rodrigojager/goal-tasks/main/skills/claude-code/$s/$f -o ~/.claude/skills/$s/$f 2>/dev/null; done; done
# OpenCode
for s in to-tickets goal-tasks; do mkdir -p ~/.config/opencode/skills/$s && for f in SKILL.md schema.json example-plan.json; do curl -fsSL https://raw.githubusercontent.com/rodrigojager/goal-tasks/main/skills/opencode/$s/$f -o ~/.config/opencode/skills/$s/$f 2>/dev/null; done; done
# Codex
for s in to-tickets goal-tasks; do mkdir -p ~/.agents/skills/$s && for f in SKILL.md schema.json example-plan.json; do curl -fsSL https://raw.githubusercontent.com/rodrigojager/goal-tasks/main/skills/codex/$s/$f -o ~/.agents/skills/$s/$f 2>/dev/null; done; done
```

Windows (PowerShell):

```
# Claude Code
foreach ($s in 'to-tickets','goal-tasks') { New-Item -ItemType Directory -Force "$HOME\.claude\skills\$s" | Out-Null; foreach ($f in 'SKILL.md','schema.json','example-plan.json') { try { irm "https://raw.githubusercontent.com/rodrigojager/goal-tasks/main/skills/claude-code/$s/$f" -OutFile "$HOME\.claude\skills\$s\$f" } catch {} } }
# OpenCode
foreach ($s in 'to-tickets','goal-tasks') { New-Item -ItemType Directory -Force "$HOME\.config\opencode\skills\$s" | Out-Null; foreach ($f in 'SKILL.md','schema.json','example-plan.json') { try { irm "https://raw.githubusercontent.com/rodrigojager/goal-tasks/main/skills/opencode/$s/$f" -OutFile "$HOME\.config\opencode\skills\$s\$f" } catch {} } }
# Codex
foreach ($s in 'to-tickets','goal-tasks') { New-Item -ItemType Directory -Force "$HOME\.agents\skills\$s" | Out-Null; foreach ($f in 'SKILL.md','schema.json','example-plan.json') { try { irm "https://raw.githubusercontent.com/rodrigojager/goal-tasks/main/skills/codex/$s/$f" -OutFile "$HOME\.agents\skills\$s\$f" } catch {} } }
```

(`goal-tasks` has only `SKILL.md`; the two JSON files belong to `to-tickets`, which reads them beside it.)

For a single project, put the same folders under the project path from the table instead, and commit them, so every
agent working on the repository gets them. From a clone, copying works too: `cp -r skills/claude-code/* ~/.claude/skills/`.
Start a new session of the agent afterwards: skills are read when a session starts.

## Updating

Run the same command again (or `tasks doctor --fix --yes`): it replaces the files with the current ones.

## Editing the skills

The six folders are generated: edit `skills/source/<skill>/` (one text, with `{{…}}` where the hosts differ; the
host texts are in `scripts/build.ts`, `HOSTS`) and run `bun scripts/build.ts`. `bun scripts/build.ts --check` and
`test/skills.test.ts` fail when a generated copy is stale or the versions drift apart.
