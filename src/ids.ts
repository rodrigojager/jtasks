// Run ids (`<slug>-<aammdd>-<4 random>`) and slugs for file names.

export function slugify(text: string, max = 24): string {
  const s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const cut = s.slice(0, max).replace(/-+$/, "")
  return cut || "run"
}

export function yymmdd(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(date.getFullYear() % 100)}${p(date.getMonth() + 1)}${p(date.getDate())}`
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

export function runId(slug: string, date: Date, random: () => number): string {
  let tail = ""
  for (let i = 0; i < 4; i++) tail += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return `${slugify(slug)}-${yymmdd(date)}-${tail}`
}

/** The ticket number of a task: the digits of `T04` (`04`), or its position. */
export function ticketNumber(id: string, index: number): string {
  const m = /^[A-Za-z]*0*(\d+)$/.exec(id)
  const n = m ? Number(m[1]) : index + 1
  return String(n).padStart(2, "0")
}
