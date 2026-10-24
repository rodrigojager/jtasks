// goal-tasks for Claude Code: the `tasks` tool (the core's runTool on a host made of $.fs and $.process), the run
// bound to the session in $.state (subagents share it), the protocol section in the system prompt while a run is
// bound (prompt.compose runs at every request, so it is back after a compaction too), and the "Tasks" pane with
// /jtasks (Claude Code ships its own /tasks), refreshed every 2 s while open.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { parseArgs, runTool, splitCommand, type Resident, type ToolContext, type ToolResult } from '../core/core.js'
import { createModHost, type Port } from './mod-host.ts'
import { serializedCommand, spawnDecision } from './agents.ts'
import { judgeCall, type GuardedCall } from './guard.ts'
import { computeView, isLive, PANE, PANE_TITLE, paneLines } from './pane.tsx'
import type { PaneView } from '../types'
import { protocolSection, SECTION_ID, TOOL_DESCRIPTION, TOOL_NAME, TOOL_SCHEMA } from './protocol.ts'

const RUN = { plugin: 'goal-tasks', key: 'run' } as const
// Change the tag when the view's fields change: it declines what an earlier version stored.
const viewAtom = atom({ plugin: 'goal-tasks', key: 'view' } as const, null as PaneView | null, { shape: 'view-1' })
const collapsedAtom = atom({ plugin: 'goal-tasks', key: 'collapsed' } as const, false)
const AGENTS = { plugin: 'goal-tasks', key: 'agents' } as const
const FULL_NAME = 'mcp__goal-tasks__tasks'

/** Actions that may name another run than the bound one (they create, bind or only list). */
const ANY_RUN = new Set(['plan', 'resume', 'import', 'runs', 'ledger', 'gc', 'help', 'version', 'validate', 'clean', 'archive', 'undo'])

/** The holds this session keeps alive (lost with a reload: their loops end with the module, and so do the children). */
const residents = new Map<string, Resident[]>()

/** Set at session.start: the closures over $ the rest of the module works through. */
let port: Port | undefined
/** Set at session.start: recomputes the pane's view now (a closure over that hook's $). */
let refresh: ((force: boolean) => Promise<void>) | undefined
let paneOpen = false

function needPort(): Port {
  if (!port) throw new Error('goal-tasks: a sessão ainda não começou (session.start)')
  return port
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
    return { ok: false, code: 1, text: `esta sessão está ligada à execução ${bound.run}; --run ${asked} é recusado` }
  const cwd = await p.cwd()
  const ctx: ToolContext = { host: createModHost(p, cwd), cwd, tool: 'claude', session: await p.sessionId(), residents }
  if (bound) ctx.boundRun = bound.run
  if (agentId) ctx.agent = agentId
  if (json !== undefined) ctx.json = json
  const result = await runTool(ctx, argv)
  const id = parsed.positionals[0]
  if (agentId && result.ok && id && (bound || result.bind)) {
    const agents = await p.getAgents()
    if (parsed.action === 'start' || parsed.action === 'claim') await p.setAgents({ ...agents, [agentId]: { run: result.bind ?? bound!.run, task: id } })
  }
  if (result.ok && result.bind) {
    const dir = (result.data as { dir?: string } | undefined)?.dir?.replace(/\\/g, '/')
    const root = dir ? dir.replace(/\/\.scratch\/goal-tasks\/runs\/[^/]+$/, '') : (bound?.root ?? cwd)
    await p.setRun({ run: result.bind, root })
  }
  return result
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
        GOAL_TASKS_HOME: await $.env.get('GOAL_TASKS_HOME'),
        USERPROFILE: await $.env.get('USERPROFILE'),
        HOME: await $.env.get('HOME'),
        JLOCK_BIN: await $.env.get('JLOCK_BIN'),
      },
    }
    await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    await $.command.register({ name: 'jtasks', description: 'Abre ou fecha o painel Tasks (goal-tasks)' })

    const stored = await $.store.get('collapsed')
    if (typeof stored === 'boolean') await update($, collapsedAtom, () => stored)
    let signature = ''
    refresh = async (force) => {
      const p = port
      if (!p || !paneOpen) return
      const bound = await p.getRun()
      const files = bound ? [`${bound.root}/.scratch/goal-tasks/runs/${bound.run}/tasks.json`, `${bound.root}/.scratch/goal-tasks/runs/${bound.run}/run.json`] : []
      const stats = await Promise.all(files.map((f) => p.stat(f).then((x) => x.mtimeMs, () => 0)))
      const current = `${bound?.run ?? ''}:${stats.join(',')}`
      if (!force && current === signature && !isLive(await read($, viewAtom))) return
      signature = current
      const view = await computeView(p)
      await update($, viewAtom, () => view)
    }
    $.clock.every(2000, () => void refresh?.(false).catch(() => undefined))
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
      return { text: 'Painel Tasks fechado.' }
    }
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
    paneOpen = opened.isPlaced
    await refresh?.(true)
    return { text: opened.isPlaced ? 'Painel Tasks aberto.' : `O painel Tasks não coube agora: ${opened.reason}` }
  })

  on('ui.close', { id: 'tasks' }, async ($, e, next) => {
    paneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'tasks' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const collapsed = await read($, collapsedAtom)
    if (!view) return <Text dimColor>Tasks: carregando…</Text>
    const { header, body } = paneLines(view, collapsed, e.props.bodyColumns ?? 60)
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
        {body.map((line) => (
          <Text>{line}</Text>
        ))}
      </Box>
    )
  })

  on('tool.call', { tool: FULL_NAME }, async ($, e) => {
    const input = e as unknown as { command?: unknown; json?: unknown; agentId?: string }
    const result = await callTool(needPort(), String(input.command ?? 'help'), input.json, input.agentId)
    if (result.ok && result.bind && !paneOpen) paneOpen = (await $.ui.open({ id: PANE, title: PANE_TITLE })).isPlaced
    await refresh?.(true).catch(() => undefined)
    return { result: result.text }
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'goal-tasks: a ferramenta falhou nesta chamada; tente de novo (tasks status)' }))

  // A subagent of a task: the model, role and effort of the task's profile; an unknown profile refuses it.
  on('agent.spawn', async ($, e, next) => {
    const p = port
    const bound = p ? await p.getRun() : null
    if (!p || !bound) return next(e)
    const decision = await spawnDecision(createModHost(p, await p.cwd()), bound, e.prompt)
    if (decision.error) return { deny: `goal-tasks: ${decision.error}` }
    if (!decision.task) return next(e)
    const spawned = await next({ ...e, prompt: decision.prompt ?? e.prompt, ...(decision.model ? { model: decision.model } : {}) })
    if (spawned.agentId) await p.setAgents({ ...(await p.getAgents()), [spawned.agentId]: { run: bound.run, task: decision.task } })
    return spawned
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'goal-tasks: não deu para ler o perfil da tarefa; tente de novo' }))

  // The guard: edits outside the ownership, mutating git of a subagent, and direct edits of the run's files.
  const guard = async (call: GuardedCall, agentId: string | undefined): Promise<string | undefined> => {
    const p = port
    const bound = p ? await p.getRun() : null
    if (!p || !bound) return undefined
    const agent = agentId ? (await p.getAgents())[agentId] : undefined
    const verdict = await judgeCall(createModHost(p, await p.cwd()), await p.cwd(), bound, agent, call)
    return verdict.allow ? undefined : `goal-tasks: ${verdict.reason}`
  }
  const refused = { deny: 'goal-tasks: a guarda de posse falhou nesta chamada; ela foi recusada por segurança' }
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await guard({ tool: 'Edit', file_path: e.file_path }, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : refused))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await guard({ tool: 'Write', file_path: e.file_path }, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : refused))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const deny = await guard({ tool: 'NotebookEdit', notebook_path: e.notebook_path }, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : refused))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await guard({ tool: 'Bash', command: e.command }, e.agentId)
    if (deny) return { deny }
    const p = port
    const bound = p && e.agentId ? await p.getRun() : null
    if (!p || !bound || !e.agentId) return next(e)
    const agent = (await p.getAgents())[e.agentId]
    const owner = `gt:${bound.run}/${agent?.task ?? 'exec'}-bash`
    const wrapped = await serializedCommand(createModHost(p, await p.cwd()), bound, e.command, owner)
    return next(wrapped ? { ...e, command: wrapped } : e)
  }).catch(($, e, next) => (next.called ? next(e) : refused))

  // A subagent whose loop ended with its task still in progress: the task goes back to the queue.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const p = port
    if (!p || !e.agentId) return done
    const agents = await p.getAgents()
    const mine = agents[e.agentId]
    if (!mine) return done
    const { [e.agentId]: _gone, ...rest } = agents
    await p.setAgents(rest)
    const bound = await p.getRun()
    if (bound?.run === mine.run) await callTool(p, `release ${mine.task} --agent-ended`, undefined, e.agentId).catch(() => undefined)
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
