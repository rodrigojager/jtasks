# goal-tasks

A deterministic task list with dependencies and parallelism for coding agents: tasks are planned once, each one
declares the files it owns, agents run in parallel on the same checkout, and a tool (not the model) enforces
ownership, records every transition and commits one task at a time. Progress and a checklist show up inside
Claude Code (as a mod) and OpenCode (as a plugin), and both work with `/goal`.

File ownership is enforced by [jlock](https://github.com/rodrigojager/jlock), a machine-wide lock CLI with a fair
queue, heartbeat recovery and deadlock detection, developed first as the prerequisite of this project.

Status: planning. The full design (Portuguese) is in [`docs/PLAN.md`](docs/PLAN.md). Nothing is implemented yet.
