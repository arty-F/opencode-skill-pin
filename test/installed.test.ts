import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { mockProvider, historyText, systemText } from "./mock-provider.js"

const executable = process.env.SKILL_PIN_OPENCODE_BIN

async function command(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 180000 })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}):\n${stdout}\n${stderr}`)
  return stdout
}

for (const install of ["packed", "git"] as const)
  test.skipIf(!executable)(
    `${install} plugin on the installed CLI survives two compactions and a real process restart`,
    async () => {
      const version = await command([executable!, "--version"], process.cwd())
      expect(version.trim()).toBe("opencode v2.2.5")
      const root = await mkdtemp(path.join(process.env.SKILL_PIN_TEST_ROOT!, "installed-"))
      const workspace = path.join(root, "workspace")
      const config = path.join(root, "config")
      const consumer = path.join(root, "consumer")
      await Promise.all([mkdir(workspace), mkdir(config), mkdir(consumer)])
      let plugin: string
      if (install === "packed") {
        await command(
          [process.execPath, "pm", "pack", "--ignore-scripts", "--destination", root],
          process.cwd(),
        )
        plugin = path.join(consumer, "node_modules", "opencode-skill-pin")
        await mkdir(plugin, { recursive: true })
        await command(
          [
            "tar",
            "-xzf",
            path.join(root, "opencode-skill-pin-0.1.0.tgz"),
            "--strip-components=1",
            "-C",
            plugin,
          ],
          root,
        )
        // The tarball test reuses locked dependencies. The Git variant below exercises
        // OpenCode's real package installer, including dependency installation.
        await symlink(path.resolve("node_modules"), path.join(plugin, "node_modules"), "junction")
      } else {
        const repository = path.join(root, "git-source")
        await mkdir(repository)
        // Model a fresh repository that has the same runtime payload and source files,
        // with no node_modules or developer cache and no build on the consumer side.
        // This also catches lifecycle names (including "build") that make 2.2.5's
        // bundled pacote attempt to spawn its unavailable npm CLI for Git preparation.
        for (const file of [
          ".gitattributes",
          "package.json",
          "dist",
          "src",
          "README.md",
          "LICENSE",
          "NOTICE",
        ]) {
          await cp(path.resolve(file), path.join(repository, file), { recursive: true })
        }
        await command(["git", "init", "-b", "main"], repository)
        await command(["git", "add", "."], repository)
        await command(
          [
            "git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "Git installation fixture",
          ],
          repository,
        )
        const revision = (await command(["git", "rev-parse", "HEAD"], repository)).trim()
        plugin = `git+${pathToFileURL(repository).href}#${revision}`
      }
      const fixture = path.join(workspace, ".opencode", "plugins", "fixture")
      await mkdir(fixture, { recursive: true })
      await writeFile(
        path.join(fixture, "package.json"),
        JSON.stringify({ name: "installed-fixture", type: "module", exports: "./index.js" }),
      )
      await writeFile(
        path.join(fixture, "index.js"),
        `
export default {id: "installed-fixture", async setup(ctx) {
  await ctx.session.hook("title", e => { e.result = "Fixture"; });
  await ctx.session.hook("model.request", e => { e.headers["x-skill-pin-kind"] = e.kind; });
}};
`,
      )
      const body =
        "INSTALLED_SKILL_BEGIN\nPreserve every line across compaction and process restart.\nINSTALLED_SKILL_END"
      const manualBody =
        "INSTALLED_MANUAL_BEGIN\nKeep the explicitly attached instructions.\nINSTALLED_MANUAL_END"
      for (const [id, text] of [
        ["installed", body],
        ["manual", manualBody],
      ]) {
        const directory = path.join(workspace, ".opencode", "skills", id)
        await mkdir(directory, { recursive: true })
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${id}\ndescription: Installed test fixture.\n---\n${text}\n`,
        )
      }
      await writeFile(path.join(workspace, "AGENTS.md"), "INSTALLED_AGENTS_NATIVE_INSTRUCTION")
      const provider = mockProvider()
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugins: install === "git" ? [fixture] : [fixture, plugin],
          model: "skill-pin-mock/fixture",
          compaction: { auto: false, keep: { tokens: 15000 } },
          providers: {
            "skill-pin-mock": {
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: provider.url, apiKey: "local-fixture-only" },
              models: { fixture: { name: "Fixture", limit: { context: 128000, output: 4096 } } },
            },
          },
          policies: [
            { action: "provider.use", resource: "*", effect: "deny" },
            { action: "provider.use", resource: "skill-pin-mock", effect: "allow" },
          ],
        }),
      )
      const env = {
        ...process.env,
        OPENCODE_DB: path.join(root, "opencode.db"),
        OPENCODE_TEST_HOME: root,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_CONFIG: "",
        OPENCODE_PASSWORD: "skill-pin-fixture-only",
        OPENCODE_SERVER_PASSWORD: "skill-pin-fixture-only",
        OPENCODE_DISABLE_FREE_MODELS: "1",
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      }
      const start = async () => {
        const child = Bun.spawn([executable!, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
          env,
        })
        let logs = ""
        let resolveURL!: (url: string) => void
        let rejectURL!: (reason: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
          resolveURL = resolve
          rejectURL = reject
        })
        const consume = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader()
          const decoder = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            logs += decoder.decode(value, { stream: true })
            const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
            if (url) resolveURL(url)
          }
        }
        const output = Promise.all([consume(child.stdout), consume(child.stderr)])
        void child.exited.then((code) => rejectURL(new Error(`Private server exited (${code}): ${logs}`)))
        const timeout = setTimeout(() => {
          child.kill()
          rejectURL(new Error(`Private server did not start: ${logs}`))
        }, 30000)
        try {
          const url = await ready
          return {
            client: OpenCode.make({
              baseUrl: url,
              headers: {
                authorization: `Basic ${Buffer.from("opencode:skill-pin-fixture-only").toString("base64")}`,
              },
            }),
            async stop() {
              child.kill()
              await child.exited
              await output
            },
          }
        } catch (error) {
          child.kill()
          await child.exited
          await output
          throw error
        } finally {
          clearTimeout(timeout)
        }
      }
      let running: Awaited<ReturnType<typeof start>> | undefined
      try {
        if (install === "git") {
          // plugin add uses only this fixture's config/cache. It installs via the same
          // Git package path as github:owner/repository, with lifecycle scripts disabled.
          await command([executable!, "plugin", "add", plugin], workspace, env)
          const configured = JSON.parse(await readFile(path.join(config, "opencode.json"), "utf8"))
          expect(configured.plugins).toContain(plugin)
          const manifests = await Array.fromAsync(
            new Bun.Glob("**/node_modules/opencode-skill-pin/package.json").scan({
              cwd: path.join(root, "cache"),
              absolute: true,
            }),
          )
          expect(manifests).toHaveLength(1)
          const installedDirectory = path.dirname(manifests[0])
          expect(await readFile(path.join(installedDirectory, "dist", "index.js"), "utf8")).toBe(
            await readFile(path.resolve("dist", "index.js"), "utf8"),
          )
          for (const excluded of [
            "src/index.ts",
            "test/installed.test.ts",
            ".test-artifacts/live-demo/run.ts",
          ]) {
            expect(await Bun.file(path.join(installedDirectory, excluded)).exists()).toBe(false)
          }
        }
        running = await start()
        let client = running.client
        const session = await client.session.create({
          location: { directory: workspace },
          title: "Installed fixture",
          model: { providerID: "skill-pin-mock", id: "fixture" },
        })
        const prompt = async (text: string, skills?: { id: string }[]) => {
          await client.session.prompt({ sessionID: session.id, text, skills })
          await client.experimental.session.wait({ sessionID: session.id })
          const messages = await client.session.context({ sessionID: session.id })
          const failed = messages.findLast((message) => message.type === "assistant" && message.error)
          if (failed) throw new Error(JSON.stringify(failed))
        }
        provider.enqueue(session.id, { calls: [{ name: "skill", input: { id: "installed" } }] })
        await prompt("Activate the installed skill.")
        const plugins = await client.plugin.list({ location: { directory: workspace } })
        if (!plugins.data.some((plugin) => plugin.id === "installed-fixture"))
          throw new Error(
            `Fixture plugin failed: ${JSON.stringify(plugins.data.filter((plugin) => !plugin.id))}`,
          )
        expect(plugins.data.map((plugin) => plugin.id)).toContain("installed-fixture")
        const installed = plugins.data.find((plugin) => plugin.id === "opencode-skill-pin")
        expect(installed?.source.type).toBe(install === "git" ? "package" : "local")
        expect(installed?.state.status).toBe("active")
        if (installed?.source.type === "package") expect(installed.source.target).toBe(plugin)
        expect(systemText(provider.primary(session.id).at(-1)!)).toContain(body)
        expect(systemText(provider.primary(session.id).at(-1)!)).toContain("<pinned_skills>")
        await prompt("Also attach @manual.", [{ id: "manual" }])
        for (let i = 0; i < 2; i++) {
          await client.session.compact({ sessionID: session.id })
          await client.experimental.session.wait({ sessionID: session.id })
          const checkpoint = (await client.session.context({ sessionID: session.id })).findLast(
            (message) => message.type === "compaction",
          )
          if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed")
            throw new Error(`Installed compaction failed: ${JSON.stringify(checkpoint)}`)
          await prompt(`Continue after compact ${i}.`)
          const request = provider.primary(session.id).at(-1)!
          expect(systemText(request).split(body)).toHaveLength(2)
          expect(systemText(request).split(manualBody)).toHaveLength(2)
          expect(historyText(request)).not.toContain(body)
          expect(historyText(request)).not.toContain(manualBody)
        }
        expect(provider.requests.filter((request) => request.kind === "compaction")).toHaveLength(2)
        await running.stop()
        running = undefined
        running = await start()
        client = running.client
        await prompt("Resume after a real process restart.")
        const request = provider.primary(session.id).at(-1)!
        expect(systemText(request)).toContain(body)
        expect(systemText(request)).toContain(manualBody)
        expect(systemText(request).split("INSTALLED_AGENTS_NATIVE_INSTRUCTION")).toHaveLength(2)
        expect(historyText(request)).not.toContain(body)
        expect(historyText(request)).not.toContain(manualBody)
      } finally {
        await running?.stop()
        provider.stop()
      }
    },
    300000,
  )
