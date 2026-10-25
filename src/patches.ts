// A task's uncommitted edits kept aside (plan rev. 5.6): when a task gives a file back (`yield`) or is released, the
// edit of each file is saved as a patch of the run (`patches/<task>/<n>-<file>.patch`, the diff against HEAD, or the
// whole content of a new file), the file goes back to HEAD, and the patch is reapplied with `git apply --3way` when
// the file is the task's again. Names are pure functions; git runs through the host, from the repository root.

import { git, status as gitStatus } from "./git.ts"
import type { Host } from "./host.ts"
import { basename, dirname, join } from "./paths.ts"
import type { SavedPatch } from "./schema.ts"

/** `src/a b.ts` → `src__a_b.ts`: one file name, the same on every system. */
export function escapePath(file: string): string {
  return file.replace(/[\\/]+/g, "__").replace(/[^A-Za-z0-9._-]/g, "_")
}

/** `patches/T04/003-src__a.ts.patch`, relative to the run folder. */
export function patchRel(task: string, n: number, file: string): string {
  return `patches/${task}/${String(n).padStart(3, "0")}-${escapePath(file)}.patch`
}

/** Where a patch goes once reapplied cleanly: `patches/T04/applied/003-….patch`. */
export function appliedPath(patch: string): string {
  return join(dirname(patch), "applied", basename(patch))
}

/** The next free number among the task's patches (saved ones and the ones in the run folder already). */
export async function nextPatchNumber(host: Host, runDir: string, task: string, saved: SavedPatch[] = []): Promise<number> {
  const dir = join(runDir, "patches", task)
  const names = [...(await host.list(dir)).map((e) => e.name), ...(await host.list(join(dir, "applied"))).map((e) => e.name), ...saved.map((p) => basename(p.patch))]
  return names.reduce((m, n) => Math.max(m, Number(/^(\d+)-/.exec(n)?.[1] ?? 0)), 0) + 1
}

/** Whether HEAD has the file. */
export async function inHead(host: Host, root: string, file: string): Promise<boolean> {
  return (await git(host, root, ["cat-file", "-e", `HEAD:${file}`])).code === 0
}

/**
 * Writes the file's uncommitted edit to `patch` (absolute): the diff against HEAD, or the whole file when HEAD does
 * not have it. git writes the file itself (`--output`), so binary and non-UTF-8 content survive. `false` when there
 * is nothing to save (the file equals HEAD).
 */
export async function writePatch(host: Host, root: string, file: string, patch: string): Promise<boolean> {
  await host.mkdir(dirname(patch))
  const tracked = await inHead(host, root, file)
  if (!tracked && !(await host.stat(join(root, file)))) return false
  const argv = tracked
    ? ["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-color", `--output=${patch}`, "HEAD", "--", file]
    : ["diff", "--binary", "--no-index", "--no-ext-diff", "--no-color", `--output=${patch}`, "--", "/dev/null", file]
  const r = await git(host, root, argv)
  // --no-index answers 1 when the files differ, which is always the case here.
  if (r.code !== 0 && !(r.code === 1 && !tracked)) throw new Error(`git diff ${file}: ${(r.stderr || r.stdout).trim()}`)
  const text = await host.readText(patch)
  if (!text?.trim()) {
    await host.remove(patch).catch(() => {})
    return false
  }
  return true
}

/** The file back to HEAD: checked out from HEAD, or deleted (and out of the index) when HEAD does not have it. */
export async function restoreFile(host: Host, root: string, file: string): Promise<void> {
  if (await inHead(host, root, file)) {
    const r = await git(host, root, ["checkout", "-q", "HEAD", "--", file])
    if (r.code !== 0) throw new Error(`git checkout ${file}: ${(r.stderr || r.stdout).trim()}`)
    return
  }
  await git(host, root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", file])
  await host.remove(join(root, file)).catch(() => {})
}

export type ApplyResult = "applied" | "already" | "conflict" | "failed"

/**
 * Reapplies a saved patch over the current HEAD with `git apply --3way`: `applied` (clean), `already` (the edit is
 * in the tree already), `conflict` (the file has conflict markers) or `failed` (nothing changed). The index is put
 * back for the patch's files afterwards (`--3way` writes it), so the task's commit takes them like any other edit.
 */
export async function applyPatch(host: Host, root: string, patch: string, files: string[]): Promise<{ result: ApplyResult; message: string }> {
  if ((await git(host, root, ["apply", "-R", "--check", patch])).code === 0) return { result: "already", message: "" }
  const r = await git(host, root, ["apply", "--3way", "--whitespace=nowarn", patch])
  const unmerged = (await gitStatus(host, root)).some((e) => files.includes(e.path) && /U|AA|DD/.test(e.code))
  await git(host, root, ["reset", "-q", "--", ...files])
  const message = `${r.stderr}${r.stdout}`.trim()
  if (r.code === 0) return { result: "applied", message }
  return { result: unmerged ? "conflict" : "failed", message }
}

/** Takes a reapplied edit out again (`git apply -R`, the working tree only); `false` when it does not apply. */
export async function reversePatch(host: Host, root: string, patch: string): Promise<boolean> {
  return (await git(host, root, ["apply", "-R", "--whitespace=nowarn", patch])).code === 0
}
