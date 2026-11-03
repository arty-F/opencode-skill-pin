import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { Model, Plugin, Provider } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import skillPin from "../src/index.js"
import { mockProvider } from "./mock-provider.js"

export const ALPHA =
  "ALPHA_RULE_BEGIN\nAlways preserve the complete alpha contract.\nαβγ — do not abbreviate this rule.\nALPHA_RULE_END"
export const BETA = "BETA_RULE_BEGIN\nUse the beta checklist exactly as written.\nBETA_RULE_END"
export const AGENTS = "FIXTURE_AGENTS_GUIDANCE: keep this project instruction in the native system context."

export async function harness(options: { auto?: boolean } = {}) {
  const root = await mkdtemp(path.join(process.env.SKILL_PIN_TEST_ROOT!, "case-"))
  const workspace = path.join(root, "workspace")
  const config = path.join(root, "config")
  await Promise.all([mkdir(workspace), mkdir(config)])
  await writeFile(path.join(workspace, "AGENTS.md"), AGENTS)
  const provider = mockProvider()
  const skillFile = (id: string) => path.join(workspace, ".opencode", "skills", id, "SKILL.md")
  const writeSkill = async (id: string, body: string, extra = "") => {
    await mkdir(path.dirname(skillFile(id)), { recursive: true })
    await writeFile(
      skillFile(id),
      `---\nname: ${id.toUpperCase()}\ndescription: Synthetic ${id} fixture instructions.\n${extra}---\n${body}\n`,
    )
  }
  await writeSkill("alpha", ALPHA)
  await writeSkill("beta", BETA)
  await writeFile(
    path.join(path.dirname(skillFile("alpha")), "reference.txt"),
    "SUPPORTING_FILE_CONTENT_MUST_NOT_BE_LOADED",
  )
  let context: Plugin.Context
  let onTick: (() => Promise<void>) | undefined
  const fixture = Plugin.define({
    id: "skill-pin-test-fixture",
    async setup(ctx) {
      context = ctx
      const providerID = Provider.ID.make("skill-pin-mock")
      const id = Model.ID.make("fixture")
      await ctx.provider.transform((editor) =>
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: provider.url, apiKey: "local-fixture-only" },
          },
          models: [{ ...Model.Info.default(providerID, id), limit: { context: 128000, output: 4096 } }],
        }),
      )
      await ctx.agent.transform((editor) =>
        editor.update("build", (agent) => {
          agent.model = { providerID, id }
        }),
      )
      await ctx.session.hook("title", (event) => {
        event.result = "Fixture"
      })
      await ctx.session.hook("model.request", (event) => {
        event.headers["x-skill-pin-kind"] = event.kind
      })
      await ctx.tool.transform((editor) =>
        editor.add({
          name: "fixture_tick",
          description: "Advance the deterministic fixture.",
          options: { codemode: false },
          input: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            await onTick?.()
            return { content: "Tick complete." }
          },
        }),
      )
    },
  })
  const boot = () =>
    OpenCode.create({
      app: { version: "2.2.5" },
      database: { path: path.join(root, "opencode.db") },
      config: {
        directory: config,
        claude: false,
        content: JSON.stringify({ compaction: { auto: options.auto ?? false, keep: { tokens: 15000 } } }),
      },
      models: { fetch: false, snapshot: false },
      fs: { fff: false },
      plugins: [fixture, skillPin],
    })
  let host = await boot()
  const create = () =>
    host.sessions.create({
      location: { directory: workspace },
      agent: "build",
      title: "Fixture",
      model: { providerID: "skill-pin-mock", id: "fixture" },
    })
  const wait = async (sessionID: string) => {
    await host.experimental.session.wait({ sessionID })
    const messages = await host.sessions.context({ sessionID })
    const failure = messages.findLast((message) => message.type === "assistant" && message.error)
    if (failure?.type === "assistant") throw new Error(JSON.stringify(failure.error))
  }
  return {
    root,
    workspace,
    config,
    provider,
    skillFile,
    writeSkill,
    create,
    wait,
    get host() {
      return host
    },
    get ctx() {
      return context!
    },
    tick(callback: () => Promise<void>) {
      onTick = callback
    },
    async prompt(sessionID: string, text: string, skills?: { id: string }[]) {
      await host.sessions.prompt({ sessionID, text, skills })
      await wait(sessionID)
    },
    async compact(sessionID: string) {
      await host.sessions.compact({ sessionID })
      await wait(sessionID)
      const messages = await host.sessions.context({ sessionID })
      if (!messages.some((message) => message.type === "compaction" && message.status === "completed"))
        throw new Error(`Compaction did not complete: ${JSON.stringify(messages)}`)
    },
    async restart() {
      await host.close()
      host = await boot()
    },
    async updateSkill(id: string, body: string, change = () => writeSkill(id, body)) {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error("Skill watcher did not update within 15 seconds")),
        15000,
      )
      const updated = (async () => {
        for await (const _event of context!.event.subscribe({
          types: ["skill.updated"],
          signal: controller.signal,
        })) {
          if (
            (await context!.skill.list()).data.find((skill) => skill.id === id)?.content.trim() ===
            body.trim()
          )
            return
        }
        throw new Error("Skill watcher ended before the update")
      })()
      try {
        await change()
        await updated
      } finally {
        clearTimeout(timeout)
        controller.abort()
      }
    },
    async close() {
      await host.close()
      provider.stop()
    },
  }
}
