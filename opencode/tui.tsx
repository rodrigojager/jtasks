/** @jsxImportSource @opentui/solid */
// goal-tasks for the OpenCode TUI: the "Tasks" section in the session sidebar (header, bar, checklist), folded
// with a click. The data comes from the server plugin's RPC (`goal-tasks.state`); the TUI never reads the files.
// It reloads after every successful tool call, on the RPC's `changed` event, and every 2 s while a task runs.

import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { headerText, lineText, summaryText, type LineState, type View } from "./core/core.js"
import { TasksRpc } from "./src/rpc.ts"

type Context = Plugin.Context

export const SECTION_WIDTH = 38
const REFRESH_MS = 2000

export interface TuiOptions {
  /** Tests use a shorter interval. */
  readonly refreshMs?: number
}

export function createTuiPlugin(options: TuiOptions = {}): Plugin.Definition {
  return {
    id: "goal-tasks.tui",
    setup(context: Context) {
      const rpc = context.client.rpc(TasksRpc)
      const [prefs, setPrefs] = context.storage.store("prefs", { initial: { collapsed: false } })
      const theme = () => context.theme.surface("sidebar" as never) as unknown as Record<string, any>
      const color = (state: LineState | "header") => {
        const t = theme()?.text ?? context.theme.text
        if (state === "header") return t.base
        if (state === "done" || state === "skipped") return t.muted
        if (state === "failed") return t.feedback?.error?.base ?? t.base
        if (state === "blocked") return t.faint ?? t.muted
        return t.base
      }

      function TasksSection(props: { sessionID: string }) {
        const [view, setView] = createSignal<View | undefined>()
        const load = async () => {
          try {
            const r = (await rpc.state({ sessionID: props.sessionID })) as { view: View }
            setView(r.view)
          } catch {
            // The server plugin is not loaded (or not reachable): no section.
          }
        }
        void load()
        const stopTool = context.data.on("session.tool.success", () => void load())
        const stopRpc = rpc.events.on("changed", () => void load())
        const timer = setInterval(() => {
          const v = view()
          if (v?.kind === "run" && v.lines.some((l) => l.state === "running" || l.state === "waiting")) void load()
        }, options.refreshMs ?? REFRESH_MS)
        onCleanup(() => {
          stopTool()
          stopRpc()
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
        return (
          <Show when={view() !== undefined}>
            <box flexDirection="column" width={SECTION_WIDTH}>
              <text fg={color("header")} onMouseUp={toggle}>
                {headerText(view()!, prefs.collapsed)}
              </text>
              <Show when={!prefs.collapsed && runView() !== undefined}>
                <text fg={color("running")}>{summaryText(runView()!, 12)}</text>
                <For each={runView()?.lines ?? []}>{(l) => <text fg={color(l.state)}>{lineText(l, SECTION_WIDTH)}</text>}</For>
              </Show>
              <Show when={!prefs.collapsed && runView() === undefined}>
                <For each={runs()}>{(r) => <text fg={color("blocked")}>{`${r.id} · ${r.done}/${r.total} (${r.percent}%)`}</text>}</For>
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
