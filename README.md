# goal-tasks

A deterministic task list with dependencies and parallelism for coding agents: tasks are planned once, each one
declares the files it owns, agents run in parallel on the same checkout, and a tool (not the model) enforces
ownership, records every transition and commits one task at a time. Progress and a checklist show up inside
Claude Code (as a mod) and OpenCode (as a plugin), and both work with `/goal`.

File ownership is enforced by [jlock](https://github.com/rodrigojager/jlock), a machine-wide lock CLI with a fair
queue, heartbeat recovery and deadlock detection, developed first as the prerequisite of this project.

```
$ tasks next
prontas (2) em demo-261024-ubv5; podem rodar em paralelo:
T01 · Núcleo · perfil impl · posse: src/core.ts
T02 · Tela · perfil impl · posse: src/ui
$ tasks done T01 --evidence "core.ts exporta soma"
T01 feita: commit b510db2 (T01: Núcleo); posse devolvida
feitas 1/3 (33%) · 1 em andamento · restam 2
```

Status: the core, the CLI and the ledger, the OpenCode plugin (`opencode/`), the Claude Code mod (`claude/`), the
`to-tickets` skill (`skills/`) and `gc --scan` are implemented (items 2 to 6 of the plan's delivery order);
per-task worktrees and the Codex/pi/ralph front ends (items 7 and 8) are not. Windows first.

- How to use it: [`docs/USAGE.md`](docs/USAGE.md)
- The design (Portuguese): [`docs/PLAN.md`](docs/PLAN.md); what came out differently: [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md)
- The end-to-end demonstration: `bun scripts/demo.ts`
