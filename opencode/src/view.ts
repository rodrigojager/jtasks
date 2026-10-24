// The display model for a session (served by the RPC): the bound run's checklist, or the repository's runs when
// the session has none.

import { loadRunsView, loadView, repoRoot, type Host, type View } from "../core/core.js"
import type { Bindings } from "./binding.ts"

export async function viewFor(host: Host, bindings: Bindings, sessionID: string, fallbackDir: string): Promise<View> {
  const run = await bindings.run(sessionID)
  if (run) {
    const view = await loadView(host, run.root, run.run, "opencode")
    if (view) return view
  }
  const dir = (await bindings.directory(sessionID)) ?? fallbackDir
  const root = await repoRoot(host, dir)
  return root ? loadRunsView(host, root) : { kind: "runs", runs: [] }
}
