// jtasks for Claude Code: the `jtasks` tool (the core's runTool on a host made of $.fs and $.process), the run
// bound to the session in $.state (subagents share it), the protocol section in the system prompt while a run is
// bound (prompt.compose runs at every request, so it is back after a compaction too), and the "Tasks" pane with
// /jtasks (Claude Code ships its own /tasks), refreshed every 2 s while open; and the keepalive: at the end of the
// main loop's turn, with ready tasks and no subagent alive, a message that reopens the loop (./keepalive.ts); and
// the holds of this session's tasks in progress renewed before the run's holdTtl expires them (core's renew.ts); and
// a loop that dies on a transient failure of the API pauses the run with its task kept (./transient.ts, rev. 5.7); and
// a subagent whose loop ends while its process runs leaves its task waiting for it, not given back, and every
// transition the orchestrator did not ask for is sent to it at once, with the status line, which also rides along
// every notification of a subagent's end (./alerts.ts, rev. 5.8).

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { awaitBack, deliveryLabel, ensureJlock, parseArgs, pauseForFailure, type Classification, pauseNotice, readBrief, readRun, readTasks, renewRun, RENEW_EVERY_MS, resumeIfDue, resumeNow, runDir, runTool, select, splitCommand, systemLocale, tr, type Resident, type ToolContext, type ToolResult } from '../core/core.js'
import { createModHost, type Port } from './mod-host.ts'
import { AlertWatch } from './alerts.ts'
import { serializedCommand, spawnDecision } from './agents.ts'
import { judgeCall, type GuardedCall } from './guard.ts'
import { Keepalive } from './keepalive.ts'
import { FailureWatch, STOP_FAILURE_WAIT_MS } from './transient.ts'
import { BAR_COLOR, computeView, hudBar, isLive, paneLines, paneRows, PANE, PANE_TITLE, ROW_MARK, ROW_MARK_COLOR, SPINNER_FRAMES, TRACK_COLOR } from './pane.tsx'
import type { AgentTask, PaneView } from '../types'
import { protocolSection, SECTION_ID, TOOL_DESCRIPTION, TOOL_NAME, TOOL_SCHEMA } from './protocol.ts'

const RUN = { plugin: 'jtasks', key: 'run' } as const
// Change the tag when the view's fields change: it declines what an earlier version stored.
const viewAtom = atom({ plugin: 'jtasks', key: 'view' } as const, null as PaneView | null, { shape: 'view-2' })
const collapsedAtom = atom({ plugin: 'jtasks', key: 'collapsed' } as const, false)
const AGENTS = { plugin: 'jtasks', key: 'agents' } as const
const FULL_NAME = 'mcp__jtasks__jtasks'
/** The tag on the rows of the messages the mod sends the orchestrator: not the person's words, not the model's. */
const TAG_COLOR = 'suggestion'

/** Actions that may name another run than the bound one (they create, bind or only list). */
const ANY_RUN = new Set(['plan', 'resume', 'import', 'runs', 'ledger', 'gc', 'help', 'version', 'validate', 'clean', 'archive', 'undo'])

/** Residents this session keeps (none for holds: the mod uses `jlock hold --detach`, so a reload loses nothing). */
const residents = new Map<string, Resident[]>()

/** Set at session.start: the closures over $ the rest of the module works through. */
let port: Port | undefined
/** Set at session.start: recomputes the pane's view now (a closure over that hook's $). */
let refresh: ((force: boolean) => Promise<void>) | undefined
/** Set at session.start: reopens the loop when the orchestrator stops with ready tasks (a closure over that hook's $). */
let keepalive: Keepalive | undefined
/** Set at session.start: the StopFailures of each loop, classified at the loop's end (rev. 5.7). */
let failures: FailureWatch | undefined
/** Set at session.start: tells the person the run was paused by a transient failure, and clears it. */
let tell: { paused(notice: string): void; clear(): void } | undefined
/** Set at session.start: the run's transitions the orchestrator did not ask for, and the tasks waiting for a process (rev. 5.8). */
let alerts: AlertWatch | undefined
/** The status line shows a transient pause. */
let pauseShown = false
let paneOpen = false
let spinnerFrame = 0

function needPort(): Port {
  if (!port) throw new Error(tr('mod.no_session'))
  return port
}

const TASK_END = new Set(['done', 'skip', 'fail', 'release'])

/** The context of a call of the core for the bound run, as the session (not one of its subagents). */
async function sessionCtx(p: Port, run: string): Promise<ToolContext> {
  const cwd = await p.cwd()
  return { host: createModHost(p, cwd), cwd, tool: 'claude', session: await p.sessionId(), residents, holdMode: 'detach', boundRun: run }
}

/** Runs one command of the tool for the session (or for one of its subagents). */
export async function callTool(p: Port, command: string, json: unknown, agentId?: string): Promise<ToolResult> {
  const argv = splitCommand(command.replace(/^\s*tasks\s+/, ''))
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    return { ok: false, code: 2, text: (error as Error).message }
  }
  const bound = await p.getRun()
  const asked = typeof parsed.options.run === 'string' ? parsed.options.run : undefined
  if (bound && asked && asked !== bound.run && !ANY_RUN.has(parsed.action))
    return { ok: false, code: 1, text: tr('binding.other_run', { run: bound.run, asked }) }
  const cwd = await p.cwd()
  const ctx: ToolContext = { host: createModHost(p, cwd), cwd, tool: 'claude', session: await p.sessionId(), residents, holdMode: 'detach' }
  if (bound) ctx.boundRun = bound.run
  if (agentId) ctx.agent = agentId
  if (json !== undefined) ctx.json = json
  const result = await runTool(ctx, argv)
  const id = parsed.positionals[0]
  if (agentId && result.ok && id && (bound || result.bind)) {
    const agents = await p.getAgents()
    if (parsed.action === 'start' || parsed.action === 'claim') await p.setAgents({ ...agents, [agentId]: { ...agents[agentId], run: result.bind ?? bound!.run, task: id } })
  }
  // A task that ended (or was given back) no longer waits for the subagent a transient pause kept for it.
  if (result.ok && id && TASK_END.has(parsed.action)) {
    const agents = await p.getAgents()
    if (Object.values(agents).some((a) => a.paused && a.task === id))
      await p.setAgents(Object.fromEntries(Object.entries(agents).filter(([, a]) => !(a.paused && a.task === id))))
  }
  if (result.ok && result.bind) {
    const dir = (result.data as { dir?: string } | undefined)?.dir?.replace(/\\/g, '/')
    const root = dir ? dir.replace(/\/\.scratch\/jtasks\/runs\/[^/]+$/, '') : (bound?.root ?? cwd)
    await p.setRun({ run: result.bind, root })
    // The alerts of a run start where its log is now (rev. 5.8).
    await alerts?.start({ run: result.bind, root }).catch(() => undefined)
  }
  return result
}

/** A text the tool's command line keeps whole: one double-quoted word, without what would end it. */
function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`
}

/**
 * The end of a task's subagent loop (rev. 5.8): `release --agent-ended`, with `--waiting` when Claude Code says the
 * agent waits on background work it owns, or it started commands in the background this turn. The core keeps the task
 * waiting for its process (then the agent keeps its place here), or gives it back. Answers the outcome.
 */
async function endOfAgent(p: Port, agentId: string, mine: AgentTask, status: string | undefined): Promise<string | undefined> {
  const background = mine.background ?? []
  const waiting =
    status === 'waiting' || background.length
      ? background.length
        ? `background: ${background.join(' | ')}`
        : 'Claude Code: the agent waits on background work it owns'
      : undefined
  const result = await callTool(p, `release ${mine.task} --agent-ended${waiting ? ` --waiting ${quoted(waiting.slice(0, 300))}` : ''}`, undefined, agentId).catch(() => undefined)
  const outcome = (result?.data as { outcome?: string } | undefined)?.outcome
  const agents = await p.getAgents()
  const { [agentId]: _gone, ...rest } = agents
  if (outcome === 'awaiting') await p.setAgents({ ...rest, [agentId]: { ...mine, awaiting: true, background: [] } })
  else await p.setAgents(rest)
  return outcome
}

let renewing = false

/** One pass over the bound run: the holds of the tasks this session (or one of its subagents) started. */
export async function renewHolds(p: Port): Promise<void> {
  const bound = await p.getRun()
  if (!bound || renewing) return
  renewing = true
  try {
    const cwd = await p.cwd()
    const session = await p.sessionId()
    const ctx: ToolContext = { host: createModHost(p, cwd), cwd, tool: 'claude', session, residents, holdMode: 'detach', boundRun: bound.run }
    const actor = `claude:${session}`
    await renewRun(ctx, bound.run, (owner) => owner === actor || owner.startsWith(`${actor}/`))
  } finally {
    renewing = false
  }
}

/**
 * The end of a loop on an API error (rev. 5.7): a transient failure pauses the run, with the task of the subagent
 * (`mine`) kept in progress. Answers the notice for the person when it paused (then the caller keeps the subagent's
 * place), or undefined (the error goes on as before).
 */
export async function pauseOnFailure(p: Port, agentId: string | undefined, answer: string, last: () => Promise<string | undefined>, mine?: AgentTask): Promise<string | undefined> {
  if (!failures) return undefined
  const failure = await failures.classify(agentId, answer, last, agentId === undefined ? 0 : STOP_FAILURE_WAIT_MS)
  return pauseFor(p, failure, agentId, mine)
}

/** Pauses the bound run for a classified failure (only a transient one); the notice for the person, or undefined. */
async function pauseFor(p: Port, failure: Classification, agentId: string | undefined, mine?: AgentTask): Promise<string | undefined> {
  const bound = await p.getRun()
  if (!bound || !failure.transient || (mine && mine.run !== bound.run)) return undefined
  const ctx = await sessionCtx(p, bound.run)
  if (mine) {
    // Only a task still in progress is worth keeping; one the subagent finished already goes on as before.
    const tasks = await readTasks(ctx.host, runDir(bound.root, bound.run)).catch(() => undefined)
    if (tasks?.tasks.find((t) => t.id === mine.task)?.status !== 'in_progress') return undefined
  }
  const pause = await pauseForFailure(ctx, { run: bound.run, failure, ...(mine ? { task: mine.task } : {}), ...(agentId ? { agent: agentId } : {}) })
  return pause ? pauseNotice(bound.run, pause, ctx.host.now()) : undefined
}

/**
 * The clock (`resumeAt` has come) and Claude Code's own reset (`how`): leaves a transient pause, and the orchestrator
 * is told to resume the same agents.
 */
async function leaveTransientPause(p: Port, how?: string): Promise<void> {
  const bound = await p.getRun()
  if (!bound) return
  const ctx = await sessionCtx(p, bound.run)
  // Cheap first: run.json alone (no git, no jlock) every two seconds.
  const run = await readRun(ctx.host, runDir(bound.root, bound.run)).catch(() => undefined)
  if (pauseShown && !(run?.status === 'paused' && run.pause)) {
    pauseShown = false
    tell?.clear()
  }
  if (run?.status !== 'paused' || !run.pause?.resumeAt) return
  if (!how && Date.parse(run.pause.resumeAt) > ctx.host.now().getTime()) return
  const left = how ? await resumeNow(ctx, bound.run, how) : await resumeIfDue(ctx, bound.run)
  if (!left) return
  if (pauseShown) {
    pauseShown = false
    tell?.clear()
  }
  keepalive?.deliver(left.text)
  await refresh?.(true).catch(() => undefined)
}

/** The status line attached to a notification (English frame, the tool's words inside). */
export function statusContext(run: string, brief: string): string {
  return `jtasks status of run ${run}, read now from tasks.json: ${brief}`
}

async function lastMessage(read: () => Promise<readonly { role: string; text: string }[] | { deny: string }>): Promise<string | undefined> {
  const messages = await read()
  return Array.isArray(messages) ? messages.filter((m) => m.role === 'assistant').at(-1)?.text : undefined
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    port = {
      read: async (path) => (await $.fs.read(path)) as string,
      write: (path, text) => $.fs.write(path, text),
      list: (path) => $.fs.list(path),
      stat: (path) => $.fs.stat(path),
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request) as never,
      sleep: (ms) => $.clock.sleep(ms),
      getRun: async () => (await $.state.get(RUN)).value ?? null,
      setRun: async (run) => void (await $.state.set(RUN, run)),
      getAgents: async () => (await $.state.get(AGENTS)).value ?? {},
      setAgents: async (agents) => void (await $.state.set(AGENTS, agents)),
      sessionId: () => $.session.id(),
      cwd: () => $.session.cwd(),
      env: {
        JTASKS_HOME: await $.env.get('JTASKS_HOME'),
        USERPROFILE: await $.env.get('USERPROFILE'),
        HOME: await $.env.get('HOME'),
        JLOCK_BIN: await $.env.get('JLOCK_BIN'),
        JLOCK_INSTALL_DIR: await $.env.get('JLOCK_INSTALL_DIR'),
        LOCALAPPDATA: await $.env.get('LOCALAPPDATA'),
        JTASKS_NO_JLOCK_INSTALL: await $.env.get('JTASKS_NO_JLOCK_INSTALL'),
        JTASKS_LANG: await $.env.get('JTASKS_LANG'),
        JLOCK_LANG: await $.env.get('JLOCK_LANG'),
        JTASKS_KEEPALIVE_TRIES: await $.env.get('JTASKS_KEEPALIVE_TRIES'),
      },
    }
    keepalive = new Keepalive(
      port,
      {
        agents: async () => (await $.agent.list()).map((a) => ({ status: a.status })),
        draft: async () => (await $.prompt.read()).text,
        submit: (text) => $.prompt.submit({ text }),
        // The status line carries the plugin's name already; the toast and the notification do not.
        stalled: (notice) => {
          $.ui.toast(`jtasks: ${notice}`, { timeoutMs: 15000 })
          $.ui.status(notice)
          void $.ui.notify(`jtasks: ${notice}`).catch(() => undefined)
          void refresh?.(true).catch(() => undefined)
        },
        clear: () => $.ui.status(undefined),
      },
      e.isInteractive,
    )
    await keepalive.restore((text) => $.ui.status(text)).catch(() => undefined)
    // What the run does without the orchestrator asking goes to it at once, and to the person (rev. 5.8).
    alerts = new AlertWatch(port, {
      deliver: (text) => keepalive?.deliver(text),
      tell: (notice) => {
        $.ui.toast(`jtasks: ${notice}`, { timeoutMs: 15000 })
        void $.ui.notify(`jtasks: ${notice}`).catch(() => undefined)
        void refresh?.(true).catch(() => undefined)
      },
      agents: async () => (await $.agent.list()).map((a) => ({ id: a.id, status: a.status })),
      ctx: (run) => sessionCtx(needPort(), run),
    })
    await alerts.start().catch(() => undefined)
    // A StopFailure after its loop's end (the end went on as an ordinary error): a transient one still pauses the
    // run, so nothing else is started into the same limit; a subagent's task already given back stays so.
    failures = new FailureWatch(
      (ms) => $.clock.sleep(ms),
      () => new Date(),
      (agentId, failure) => {
        const p = port
        if (!p || !failure.transient) return
        void (async () => {
          const mine = agentId ? (await p.getAgents())[agentId] : undefined
          const notice = await pauseFor(p, failure, agentId, mine)
          if (!notice) return
          if (agentId && mine) await p.setAgents({ ...(await p.getAgents()), [agentId]: { ...mine, paused: true } })
          tell?.paused(notice)
          await refresh?.(true).catch(() => undefined)
        })().catch(() => undefined)
      },
    )
    tell = {
      paused: (notice) => {
        pauseShown = true
        $.ui.toast(`jtasks: ${notice}`, { timeoutMs: 15000 })
        $.ui.status(notice)
        void $.ui.notify(`jtasks: ${notice}`).catch(() => undefined)
      },
      clear: () => $.ui.status(undefined),
    }
    // The session's language (plan section 21): what the pane and the tool's answers speak until a --lang.
    const env = port.env
    select({ env: (name) => env[name as keyof typeof env] ?? undefined, system: systemLocale() })
    // jlock comes with jtasks: a missing one is installed in the background (the first tool call tells the user).
    void ensureJlock(createModHost(port, await port.cwd())).catch(() => undefined)
    await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    // A /jtasks of the person's own (the skill `jtasks doctor --fix` puts in ~/.claude/skills) refuses the
    // registration; the command.run hook below still answers /jtasks, so the pane's refresh is set up anyway.
    await $.command.register({ name: 'jtasks', description: tr('mod.command') }).catch(() => undefined)

    const stored = await $.store.get('collapsed')
    if (typeof stored === 'boolean') await update($, collapsedAtom, () => stored)
    let signature = ''
    refresh = async (force) => {
      const p = port
      if (!p || !paneOpen) return
      const bound = await p.getRun()
      const files = bound ? [`${bound.root}/.scratch/jtasks/runs/${bound.run}/tasks.json`, `${bound.root}/.scratch/jtasks/runs/${bound.run}/run.json`] : []
      const stats = await Promise.all(files.map((f) => p.stat(f).then((x) => x.mtimeMs, () => 0)))
      const current = `${bound?.run ?? ''}:${stats.join(',')}`
      if (!force && current === signature && !isLive(await read($, viewAtom))) return
      signature = current
      const view = await computeView(p)
      await update($, viewAtom, () => view)
    }
    $.clock.every(2000, () => {
      void refresh?.(false).catch(() => undefined)
      void keepalive?.tick().catch(() => undefined)
      void alerts?.tick().catch(() => undefined)
      const p = port
      if (p) void leaveTransientPause(p).catch(() => undefined)
    })
    $.clock.every(RENEW_EVERY_MS, () => {
      const p = port
      if (p) void renewHolds(p).catch(() => undefined)
    })
    $.clock.every(120, async () => {
      const view = await read($, viewAtom)
      if (!paneOpen || !view || !paneRows(view).some((row) => row.state === 'running')) return
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length
      await update($, viewAtom, () => view)
    })
    if (await port.getRun()) {
      paneOpen = (await $.ui.open({ id: PANE, title: PANE_TITLE })).isPlaced
      await refresh(true)
    }
    return started
  })

  on('command.run', { command: 'jtasks' }, async ($) => {
    if (paneOpen) {
      await $.ui.close({ id: PANE })
      paneOpen = false
      return { text: tr('mod.pane_closed') }
    }
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
    paneOpen = opened.isPlaced
    await refresh?.(true)
    return { text: opened.isPlaced ? tr('mod.pane_open') : tr('mod.pane_no_room', { reason: String(opened.reason) }) }
  })

  on('ui.close', { id: 'tasks' }, async ($, e, next) => {
    paneOpen = false
    return next(e)
  })

  // A message the mod sent the orchestrator (an alert, the keepalive's nudge, the end of a pause) is for the model: the
  // person sees a tag and a few words in its row (the toast and the pane carry the details). Drawing only: the stored
  // message and what the model reads stay as they were.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const origin = e.props.origin
    if (origin.kind !== 'plugin' || origin.name !== 'jtasks') return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        <Text backgroundColor={TAG_COLOR} color="inverseText" bold>{' jtasks '}</Text>
        <Text dimColor>{` ${deliveryLabel(e.props.text)}`}</Text>
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'tasks' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const collapsed = await read($, collapsedAtom)
    if (!view) return <Text dimColor>{tr('view.loading')}</Text>
    const { header } = paneLines(view, collapsed, e.props.bodyColumns ?? 60)
    const toggle = async () => {
      const folded = !collapsed
      await update($, collapsedAtom, () => folded)
      await $.store.set('collapsed', folded)
    }
    return (
      <Box flexDirection="column">
        <Button key="toggle" plain onPress={toggle}>
          {header}
        </Button>
        {!collapsed && view.kind === 'runs' ? paneLines(view, false, e.props.bodyColumns ?? 60).body.map((line) => <Text>{line}</Text>) : null}
        {!collapsed && view.kind === 'run' ? (() => {
          const bar = hudBar(view.percent, view.done, view.total)
          const rows = paneRows(view)
          return <Box flexDirection="column">
            <Box key="summary" marginBottom={1}>
              <Text><Text color={BAR_COLOR}>{bar.filled}</Text><Text color={TRACK_COLOR}>{bar.empty}</Text><Text color={BAR_COLOR}>{` ${bar.text}`}</Text></Text>
            </Box>
            {rows.map((row, index) => <Box key={`row-${index}`} flexDirection="column">
              <Text>
                <Text color={ROW_MARK_COLOR[row.state]} dimColor={row.state === 'pending' || row.state === 'skipped'}>{row.state === 'running' ? SPINNER_FRAMES[spinnerFrame] : ROW_MARK[row.state]}</Text>
                {' '}<Text color={row.state === 'running' ? 'claude' : undefined} dimColor={row.state === 'pending' || row.state === 'skipped'} strikethrough={row.state === 'skipped'}>{row.label}</Text>
              </Text>
            </Box>)}
            {view.notice ? <Box key="notice" marginTop={1}><Text color="warning">{view.notice}</Text></Box> : null}
          </Box>
        })() : null}
      </Box>
    )
  })

  on('tool.call', { tool: FULL_NAME }, async ($, e) => {
    const input = e as unknown as { command?: unknown; json?: unknown; agentId?: string }
    const result = await callTool(needPort(), String(input.command ?? 'help'), input.json, input.agentId)
    if (result.ok && result.bind && !paneOpen) paneOpen = (await $.ui.open({ id: PANE, title: PANE_TITLE })).isPlaced
    await refresh?.(true).catch(() => undefined)
    return { result: result.text }
  }).catch(($, e, next) => (next.called ? next(e) : { result: tr('mod.tool_failed') }))

  // A subagent of a task: the agent, model, role and effort of the task's profile; an unknown profile refuses it.
  on('agent.spawn', async ($, e, next) => {
    const p = port
    const bound = p ? await p.getRun() : null
    if (!p || !bound) return next(e)
    const decision = await spawnDecision(createModHost(p, await p.cwd()), bound, e.prompt)
    if (decision.error) return { deny: `jtasks: ${decision.error}` }
    if (!decision.task) return next(e)
    // A task a transient pause kept for its subagent: that subagent is resumed, never a second one opened.
    const kept = Object.entries(await p.getAgents()).find(([, a]) => a.paused && a.run === bound.run && a.task === decision.task)
    if (kept) return { deny: `jtasks: ${tr('spawn.kept', { task: decision.task, agent: kept[0] })}` }
    const spawned = await next({ ...e, prompt: decision.prompt ?? e.prompt, ...(decision.agent ? { subagentType: decision.agent } : {}), ...(decision.model ? { model: decision.model } : {}) })
    if (spawned.agentId)
      await p.setAgents({ ...(await p.getAgents()), [spawned.agentId]: { run: bound.run, task: decision.task, ...(decision.effort ? { effort: decision.effort } : {}) } })
    return spawned
  }).catch(($, e, next) => (next.called ? next(e) : { deny: tr('mod.profile_failed') }))

  // The effort of the task's profile on every model request of its subagent, where the model takes one.
  on('turn.step', async function* ($, e, next) {
    const p = port
    const agents = p && e.agentId && e.effort !== undefined ? await p.getAgents().catch(() => undefined) : undefined
    const effort = e.agentId ? agents?.[e.agentId]?.effort : undefined
    return yield* next(effort ? { ...e, effort } : e)
  })

  // The guard: edits outside the ownership, mutating git of a subagent, and direct edits of the run's files.
  const guard = async (call: GuardedCall, agentId: string | undefined): Promise<string | undefined> => {
    const p = port
    const bound = p ? await p.getRun() : null
    if (!p || !bound) return undefined
    const agent = agentId ? (await p.getAgents())[agentId] : undefined
    const verdict = await judgeCall(createModHost(p, await p.cwd()), await p.cwd(), bound, agent, call)
    return verdict.allow ? undefined : `jtasks: ${verdict.reason}`
  }
  const refused = () => ({ deny: tr('mod.guard_failed') })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await guard({ tool: 'Edit', file_path: e.file_path }, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : refused()))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await guard({ tool: 'Write', file_path: e.file_path }, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : refused()))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const deny = await guard({ tool: 'NotebookEdit', notebook_path: e.notebook_path }, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : refused()))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await guard({ tool: 'Bash', command: e.command }, e.agentId)
    if (deny) return { deny }
    const p = port
    const bound = p && e.agentId ? await p.getRun() : null
    if (!p || !bound || !e.agentId) return next(e)
    const agents = await p.getAgents()
    const agent = agents[e.agentId]
    // A command it leaves running in the background (rev. 5.8): if its loop ends now, the task waits for it.
    if (agent && e.run_in_background) await p.setAgents({ ...agents, [e.agentId]: { ...agent, background: [...(agent.background ?? []), String(e.command).slice(0, 200)] } })
    const owner = `gt:${bound.run}/${agent?.task ?? 'exec'}-bash`
    const wrapped = await serializedCommand(createModHost(p, await p.cwd()), bound, e.command, owner)
    return next(wrapped ? { ...e, command: wrapped } : e)
  }).catch(($, e, next) => (next.called ? next(e) : refused()))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) keepalive?.turnStarted()
    // A subagent a transient pause kept is working again (resumed by a message): its place is an ordinary one.
    const p = port
    if (e.agentId !== undefined && p) {
      const agents = await p.getAgents().catch(() => undefined)
      const mine = agents?.[e.agentId]
      if (agents && mine?.paused) await p.setAgents({ ...agents, [e.agentId]: { ...mine, paused: false } }).catch(() => undefined)
      // A subagent whose task waited for its process is back (Claude Code reopened it): the wait is over (rev. 5.8).
      if (agents && mine && (mine.awaiting || mine.background?.length)) {
        await p.setAgents({ ...(await p.getAgents()), [e.agentId]: { ...mine, paused: false, awaiting: false, background: [] } }).catch(() => undefined)
        if (mine.awaiting) await awaitBack(await sessionCtx(p, mine.run), mine.run, mine.task, 'turn.start').catch(() => false)
      }
    }
    return next(e)
  })

  // What a loop that dies on an API error says about it (kind, details, the rendered error), kept for its end.
  on('classic.StopFailure', async ($, e, next) => {
    failures?.stopFailure(e)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Claude Code went on by itself after a usage limit reset: a transient pause the host would end later ends now.
  on('classic.Notification', async ($, e, next) => {
    const p = port
    if (p && e.notification_type === 'quota_auto_resume_fired') void leaveTransientPause(p, 'quota_auto_resume_fired').catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The keepalive's own message, checked again right before it enters: dropped when the run moved meanwhile (in
  // doubt, or past 3 s, it goes).
  on('prompt.submit', async ($, e, next) => {
    const p = port
    // The notification of a background task (a subagent's end or pause, a shell) carries the run's status line read
    // now, so the orchestrator never answers it from a stale picture (rev. 5.8).
    if (e.origin?.kind === 'task-notification' && p) {
      const bound = await p.getRun().catch(() => null)
      const brief = bound ? await readBrief(createModHost(p, await p.cwd()), bound.root, bound.run).catch(() => undefined) : undefined
      return next(brief ? { ...e, context: [...(e.context ?? []), statusContext(bound!.run, brief)] } : e)
    }
    if (e.origin?.kind !== 'plugin' || e.origin.name !== 'jtasks' || !keepalive || !p) return next(e)
    const wanted = await Promise.race([keepalive.stillWanted().catch(() => true), p.sleep(3000).then(() => true)])
    return wanted ? next(e) : { drop: tr('keepalive.dropped') }
  })

  // The main loop's end: the keepalive decides (the turn's end waits 3 s at most; the rest goes on in the
  // background). A subagent whose loop ended with its task still in progress: the task goes back to the queue.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const p = port
    if (!p) return done
    if (e.agentId === undefined) {
      // A transient failure of the orchestrator itself (rev. 5.7): the run is paused and the keepalive stays quiet.
      const paused = e.reason === 'error'
        ? await Promise.race([pauseOnFailure(p, undefined, e.answer, () => lastMessage(() => $.session.messages())).catch(() => undefined), p.sleep(2500).then(() => undefined)])
        : undefined
      if (keepalive) await Promise.race([keepalive.turnEnded(e.reason).catch(() => undefined), p.sleep(paused ? 500 : 3000)])
      if (paused) {
        tell?.paused(paused)
        await refresh?.(true).catch(() => undefined)
      }
      return done
    }
    const agents = await p.getAgents()
    const mine = agents[e.agentId]
    if (!mine) return done
    // A subagent dead on a transient failure (rev. 5.7): the run is paused and its task kept in progress with its
    // locks; its place here stays (the guard still knows its task), for the orchestrator to resume it.
    if (e.reason === 'error') {
      const agentId = e.agentId
      const paused = await pauseOnFailure(p, agentId, e.answer, () => lastMessage(() => $.session.messages({ agentId })), mine).catch(() => undefined)
      if (paused) {
        await p.setAgents({ ...(await p.getAgents()), [agentId]: { ...mine, paused: true } })
        tell?.paused(paused)
        await refresh?.(true).catch(() => undefined)
        return done
      }
    }
    const bound = await p.getRun()
    if (bound?.run === mine.run) {
      // Claude Code's word on the agent (`waiting`: on background work it owns), and the commands it left running.
      const agentId = e.agentId
      const status = await Promise.race([
        $.agent.list().then((list) => list.find((a) => a.id === agentId)?.status, () => undefined),
        p.sleep(1500).then(() => undefined),
      ])
      await endOfAgent(p, agentId, mine, status)
      // The orchestrator hears of it now, not when a task happens to be ready.
      await alerts?.check().catch(() => undefined)
    } else {
      const { [e.agentId]: _gone, ...rest } = agents
      await p.setAgents(rest)
    }
    await refresh?.(true).catch(() => undefined)
    return done
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const p = port
    const bound = p ? await p.getRun() : null
    if (!p || !bound) return composed
    const text = await protocolSection(createModHost(p, await p.cwd()), bound).catch(() => undefined)
    const sections = composed.sections.filter((s) => s.id !== SECTION_ID)
    return { sections: text ? [...sections, { id: SECTION_ID, text, scope: 'session' as const }] : sections }
  })
}
