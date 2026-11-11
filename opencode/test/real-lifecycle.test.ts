// Opt-in acceptance against the real OpenCode CLI and plugin loader, using only a loopback scripted model.
// OPENCODE_BIN=<native executable> JTASKS_E2E_PACKAGE=<release root> bun test test/real-lifecycle.test.ts
import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { createNodeHost } from "../../src/node-host.ts"
import { cleanupTemp, makeRepo, tempDir, writeFiles } from "./fake-host.ts"

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
async function bounded<T>(promise: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${stage}`)), 20_000) })]) }
  finally { clearTimeout(timer!) }
}

test.skipIf(!process.env.OPENCODE_BIN)("real OpenCode: background parent responds while child is gated; child cancellation kills native descendants", async () => {
  const pkg = resolve(process.env.JTASKS_E2E_PACKAGE ?? join(import.meta.dir, "../.."))
  const isolated = tempDir("real-opencode")
  const repo = makeRepo()
  const ready = deferred<{ parent: number; grandchild: number }>()
  const closed = deferred<void>()
  const parentResponded = deferred<void>()
  const parentHeld = deferred<void>()
  const ack = deferred<any>()
  const loaded = deferred<void>()
  let parentSteps = 0
  let childSteps = 0
  let nativeResponse: Response | undefined
  let boundRun = ""
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
    if (new URL(request.url).pathname === "/loaded") { loaded.resolve(); return new Response("ok") }
    if (new URL(request.url).pathname === "/observe") { const event = await request.json() as any; if (event.tool === "subagent") ack.resolve(event); return new Response("ok") }
    if (new URL(request.url).pathname === "/native") {
      ready.resolve(await request.json() as { parent: number; grandchild: number })
      request.signal.addEventListener("abort", () => closed.resolve(), { once: true })
      nativeResponse = new Response(new ReadableStream({ cancel() { closed.resolve() } }))
      return nativeResponse
    }
    const body = await request.json() as any
    const text = JSON.stringify(body.messages)
    const isParent = text.includes("PARENT_ACCEPTANCE")
    if (isParent && text.includes("PARENT_ACCEPTANCE_INTERRUPT_WHILE_CHILD_GATED")) {
      parentHeld.resolve()
      return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
    }
    console.log("scripted request:", isParent ? "parent" : "child", parentSteps, childSteps)
    let name: string | undefined
    let args: unknown
    let content = ""
    if (isParent) {
      parentSteps++
      if (parentSteps === 1) { name = "jtasks"; args = { command: "plan", json: { profiles: { execute: { opencode: { agent: "execute" } } }, tasks: [{ id: "T01", title: "Native cancellation", files: ["runner.cjs"] }] } } }
      else if (parentSteps === 2) {
        boundRun = /bound run ([a-z0-9-]+)/.exec(text)?.[1] ?? ""
        if (!boundRun) throw new Error("Run binding missing from real model context")
        name = "subagent"; args = { agent: "execute", description: "Native cancellation", prompt: `--run ${boundRun} --task T01 Execute the scripted test.` }
      } else { content = "PARENT_RESPONSIVE"; parentResponded.resolve() }
    } else {
      childSteps++
      if (childSteps === 1) { name = "jtasks"; args = { command: "start T01" } }
      else if (childSteps === 2) { name = "jtasks"; args = { command: `exec --task T01 --timeout 40s -- "${Bun.which("node")!.replace(/\\/g, "/")}" runner.cjs` } }
      else content = "CHILD_ENDED"
    }
    const delta = name ? { tool_calls: [{ index: 0, id: `call_${isParent ? "p" : "c"}_${isParent ? parentSteps : childSteps}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { content }
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, name ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  const endpoint = `http://127.0.0.1:${model.port}`
  writeFiles(repo, { "runner.cjs": `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},45000)'],{stdio:'inherit'}); fetch('${endpoint}/native',{method:'POST',body:JSON.stringify({parent:process.pid,grandchild:child.pid})}).then(r=>r.text()); setTimeout(()=>{},45000);` })
  mkdirSync(join(isolated, "observer"), { recursive: true })
  writeFileSync(join(isolated, "observer/package.json"), JSON.stringify({ name: "jtasks-acceptance-observer", type: "module", exports: { ".": "./server.ts" } }))
  writeFileSync(join(isolated, "observer/server.ts"), `export default {id:'jtasks.acceptance',async setup(ctx){await ctx.session.hook('title',e=>{e.result='Acceptance'}); await ctx.tool.hook('execute.after',async e=>{if(e.tool==='subagent') await fetch('${endpoint}/observe',{method:'POST',body:JSON.stringify(e)})}); await fetch('${endpoint}/loaded');}}`)
  const config = {
    plugins: [join(pkg, "opencode").replace(/\\/g, "/"), join(isolated, "observer").replace(/\\/g, "/")],
    model: "scripted/scripted",
    providers: { scripted: { name: "Loopback scripted acceptance", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${endpoint}/v1`, apiKey: "local-test-only" }, models: { scripted: { capabilities: { tools: true }, limit: { context: 200000, output: 8192 } } } } },
    agents: { execute: { mode: "subagent", description: "Acceptance child" } },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }
  mkdirSync(join(isolated, "config/opencode"), { recursive: true })
  writeFileSync(join(isolated, "config/opencode/opencode.json"), JSON.stringify(config))
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((r) => probe.close(() => r()))
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(isolated, "config"), XDG_DATA_HOME: join(isolated, "data"), XDG_STATE_HOME: join(isolated, "state"), XDG_CACHE_HOME: join(isolated, "cache"), OPENCODE_CONFIG_DIR: join(isolated, "config/opencode") }
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_CONTENT
  const service = spawn(process.env.OPENCODE_BIN!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: repo, env, windowsHide: true })
  const listening = deferred<void>()
  let logs = ""
  for (const pipe of [service.stdout, service.stderr]) pipe!.on("data", (data) => { logs += data.toString(); if (/server password \S+/.test(logs)) listening.resolve() })
  const api = async (path: string, body?: unknown) => {
    const password = /server password (\S+)/.exec(logs)![1]!
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
    return response.status === 204 ? undefined : response.json() as Promise<any>
  }
  let root: string | undefined
  try {
    await Promise.race([listening.promise, new Promise((_, reject) => service.once("exit", () => reject(new Error(logs))))])
    const created = await api("/api/session", { title: "Acceptance", model: { providerID: "scripted", id: "scripted" }, location: { directory: repo } })
    root = created.data.id
    const began = Date.now()
    await api(`/api/session/${root}/prompt`, { text: "PARENT_ACCEPTANCE" })
    await bounded(loaded.promise, "plugin loading")
    await bounded(Promise.all([parentResponded.promise, ready.promise]), "parent response and native child readiness")
    await api(`/api/experimental/session/${root}/wait`, {})
    // A second real parent turn must finish while the native request is still held open.
    await api(`/api/session/${root}/prompt`, { text: "PARENT_ACCEPTANCE_REPLY_WHILE_CHILD_GATED" })
    await api(`/api/experimental/session/${root}/wait`, {})
    const context = await api(`/api/session/${root}/context`)
    expect(JSON.stringify(context)).toContain("PARENT_RESPONSIVE")
    const launch = await ack.promise
    console.log("real launch metadata:", JSON.stringify(launch.result.metadata))
    expect(launch.input.background).toBe(true)
    expect(Date.now() - began).toBeLessThan(20_000)
    const native = await ready.promise
    const host = createNodeHost()
    expect(await host.alive!(native.parent)).toBe(true)
    expect(await host.alive!(native.grandchild)).toBe(true)
    const listing = await api(`/api/session?parentID=${root}`)
    console.log("real child listing shape:", Object.keys(listing))
    const child = listing.data[0].id
    // Interrupt a real active parent execution, not an idle no-op. The child owns a different tool signal.
    await api(`/api/session/${root}/prompt`, { text: "PARENT_ACCEPTANCE_INTERRUPT_WHILE_CHILD_GATED" })
    await bounded(parentHeld.promise, "active parent execution")
    await api(`/api/session/${root}/interrupt?resume=false`, {})
    expect(await host.alive!(native.parent)).toBe(true)
    const cancelledAt = Date.now()
    await api(`/api/session/${child}/interrupt?resume=false`, {})
    await bounded(closed.promise, "native process exit")
    expect(Date.now() - cancelledAt).toBeLessThan(5000)
    expect(await host.alive!(native.parent)).toBe(false)
    expect(await host.alive!(native.grandchild)).toBe(false)
    await api(`/api/session/${child}/interrupt?resume=false`, {})
    console.log(JSON.stringify({ parentResponsiveMs: cancelledAt - began, childCancellationMs: Date.now() - cancelledAt, installedPackage: !!process.env.JTASKS_E2E_PACKAGE, paidModelCalls: 0 }))
  } catch (error) { console.error(logs.replace(/server password \S+/g, "server password [redacted]")); const plugins = await api("/api/plugin").catch(() => undefined); console.error(plugins?.data?.filter((p: any) => p.state.status === "failed")); throw error }
  finally {
    if (root) {
      const children = await api(`/api/session?parentID=${root}`).catch(() => undefined)
      for (const child of children?.data ?? []) await api(`/api/session/${child.id}/interrupt?resume=false`, {}).catch(() => undefined)
      await api(`/api/session/${root}/interrupt?resume=false`, {}).catch(() => undefined)
    }
    service.kill()
    await new Promise<void>((r) => { if (service.exitCode !== null) r(); else service.once("exit", () => r()) })
    model.stop(true)
    cleanupTemp()
  }
}, 90_000)
