// Run binding per root session (section 8): the root session holds the run; child sessions (subagents) inherit it
// through their chain of parents. A subagent session that started a task is bound to that task, for the guard.

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<void>
  remove(key: string): Promise<void>
}

export interface SessionsLike {
  get(input: { sessionID: string }): Promise<{ id?: string; parentID?: string; location?: { directory?: string } }>
}

export interface RunBinding {
  run: string
  /** The repository root of the run. */
  root: string
}

export interface TaskBinding {
  run: string
  task: string
}

export class Bindings {
  private readonly parents = new Map<string, string | null>()
  private readonly dirs = new Map<string, string | undefined>()

  constructor(
    private readonly storage: StorageLike,
    private readonly sessions: SessionsLike,
  ) {}

  private async info(sessionID: string) {
    if (!this.parents.has(sessionID)) {
      try {
        const s = await this.sessions.get({ sessionID })
        this.parents.set(sessionID, s.parentID ?? null)
        this.dirs.set(sessionID, s.location?.directory)
      } catch {
        this.parents.set(sessionID, null)
        this.dirs.set(sessionID, undefined)
      }
    }
    return { parent: this.parents.get(sessionID) ?? null, directory: this.dirs.get(sessionID) }
  }

  /** The root of the session's family (itself, for a root session). */
  async root(sessionID: string): Promise<string> {
    let id = sessionID
    for (let i = 0; i < 32; i++) {
      const { parent } = await this.info(id)
      if (!parent) return id
      id = parent
    }
    return id
  }

  async directory(sessionID: string): Promise<string | undefined> {
    return (await this.info(sessionID)).directory
  }

  /** True when the session is a child (a subagent's session). */
  async isChild(sessionID: string): Promise<boolean> {
    return (await this.root(sessionID)) !== sessionID
  }

  async run(sessionID: string): Promise<RunBinding | undefined> {
    const value = await this.storage.get(`binding/${await this.root(sessionID)}`)
    return value && typeof value === "object" ? (value as RunBinding) : undefined
  }

  async bind(sessionID: string, binding: RunBinding): Promise<void> {
    await this.storage.set(`binding/${await this.root(sessionID)}`, binding as never)
  }

  async task(sessionID: string): Promise<TaskBinding | undefined> {
    const value = await this.storage.get(`task/${sessionID}`)
    return value && typeof value === "object" ? (value as TaskBinding) : undefined
  }

  async setTask(sessionID: string, binding: TaskBinding | undefined): Promise<void> {
    if (binding) await this.storage.set(`task/${sessionID}`, binding as never)
    else await this.storage.remove(`task/${sessionID}`)
  }
}
