/** @jsxImportSource @opentui/solid */
// jtasks for the OpenCode TUI: the "Tasks" section in the session sidebar (header, progress row, one row per
// task), folded with a click. The data comes from the server plugin's RPC (`jtasks.state`); the TUI never reads
// the files. It reloads after every successful tool call, on the RPC's `changed` event, and every 2 s while a task
// runs. When the keepalive gave up on the run (the view's `notice`), a line under the tasks and one toast.
//
//   ▾ Tasks
//   Progress ██████▋███ 66% · 2/3
//   ✓ Pane model: claude-hud bar and task rows
//   ⠶ Pane render and spinner
//     Pane documentation

import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, Index, Match, onCleanup, Show, Switch } from "solid-js"
import { barCells, headerText, select, systemLocale, tr, width as columns, type LineState, type RunView, type View, type ViewLine } from "./core/core.js"
import { TasksRpc } from "./src/rpc.ts"
import { Spinner } from "./src/spinner.tsx"

type Context = Plugin.Context

export const SECTION_WIDTH = 38
const REFRESH_MS = 2000
/** The done mark's colour when the theme has no success feedback colour. */
const FALLBACK_GREEN = "#4caf50"
/** Each row is a two-column mark (`✓ `, the spinner and a space, or two spaces) and the title. */
const MARK_COLUMNS = 2

export interface TuiOptions {
  /** Tests use a shorter interval. */
  readonly refreshMs?: number
}

/** The text cut to `width` terminal columns (wide characters count two), with … when cut. */
function fit(text: string, width: number): string {
  if (columns(text) <= width) return text
  let out = ""
  for (const ch of text) {
    if (columns(out + ch) > Math.max(1, width - 1)) break
    out += ch
  }
  return `${out}…`
}

/** The header: `▾ Tasks` unfolded (plus the paused note), the core's text otherwise. */
function header(view: View, collapsed: boolean): string {
  if (view.kind === "run" && !collapsed) return `▾ Tasks${view.paused ? ` · ${tr("view.paused")}` : ""}`
  return headerText(view, collapsed)
}

const active = (state: LineState) => state === "running" || state === "waiting"

export function createTuiPlugin(options: TuiOptions = {}): Plugin.Definition {
  return {
    id: "jtasks.tui",
    setup(context: Context) {
      // The TUI is its own process: it picks the language as the server does (JTASKS_LANG, JLOCK_LANG, system).
      select({ env: (name) => process.env[name], system: systemLocale() })
      const rpc = context.client.rpc(TasksRpc)
      const [prefs, setPrefs] = context.storage.store("prefs", { initial: { collapsed: false } })
      // Every colour is read on render, so a theme switch repaints the section.
      const theme = () => context.theme.surface("sidebar" as never) as unknown as Record<string, any>
      const text = () => theme()?.text ?? (context.theme as any).text
      const base = () => text().base
      const muted = () => text().muted ?? base()
      const faint = () => text().faint ?? muted()
      const success = () => text().feedback?.success?.base ?? (context.theme as any).text?.feedback?.success?.base ?? FALLBACK_GREEN
      const error = () => text().feedback?.error?.base ?? (context.theme as any).text?.feedback?.error?.base ?? base()
      // The bar as the opencode-hud's Meter paints it: the theme's interactive hue, and a raised background as the
      // empty track. The running task's spinner and title use the same hue.
      const primary = () => (context.theme as any).hue?.interactive?.[200] ?? base()
      const track = () => (context.theme as any).background?.raised?.high ?? faint()

      const titleColor = (state: LineState) => {
        if (active(state)) return primary()
        if (state === "done" || state === "failed") return base()
        return muted()
      }

      /** One task: its mark (✓, the spinner, ✗ or nothing) and its title, cut to the section's width. */
      function TaskRow(props: { line: () => ViewLine }) {
        const state = () => props.line().state
        return (
          <text>
            <Switch fallback={<span>{" ".repeat(MARK_COLUMNS)}</span>}>
              <Match when={state() === "done"}>
                <span style={{ fg: success() }}>{"✓ "}</span>
              </Match>
              <Match when={active(state())}>
                <Spinner color={primary()} />
                <span>{" "}</span>
              </Match>
              <Match when={state() === "failed"}>
                <span style={{ fg: error() }}>{"✗ "}</span>
              </Match>
            </Switch>
            <span
              style={{
                fg: titleColor(state()),
                attributes: state() === "skipped" ? TextAttributes.STRIKETHROUGH : TextAttributes.NONE,
              }}
            >
              {fit(props.line().note ? `${props.line().title} · ${props.line().note}` : props.line().title, SECTION_WIDTH - MARK_COLUMNS)}
            </span>
          </text>
        )
      }

      /** `Progress ██████▋███ 66% · 2/3`: the label as the opencode-hud labels its rows, the bar as its Meter. */
      function ProgressRow(props: { view: () => RunView | undefined }) {
        const v = () => props.view() ?? { percent: 0, done: 0, total: 0 }
        const cells = () => barCells(v().percent)
        return (
          <text>
            <span style={{ fg: muted() }}>{"Progress "}</span>
            <span style={{ fg: primary() }}>{cells().full}</span>
            <span style={{ fg: primary(), bg: track() }}>{cells().partial}</span>
            <span style={{ fg: track() }}>{cells().empty}</span>
            <span style={{ fg: base() }}>{` ${v().percent}% · ${v().done}/${v().total}`}</span>
          </text>
        )
      }

      function TasksSection(props: { sessionID: string }) {
        const [view, setView] = createSignal<View | undefined>()
        let toasted: string | undefined
        const load = async () => {
          try {
            const r = (await rpc.state({ sessionID: props.sessionID })) as { view: View }
            setView(r.view)
            const notice = r.view.kind === "run" ? r.view.notice : undefined
            if (notice && notice !== toasted) context.ui.toast?.show({ message: notice, variant: "warning", sessionID: props.sessionID })
            toasted = notice
          } catch {
            // The server plugin is not loaded (or not reachable): no section.
          }
        }
        void load()
        const stopTool = context.data.on("session.tool.success", () => void load())
        const stopRpc = rpc.events.on("changed", () => void load())
        // What the run did without the root session asking (rev. 5.8): a toast, and the rows again.
        const stopAlert = rpc.events.on("alert", (event: { data: unknown }) => {
          const notice = (event.data as { notice?: string } | undefined)?.notice
          if (notice) context.ui.toast?.show({ message: `jtasks: ${notice}`, variant: "warning", sessionID: props.sessionID })
          void load()
        })
        const timer = setInterval(() => {
          const v = view()
          if (v?.kind === "run" && v.lines.some((l) => active(l.state))) void load()
        }, options.refreshMs ?? REFRESH_MS)
        onCleanup(() => {
          stopTool()
          stopRpc()
          stopAlert()
          clearInterval(timer)
        })
        const toggle = () => void setPrefs((draft) => void (draft.collapsed = !draft.collapsed))
        const runView = () => {
          const v = view()
          return v?.kind === "run" ? v : undefined
        }
        const runs = () => {
          const v = view()
          return v?.kind === "runs" ? v.runs : []
        }
        // Rows are kept by position (<Index>), so a reload does not remount a running task's spinner.
        return (
          <Show when={view() !== undefined}>
            <box flexDirection="column" width={SECTION_WIDTH}>
              <text fg={base()} onMouseUp={toggle}>
                {header(view()!, prefs.collapsed)}
              </text>
              <Show when={!prefs.collapsed && runView() !== undefined}>
                <ProgressRow view={runView} />
                <Index each={runView()?.lines ?? []}>{(line) => <TaskRow line={line} />}</Index>
                <Show when={runView()?.notice}>
                  <text fg={error()}>{fit(runView()?.notice ?? "", SECTION_WIDTH)}</text>
                </Show>
              </Show>
              <Show when={!prefs.collapsed && runView() === undefined}>
                <Index each={runs()}>{(r) => <text fg={faint()}>{`${r().id} · ${r().done}/${r().total} (${r().percent}%)`}</text>}</Index>
              </Show>
            </box>
          </Show>
        )
      }

      context.ui.slot({ append: "sidebar.content", render: (input) => <TasksSection sessionID={input.sessionID} /> })
    },
  }
}

export default createTuiPlugin()
