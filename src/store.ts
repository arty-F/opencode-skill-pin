import type { Context } from "./types.js"
import { record } from "./types.js"

export class Store {
  constructor(private readonly storage: Context["storage"]) {}

  private prefix(sessionID: string) {
    return `v1/session/${encodeURIComponent(sessionID)}/active/`
  }

  async activate(sessionID: string, id: string, source: "tool" | "user") {
    // Independent, idempotent keys avoid read/modify/write races between parallel calls.
    // A later tool activation must not erase an explicit user activation.
    await this.storage.set(`${this.prefix(sessionID)}${source}/${encodeURIComponent(id)}`, { id, source })
  }

  async active(sessionID: string): Promise<Map<string, { explicit: boolean }>> {
    const result = new Map<string, { explicit: boolean }>()
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: this.prefix(sessionID), after, limit: 100 })
      for (const { value } of page.entries) {
        if (!record(value) || typeof value.id !== "string") continue
        result.set(value.id, { explicit: value.source === "user" || result.get(value.id)?.explicit === true })
      }
      after = page.next
    } while (after)
    return result
  }
}
