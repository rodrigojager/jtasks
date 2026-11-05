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

/** A word that can be a task or run id: letters, digits, `.`, `_`, `-`; never a placeholder (`<id>`, `{id}`, `...`). */
const ID_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The first value of `--<name>` in a prompt that can be an id: quotes, backticks and brackets around it, and the
 * punctuation of the sentence after it, are not part of it. A prompt that only documents the commands
 * (`jtasks exec --task <id> -- <command>`) names no task.
 */
const OPTION = { run: /--run(?:=|\s+)(\S+)/g, task: /--task(?:=|\s+)(\S+)/g }

function optionId(prompt: string, name: keyof typeof OPTION): string | undefined {
  for (const m of prompt.matchAll(OPTION[name])) {
    const word = m[1]!.replace(/^[`'"(\[]+/, "").replace(/[`'"),.;:!?\]]+$/, "")
    if (ID_WORD.test(word)) return word
  }
  return undefined
}

/** The run and the task a subagent's prompt names with `--run <id>` and `--task <id>` (section 13). */
export function taskOfPrompt(prompt: string): { run?: string; task?: string } {
  return { run: optionId(prompt, "run"), task: optionId(prompt, "task") }
}
