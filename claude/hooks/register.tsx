// goal-tasks for Claude Code: the `tasks` tool (the core's runTool on a host made of $.fs and $.process), the run
// bound to the session in $.state (subagents share it), and the protocol section in the system prompt while a run
// is bound (prompt.compose runs at every request, so it is back after a compaction too).

import type { Register } from 'claude-code'
import { parseArgs, runTool, splitCommand, type Resident, type ToolContext, type ToolResult } from '../core/core.js'
import { createModHost, type Port } from './mod-host.ts'
import { protocolSection, SECTION_ID, TOOL_DESCRIPTION, TOOL_NAME, TOOL_SCHEMA } from './protocol.ts'

const RUN = { plugin: 'goal-tasks', key: 'run' } as const
const FULL_NAME = 'mcp__goal-tasks__tasks'

/** Actions that may name another run than the bound one (they create, bind or only list). */
const ANY_RUN = new Set(['plan', 'resume', 'import', 'runs', 'ledger', 'gc', 'help', 'version', 'validate', 'clean', 'archive', 'undo'])

/** The holds this session keeps alive (lost with a reload: their loops end with the module, and so do the children). */
const residents = new Map<string, Resident[]>()

/** Set at session.start: the closures over $ the rest of the module works through. */
let port: Port | undefined

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
    return started
  })

  on('tool.call', { tool: FULL_NAME }, async ($, e) => {
    const input = e as unknown as { command?: unknown; json?: unknown; agentId?: string }
    const result = await callTool(needPort(), String(input.command ?? 'help'), input.json, input.agentId)
    return { result: result.text }
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
