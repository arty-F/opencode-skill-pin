import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"

export type Context = Plugin.Context
export type Request = SessionContext
export type History = Awaited<ReturnType<Context["session"]["context"]>>
export type StoredMessage = History[number]
export type SkillInfo = Awaited<ReturnType<Context["skill"]["list"]>>["data"][number]

export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const confirmation = (id: string) =>
  `Skill ${JSON.stringify(id)} activated. Its current instructions are pinned in the session's system context.`
