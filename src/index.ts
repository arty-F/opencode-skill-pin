import { Plugin } from "@opencode/plugin"
import type { Request } from "./types.js"
import { confirmation, record } from "./types.js"
import { Store } from "./store.js"
import { RecentJournal, type AdmittedUser } from "./recent.js"
import { denied, renderSkill } from "./skills.js"

export default Plugin.define({
  id: "opencode-skill-pin",
  async setup(ctx) {
    const store = new Store(ctx.storage)
    const journal = new RecentJournal(ctx.storage)
    // Serialize same-session journal updates, not independent sessions or individual tools.
    const pending = new Map<string, Promise<void>>()
    const serialized = (sessionID: string, work: () => Promise<void>) => {
      const next = (pending.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(work)
      pending.set(sessionID, next)
      return next.finally(() => {
        if (pending.get(sessionID) === next) pending.delete(sessionID)
      })
    }

    // Pinning depends only on a completed skill call. The result shape changes between
    // OpenCode releases, so it is used only to remove the duplicate copy from history.
    let warned = false
    await ctx.tool.hook("execute.after", async (event) => {
      if (
        event.tool !== "skill" ||
        event.status !== "completed" ||
        !record(event.input) ||
        typeof event.input.id !== "string"
      )
        return
      await store.activate(event.sessionID, event.input.id, "tool")
      const text = confirmation(event.input.id)
      const loaded = contentText(event.result.content)
      const output = replaceText(event.result.output, loaded, text)
      event.result = { ...event.result, content: text, output }
      if (!warned && (loaded === undefined || JSON.stringify(output ?? null).includes(loaded))) {
        warned = true
        console.warn(
          "opencode-skill-pin: unrecognized skill tool result; the skill is pinned, but its full text may also remain in history.",
        )
      }
    })

    // Explicit @skill prompts can be absorbed into an automatic checkpoint's retained tail
    // before any request shows them. Admission events carry the resolved skills, so the pin
    // and the checkpoint cleanup never depend on seeing that message in history.
    const owned = new Set<string>()
    const admitted = new Map<string, { sessionID: string; message: AdmittedUser }>()
    await ctx.session.hook("prompt", (event) => {
      if (event.prompt.skills?.length) owned.add(event.messageID)
    })
    const controller = new AbortController()
    const events = (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled"],
        signal: controller.signal,
      })) {
        const id = event.data.inboxID
        if (!owned.delete(id) && !admitted.has(id)) continue
        if (event.type === "session.inbox.enqueued") {
          const item = event.data.item
          if (item.type === "user" && item.payload.skills?.length)
            admitted.set(id, {
              sessionID: event.data.sessionID,
              message: {
                id,
                type: "user",
                text: item.payload.text,
                skills: item.payload.skills,
                files: item.payload.files,
              },
            })
          continue
        }
        const entry = admitted.get(id)
        admitted.delete(id)
        if (event.type !== "session.inbox.delivered" || !entry) continue
        void serialized(entry.sessionID, async () => {
          for (const skill of entry.message.skills ?? [])
            await store.activate(entry.sessionID, skill.id, "user")
          await journal.admit(entry.sessionID, entry.message)
        }).catch((error) => console.error("opencode-skill-pin: failed to record an admitted @skill", error))
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("opencode-skill-pin: admission events stopped", error)
    })

    const prepare = (event: Request, inject: boolean) =>
      serialized(event.sessionID, async () => {
        const history = await ctx.session.context({ sessionID: event.sessionID })
        const source = new Map(history.map((message) => [message.id, message]))
        const spans = await journal.load(event.sessionID)

        for (const message of history) {
          if (message.type === "user") {
            for (const skill of message.skills ?? []) await store.activate(event.sessionID, skill.id, "user")
          } else if (message.type === "skill") {
            await store.activate(event.sessionID, message.skill, "user")
          }
        }

        event.messages = event.messages.map((message) => {
          const original = message.id ? source.get(message.id) : undefined
          if (!original) return message
          if (original.type === "user") {
            const loaded = (original.skills ?? []).filter((skill) => skill.text !== undefined)
            return mapText(message, (text, index) => {
              const skill = loaded[index]
              return skill && text === skill.text ? confirmation(skill.id) : text
            })
          }
          if (original.type === "skill") {
            return mapText(message, (text) => (text === original.text ? confirmation(original.skill) : text))
          }
          if (
            original.type === "compaction" &&
            original.status === "completed" &&
            typeof original.metadata?.recent === "string"
          ) {
            const recent = original.metadata.recent
            const cleaned = journal.clean(recent, original.metadata.keepID, spans)
            if (cleaned === recent) return message
            const suffix = `<recent-context>\n${recent}\n</recent-context>\n</conversation-checkpoint>`
            return mapText(message, (text) =>
              text.endsWith(suffix)
                ? text.slice(0, -suffix.length) +
                  `<recent-context>\n${cleaned}\n</recent-context>\n</conversation-checkpoint>`
                : text,
            )
          }
          return message
        })

        await journal.remember(event.sessionID, history, spans)
        if (!inject) return
        const active = await store.active(event.sessionID)
        if (!active.size) return
        const [catalog, agent, session] = await Promise.all([
          ctx.skill.list(),
          ctx.agent.get({ agentID: event.agent }),
          ctx.session.get({ sessionID: event.sessionID }),
        ])
        const rules = [...agent.data.permissions, ...(session.permissions ?? [])]
        const blocks: string[] = []
        for (const skill of [...catalog.data].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
          const activation = active.get(skill.id)
          if (!activation || (!activation.explicit && denied(skill.id, rules))) continue
          blocks.push(await renderSkill(skill))
        }
        if (blocks.length)
          event.system.push({
            type: "text",
            text: [
              "<pinned_skills>",
              "These skills are already activated for this session. Follow their full instructions below. Reload only to explicitly reactivate a skill; compaction does not remove these instructions.",
              ...blocks,
              "</pinned_skills>",
            ].join("\n\n"),
          })
      })

    await ctx.session.hook("context", (event) => prepare(event, true))
    await ctx.session.hook("generate", (event) => prepare(event, true))
    // Capture activations before a checkpoint can hide their original messages. Summary
    // requests need confirmations, not another copy of the pinned instruction bodies.
    await ctx.session.hook("compaction", (event) => prepare(event, false))

    return async () => {
      controller.abort()
      await events
    }
  },
})

function mapText<Message extends Request["messages"][number]>(
  message: Message,
  replace: (text: string, index: number) => string,
): Message {
  return {
    ...message,
    content: message.content.map((part, index) =>
      part.type === "text" ? { ...part, text: replace(part.text, index) } : part,
    ),
  } as Message
}

function contentText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return
  const parts = content.filter(
    (part) => record(part) && part.type === "text" && typeof part.text === "string",
  )
  return parts.length ? parts.map((part) => part.text).join("\n") : undefined
}

function replaceText(output: unknown, loaded: string | undefined, text: string) {
  if (loaded === undefined) return output
  if (output === loaded) return text
  if (!record(output)) return output
  return Object.fromEntries(
    Object.entries(output).map(([key, value]) => [key, value === loaded ? text : value]),
  )
}
