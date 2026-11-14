# Changelog

What changed in each release that a user or an integrator notices. Earlier releases are described in
[`docs/DEVIATIONS.md`](docs/DEVIATIONS.md) and the history of `CLAUDE.md`.

## 0.8.3

- A process a task declared (`jtasks wait --pid`, `jtasks exec --task`) keeps its wait for as long as it lives, whatever
  the host says about the agent. Before, when Claude Code stopped reporting the agent as waiting (a Monitor expires
  after 30 minutes), the orchestrator was told "the process ended" with the process alive and, after `awaitGrace`,
  the task went back to the queue.
- A look at a process that fails or times out is no longer taken as its end: the wait is looked at again on the next
  pass (and `release --agent-ended` waits for such a pid like a live one, logged under `unknown`). A `ps` stopped at
  its deadline counts as such a look.
- Known and not fixed: background work Claude Code starts by itself (a foreground command it moves to the background,
  a Monitor) is known to the mod only through the agent's status at the end of its turn, which is sometimes missed.

## 0.8.2

- Force recognized OpenCode task delegations into background mode, including omitted/false values, correct
  profile agents and markerless same-child resumptions. Leave unrelated delegations alone and reject task
  launches while their run is paused. Preserve same-child duplicate protections.
- Treat background launch acknowledgment as admission, not completion or orphaned work, before the child starts.
- Pass the child tool invocation's AbortSignal through exec to native process-tree cleanup. Scope cancellation
  to that command, clear its deadline and unregister its supervisor without releasing other tasks' ownership.
- Add failing-before regressions, disposable native descendant tests, and an opt-in real OpenCode acceptance
  using a loopback scripted provider without paid model calls.

## 0.8.1

- Restore the full original OpenCode profile in the optional Windows launcher. The isolated profile hid native
  v2 provider credentials, model preferences and conversation history.
- Reuse the original service without changing its configuration, copying OAuth credentials, restarting it or
  releasing task locks. Existing services retain their loaded plugin version until a separate safe update.
- Reject separate-server flags and ambiguous configuration overrides. Add native PowerShell regression checks
  for original settings, storage roots, read-only preflight and exit-code propagation.
- Keep test/demo/README fixtures under JTASKS_TEST_TMP or the system temporary directory, without fixed drive paths.

## 0.8.0

Requires **jlock 0.4.2**. Compatible with existing 0.7 task events and the jlock 0.3 registry.
Keep active installations intact and select the new versions only for new sessions.

- Route every `exec` through jlock native process custody, including serialized commands and all three hosts.
- Bound the complete exec, including the lock queue. Report timeout as 124 and `data.timedOut`, preserving task
  ownership, edits and historical recovery behavior. Never automatically retry or release a task on timeout.
- Bound Node/Bun output memory to the last 1 Mi characters per stream, without stopping pipe drainage.
- Add deterministic regression coverage for shell descendants, serialization, cleanup and preserved task state.
- Respect the Claude process API's 600-second cap, reserving cleanup time with a 585-second exec default and limit.
- Provide an optional Windows OpenCode v2 launcher with private storage and both plugin entrypoints, preserving live installations.

## 0.7.0

Needs **jlock 0.3.0** or newer (`jtasks doctor` fails on an older one). Runs and locks of 0.6 are not read: let every
run finish, then install jlock 0.3 and jtasks 0.7.0 together (CLI, Claude Code mod, OpenCode plugin).

### Added

- **`uses`** in a task: the jlock resources it holds while in progress besides its files (`"desktop"`,
  `"clipboard"`, `"browser"`, `"audio"`, `"gpu"`, `"network"`, `"machine"`, `"port:<n>"`, or the user's own from
  jlock's `resources.json`), as names or `{ "resource": "gpu", "mode": "shared" }`. Tasks of any run on the machine
  take turns on an exclusive resource. `validate` and `plan` check the names against `jlock resources` and refuse an
  unknown one with the closest name.
- **`exclusive: "project" | "machine"`**: `"project"` (or `true`) holds the repository root exclusively; `"machine"`
  also holds `resource:machine` exclusively, so it waits for every running jtasks task on the machine and no new one
  starts meanwhile. Every task holds `resource:machine` shared.
- `next` and `status` name a resource that blocks a task with its holder, the mode and jlock's description
  (`🔒 other-run/T02: resource:desktop (held exclusive: the real mouse, keyboard and windows…)`); `status` lists each
  hold of the run with `(shared)` or `(nested)`; tickets show **Uses:** and the exclusive scope; `next --json` carries
  `exclusive` as the scope and `uses`.
- `validate` warnings: two independent tasks using one resource exclusively (they run one at a time), and a task whose
  text mentions the mouse or keyboard, the clipboard, a fixed port or measurements without declaring it.

### Changed

- An exclusive task never holds `*` any more: it no longer blocks, or waits for, unrelated projects' locks.
- Owners are hierarchical (jlock 0.3): what runs on behalf of a task holds keys as its child
  (`gt:<run>/<task>/exec-<id>` for `jtasks exec`, `gt:<run>/<task>/tree-<id>` for the run's tree key), so an exec of a
  serialized command inside an exclusive task runs at once instead of waiting for a key its own task held (it
  deadlocked). Two execs of one task still serialize. The workaround that held the tree key under the exclusive task's
  owner is gone.
- The frontier, the views and the keepalive read the whole machine's `jlock list` (resources are machine-wide), and
  count a task's keys by its own holds among jlock 0.3's `holders`.
- A task always holds at least one key (`resource:machine`), so `start` reports one key more than its files.
