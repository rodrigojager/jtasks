// The display model for a session (served by the RPC): the bound run's checklist, or the repository's runs when
// the session has none.

import { boundData, loadRunsView, loadView, resolvePaths, type Host, type View } from "../core/core.js"
import type { Bindings } from "./binding.ts"

export async function viewFor(host: Host, bindings: Bindings, sessionID: string, fallbackDir: string): Promise<View> {
  const run = await bindings.run(sessionID)
  if (run) {
    const view = await loadView(host, run.root, boundData(run), run.run, "opencode")
    if (view) return view
  }
  const dir = (await bindings.directory(sessionID)) ?? fallbackDir
  // The session's folder may be the repository or a jproject container around it (core's workspace.ts).
  const paths = await resolvePaths(host, dir)
  return paths ? loadRunsView(host, paths) : { kind: "runs", runs: [] }
}
