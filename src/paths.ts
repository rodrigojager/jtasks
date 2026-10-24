// Pure path helpers. Paths inside the core always use `/`; Windows accepts it everywhere we pass a path.

export function slash(path: string): string {
  return path.replace(/\\/g, "/")
}

export function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\")
}

/** Resolves `.` and `..` segments; keeps a drive letter or a leading `/`. */
export function normalize(path: string): string {
  const p = slash(path)
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? ""
  const rest = p.slice(drive.length)
  const rooted = rest.startsWith("/")
  const out: string[] = []
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
      else if (!rooted) out.push("..")
      continue
    }
    out.push(part)
  }
  const body = out.join("/")
  if (rooted) return `${drive}/${body}`
  return drive + (body || (drive ? "" : "."))
}

export function join(...parts: string[]): string {
  let acc = ""
  for (const part of parts) {
    if (!part) continue
    if (acc === "" || isAbsolute(part)) acc = part
    else acc = `${acc.replace(/[\\/]+$/, "")}/${part}`
  }
  return normalize(acc || ".")
}

export function dirname(path: string): string {
  const p = slash(path).replace(/\/+$/, "")
  const cut = p.lastIndexOf("/")
  if (cut < 0) return "."
  if (cut === 0) return "/"
  if (/^[A-Za-z]:$/.test(p.slice(0, cut))) return `${p.slice(0, cut)}/`
  return p.slice(0, cut)
}

export function basename(path: string): string {
  const p = slash(path).replace(/\/+$/, "")
  return p.slice(p.lastIndexOf("/") + 1)
}

/** `child` relative to `parent`, or `undefined` when it is not inside it. Compared case-insensitively on request. */
export function relativeInside(parent: string, child: string, caseInsensitive: boolean): string | undefined {
  const a = normalize(parent).replace(/\/+$/, "")
  const b = normalize(child)
  const fa = caseInsensitive ? a.toLowerCase() : a
  const fb = caseInsensitive ? b.toLowerCase() : b
  if (fa === fb) return ""
  if (fb.startsWith(`${fa}/`)) return b.slice(a.length + 1)
  return undefined
}

/** Platforms where the file system is case-insensitive by default (as jlock treats them). */
export function caseInsensitive(platform: string): boolean {
  return platform === "win32" || platform === "darwin"
}
