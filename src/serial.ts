// What has to happen one at a time across processes (ticket 60): the transitions that touch the working tree (a
// task's edits kept as patches or brought back, the commit of a `done`, the files put back to HEAD) and the edits of a
// draft. Not a lock of our own: a jlock key, `name:jtasks:<run>:git`, held by the process doing the work. Where the
// host keeps a child's standard input open (the CLI, the plugin), it is `jlock hold --release-on-eof`: the lock goes
// the instant the process dies, with no heartbeat and no deadline, so a process that stalls keeps it (rev. 5.8's write
// lock was broken under a slow holder after 10 s). Where it cannot (the mod: `$.process.spawn` closes standard input
// at once), `jlock hold --detach` with a short ttl, given back in `finally`.
//
// State is not serialized here (events.ts and the optimistic commit in store.ts are), only effects.

import type { Host } from "./host.ts"
import { detachedHold, jlockBin, jlockEnv, jlockReleaseKeys, startHold, type HoldOutcome } from "./jlock.ts"
import { ToolError, type ToolContext } from "./tool.ts"
import { tr } from "./i18n.ts"

/** The key that serializes a run's working-tree effects. */
export function treeKey(run: string): string {
  return `name:jtasks:${run}:git`
}

/** The key that serializes the edits of a draft (plan --add, --fix, --commit). */
export function draftKey(id: string): string {
  return `name:jtasks:${id}:draft`
}

/** How long a caller waits for the key before giving up (a `done` with slow commit hooks holds it meanwhile). */
export const SERIAL_WAIT_SEC = 300
/** The ttl of a detached hold of the key (the mod): the net under a host that died holding it. */
export const SERIAL_DETACH_TTL = "10m"

function ownerOf(key: string, host: Host): string {
  const rest = key.replace(/^name:jtasks:/, "").replace(/:(git|draft)$/, "")
  return `gt:${rest}/~${key.endsWith(":draft") ? "draft" : "tree"}-${host.now().getTime().toString(36)}${Math.floor(host.random() * 1e6).toString(36)}`
}

/**
 * Runs `fn` holding `key`. Reentrant through the context: a caller that already holds it (`ctx.serialKeys`) runs `fn`
 * at once. `fn` gets the context to pass on to whatever it calls.
 *
 * `*` covers every key, `name:` ones included, and jlock grants a key to the owner that already holds a conflicting
 * one. So while a task of the run that is `exclusive` holds `*`, the key is held under that task's owner (`as`, or
 * found when the first try is refused by it): the only way it can be granted at all (docs/DEVIATIONS.md).
 */
export async function withKey<R>(
  ctx: ToolContext,
  key: string,
  intent: string,
  fn: (ctx: ToolContext) => Promise<R>,
  opts: { as?: string; run?: string } = {},
): Promise<R> {
  if (ctx.serialKeys?.has(key)) return fn(ctx)
  const { host } = ctx
  let owner = opts.as ?? ownerOf(key, host)
  const eof = host.holdsInput === true
  const hold = async (wait: string[]): Promise<HoldOutcome> => {
    const base = [jlockBin(host), "hold", key, "--owner", owner, "--intent", intent, ...wait]
    if (!eof) return detachedHold(host, [...base, "--ttl", SERIAL_DETACH_TTL, "--detach", "--json"], host.cwd(), (SERIAL_WAIT_SEC + 15) * 1000)
    const resident = await host.spawn([...base, "--release-on-eof", "--json"], { env: jlockEnv() })
    return startHold(host, resident, (SERIAL_WAIT_SEC + 15) * 1000)
  }
  let outcome = await hold(["--no-wait"])
  if (outcome.answer.result !== "granted") {
    const a = outcome.answer
    const holder = typeof a.holder === "object" && a.holder ? a.holder.owner : undefined
    // Refused by our own run's exclusive task holding `*`: held under its owner instead.
    if (!opts.as && opts.run && holder?.startsWith(`gt:${opts.run}/`) && (a.via === "*" || a.failed === "*" || a.key === "*")) owner = holder
    outcome = await hold(["--timeout", `${SERIAL_WAIT_SEC}s`])
  }
  if (outcome.answer.result !== "granted") {
    const holder = typeof outcome.answer.holder === "object" && outcome.answer.holder ? outcome.answer.holder.owner : String(outcome.answer.holder ?? "?")
    throw new ToolError(tr("store.tree_busy", { key, holder, seconds: SERIAL_WAIT_SEC }), 1, { result: outcome.answer.result, key })
  }
  const inner: ToolContext = { ...ctx, serialKeys: new Set([...(ctx.serialKeys ?? []), key]) }
  try {
    return await fn(inner)
  } finally {
    const resident = outcome.resident
    if (resident) {
      if (!(await resident.send("release\n"))) await jlockReleaseKeys(host, [key], owner).catch(() => {})
      await resident.closeInput().catch(() => {})
      await Promise.race([resident.exited, host.sleep(5000)])
      await resident.stop().catch(() => {})
    } else await jlockReleaseKeys(host, [key], owner).catch(() => {})
  }
}

/**
 * Runs `fn` holding the run's tree key (`treeKey`). `as`: the owner to hold it under, the starting exclusive task's
 * (its `*` comes next, and would be refused by a key some other owner holds).
 */
export function withTree<R>(ctx: ToolContext, run: string, fn: (ctx: ToolContext) => Promise<R>, as?: string): Promise<R> {
  return withKey(ctx, treeKey(run), `jtasks ${run}: working tree`, fn, as ? { as, run } : { run })
}
