import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Skill } from "@opencode/plugin"
import { harness, ALPHA, BETA, AGENTS } from "./harness.js"
import { historyText, systemText, type Captured } from "./mock-provider.js"

const count = (text: string, value: string) => text.split(value).length - 1
function pinned(request: Captured, body = ALPHA) {
  expect(count(systemText(request), body)).toBe(1)
  expect(historyText(request)).not.toContain(body)
  expect(count(systemText(request), AGENTS)).toBe(1)
  expect(systemText(request).indexOf(AGENTS)).toBeLessThan(systemText(request).indexOf("<pinned_skills>"))
}

function validToolPairs(request: Captured) {
  const calls = new Set(
    request.body.messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id)),
  )
  const results = request.body.messages.filter((message) => message.role === "tool")
  for (const result of results) expect(calls.has(result.tool_call_id!)).toBe(true)
  expect(new Set(results.map((result) => result.tool_call_id)).size).toBe(results.length)
}

test("standard skill activation pins the full text on the tool continuation", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    h.provider.enqueue(session.id, { calls: [{ name: "skill", input: { id: "alpha" } }] })
    await h.prompt(session.id, "Use alpha.")
    const requests = h.provider.primary(session.id)
    expect(requests.length).toBe(2)
    expect(systemText(requests[0])).not.toContain(ALPHA)
    expect(systemText(requests[1])).toContain(ALPHA)
    expect(systemText(requests[1])).toContain(AGENTS)
    expect(historyText(requests[1])).not.toContain(ALPHA)
    expect(historyText(requests[1])).toContain('Skill "alpha" activated.')
    pinned(requests[1])
    validToolPairs(requests[1])
    expect(systemText(requests[1])).toContain("reference.txt")
    expect(systemText(requests[1])).toContain(h.skillFile("alpha").replace(/[\\/]SKILL.md$/, ""))
    expect(JSON.stringify(requests[1].body)).not.toContain("SUPPORTING_FILE_CONTENT_MUST_NOT_BE_LOADED")
  } finally {
    await h.close()
  }
})

test("parallel/repeated activations are deduplicated through a long tool-only continuation", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    h.provider.enqueue(
      session.id,
      {
        calls: [
          { name: "skill", input: { id: "alpha" } },
          { name: "skill", input: { id: "beta" } },
          { name: "skill", input: { id: "alpha" } },
        ],
      },
      { calls: [{ name: "fixture_tick", input: {} }] },
      { calls: [{ name: "skill", input: { id: "alpha" } }] },
      { calls: [{ name: "fixture_tick", input: {} }] },
    )
    await h.prompt(session.id, "Run the fixture.")
    const requests = h.provider.primary(session.id)
    expect(requests).toHaveLength(5)
    for (const request of requests.slice(1)) {
      pinned(request)
      pinned(request, BETA)
      validToolPairs(request)
    }
  } finally {
    await h.close()
  }
})

test("two actual compactions and a reopened persistent host retain tool activations", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    h.provider.enqueue(session.id, { calls: [{ name: "skill", input: { id: "alpha" } }] })
    await h.prompt(session.id, "Activate alpha.")
    for (let i = 0; i < 2; i++) {
      await h.prompt(session.id, `Keep working ${i}.`)
      await h.compact(session.id)
      await h.prompt(session.id, `Continue after checkpoint ${i}.`)
      pinned(h.provider.primary(session.id).at(-1)!)
    }
    expect(h.provider.requests.filter((request) => request.kind === "compaction")).toHaveLength(2)
    await h.restart()
    await h.prompt(session.id, "Resume the existing session.")
    pinned(h.provider.primary(session.id).at(-1)!)
  } finally {
    await h.close()
  }
})

test("native @skill is pinned in the first request and removed from retained checkpoint text", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    await h.prompt(session.id, "An earlier exchange to retain a recent tail.")
    await h.prompt(
      session.id,
      "Apply @alpha and keep my exact text: <skill_content>ordinary quotation</skill_content>.",
      [{ id: "alpha" }, { id: "alpha" }],
    )
    pinned(h.provider.primary(session.id).at(-1)!)
    await h.compact(session.id)
    const checkpoint = (await h.host.sessions.context({ sessionID: session.id })).find(
      (message) => message.type === "compaction",
    )
    // Prove that this exercises the native retained-tail copy, not just an empty tail.
    expect(checkpoint?.metadata?.recent).toContain(ALPHA)
    await h.restart()
    await h.prompt(session.id, "Continue after restart and compact.")
    const request = h.provider.primary(session.id).at(-1)!
    pinned(request)
    expect(historyText(request)).toContain("<skill_content>ordinary quotation</skill_content>")
    await h.compact(session.id)
    await h.prompt(session.id, "Continue after the second compact.")
    pinned(h.provider.primary(session.id).at(-1)!)
    for (const compact of h.provider.requests.filter((request) => request.kind === "compaction"))
      expect(historyText(compact)).not.toContain(ALPHA)
  } finally {
    await h.close()
  }
})

test("a user quotation identical to a skill remains intact before and after compaction", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    await h.prompt(session.id, "Earlier exchange.")
    const quotation = `[Skill activated: ALPHA]\n${ALPHA}`
    await h.prompt(session.id, `Keep this user quotation unchanged:\n${quotation}`, [{ id: "alpha" }])
    await h.compact(session.id)
    await h.prompt(session.id, "Continue.")
    const request = h.provider.primary(session.id).at(-1)!
    expect(count(systemText(request), ALPHA)).toBe(1)
    expect(count(historyText(request), ALPHA)).toBe(1) // the user's quotation, not a generated activation
    expect(historyText(request)).toContain(`Keep this user quotation unchanged:\n${quotation}`)
  } finally {
    await h.close()
  }
})

test("filesystem updates appear on the next tool continuation after native catalog refresh", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    const updated = "UPDATED_ALPHA_BEGIN\nUse the new complete instructions.\nUPDATED_ALPHA_END"
    h.tick(() => h.updateSkill("alpha", updated))
    h.provider.enqueue(
      session.id,
      { calls: [{ name: "skill", input: { id: "alpha" } }] },
      { calls: [{ name: "fixture_tick", input: {} }] },
      { calls: [{ name: "skill", input: { id: "alpha" } }] },
    )
    await h.prompt(session.id, "Run the update sequence.")
    const requests = h.provider.primary(session.id)
    expect(requests).toHaveLength(4)
    pinned(requests[1])
    for (const request of requests.slice(2)) {
      pinned(request, updated)
      expect(JSON.stringify(request.body)).not.toContain(ALPHA)
    }
  } finally {
    await h.close()
  }
})

test("independent sessions never inherit another session's pinned skills", async () => {
  const h = await harness()
  try {
    const a = await h.create()
    const b = await h.create()
    await Promise.all([
      h.prompt(a.id, "Apply alpha.", [{ id: "alpha" }]),
      h.prompt(b.id, "Apply beta.", [{ id: "beta" }]),
    ])
    const requestA = h.provider.primary(a.id).at(-1)!
    const requestB = h.provider.primary(b.id).at(-1)!
    pinned(requestA)
    pinned(requestB, BETA)
    expect(systemText(requestA)).not.toContain(BETA)
    expect(systemText(requestB)).not.toContain(ALPHA)
  } finally {
    await h.close()
  }
})

test("failed tool activations are not pinned; explicit @skill follows native user semantics", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    await h.host.sessions.update({
      sessionID: session.id,
      permissions: [{ action: "skill", resource: "alpha", effect: "deny" }],
    })
    h.provider.enqueue(session.id, {
      calls: [
        { name: "skill", input: { id: "alpha" } },
        { name: "skill", input: { id: "does-not-exist" } },
      ],
    })
    await h.prompt(session.id, "Try denied and missing skills.")
    for (const request of h.provider.primary(session.id)) expect(systemText(request)).not.toContain(ALPHA)
    await h.prompt(session.id, "Explicitly attach @alpha.", [{ id: "alpha" }])
    pinned(h.provider.primary(session.id).at(-1)!)
  } finally {
    await h.close()
  }
})

test("current deny rules suspend model-activated pins without forgetting their IDs", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    h.provider.enqueue(session.id, { calls: [{ name: "skill", input: { id: "alpha" } }] })
    await h.prompt(session.id, "Activate alpha.")
    await h.host.sessions.update({
      sessionID: session.id,
      permissions: [{ action: "skill", resource: "alpha", effect: "deny" }],
    })
    await h.prompt(session.id, "Continue with deny.")
    expect(systemText(h.provider.primary(session.id).at(-1)!)).not.toContain(ALPHA)
    await h.host.sessions.update({ sessionID: session.id, permissions: [] })
    await h.prompt(session.id, "Continue after restoring permission.")
    pinned(h.provider.primary(session.id).at(-1)!)
  } finally {
    await h.close()
  }
})

test("automatic compaction before the first working request cannot lose a new @skill", async () => {
  const h = await harness({ auto: true })
  try {
    const session = await h.create()
    h.provider.enqueue(session.id, {
      text: "Previous exchange used most of the window.",
      inputTokens: 120000,
    })
    await h.prompt(session.id, "Earlier exchange.")
    await h.prompt(session.id, "Now apply @alpha.", [{ id: "alpha" }])
    const requests = h.provider.requests.filter((request) => request.sessionID === session.id)
    const compactIndex = requests.findIndex((request) => request.kind === "compaction")
    expect(compactIndex).toBeGreaterThan(0)
    const firstAfter = requests.slice(compactIndex + 1).find((request) => request.kind === "primary")!
    pinned(firstAfter)
    expect(historyText(firstAfter)).toContain("Now apply @alpha.")
  } finally {
    await h.close()
  }
})

test("effective registry overrides, unavailable skills, and virtual paths are resolved on each request", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    await h.prompt(session.id, "Attach alpha.", [{ id: "alpha" }])
    const replacement =
      "OVERRIDE_BEGIN\nUse the effective plugin override, not the underlying file.\nOVERRIDE_END"
    const virtual = path.join(h.root, "virtual", "SKILL.md")
    const override = await h.ctx.skill.transform((editor) =>
      editor.update("alpha", (skill) => {
        skill.content = replacement
        skill.autoinvoke = false
        skill.path = Skill.Info.fields.path.make(virtual)
      }),
    )
    await h.prompt(session.id, "Continue with the override.")
    pinned(h.provider.primary(session.id).at(-1)!, replacement)
    expect(systemText(h.provider.primary(session.id).at(-1)!)).toContain(path.dirname(virtual))
    expect(systemText(h.provider.primary(session.id).at(-1)!)).not.toContain("reference.txt")
    expect(systemText(h.provider.primary(session.id).at(-1)!)).not.toContain(ALPHA)
    const removal = await h.ctx.skill.transform((editor) => editor.remove("alpha"))
    await h.prompt(session.id, "Continue while unavailable.")
    expect(systemText(h.provider.primary(session.id).at(-1)!)).not.toContain(replacement)
    expect(systemText(h.provider.primary(session.id).at(-1)!)).not.toContain(ALPHA)
    await removal.dispose()
    await override.dispose()
    await h.prompt(session.id, "Continue with the original definition.")
    pinned(h.provider.primary(session.id).at(-1)!)
  } finally {
    await h.close()
  }
})

test("long skills are pinned in full before native tool-output truncation", async () => {
  const h = await harness()
  try {
    const large = `LARGE_SKILL_BEGIN\n${"Every detailed instruction must survive.\n".repeat(3000)}LARGE_SKILL_END`
    await h.writeSkill("large", large)
    const session = await h.create()
    h.provider.enqueue(session.id, { calls: [{ name: "skill", input: { id: "large" } }] })
    await h.prompt(session.id, "Activate the long skill.")
    const request = h.provider.primary(session.id).at(-1)!
    pinned(request, large)
    expect(historyText(request)).toContain('Skill "large" activated.')
    expect(historyText(request)).not.toContain("LARGE_SKILL_BEGIN")
    expect(historyText(request)).not.toContain("truncated")
  } finally {
    await h.close()
  }
})

test("native project source precedence and hidden descriptions retain normal discovery behavior", async () => {
  const h = await harness()
  try {
    const global = path.join(h.config, "skills", "alpha")
    await mkdir(global, { recursive: true })
    await writeFile(
      path.join(global, "SKILL.md"),
      "---\nname: Global alpha\ndescription: Global alpha fixture.\n---\nLOWER_PRECEDENCE_GLOBAL_BODY",
    )
    await h.writeSkill("hidden", "HIDDEN_COMPLETE_RULE", "metadata:\n  opencode/autoinvoke: false\n")
    const session = await h.create()
    await h.prompt(session.id, "Inspect the available catalog.")
    const first = systemText(h.provider.primary(session.id).at(-1)!)
    expect(first).toContain("Synthetic alpha fixture instructions.")
    expect(first).not.toContain("Synthetic hidden fixture instructions.")
    expect(first).not.toContain(ALPHA)
    expect(first).not.toContain(BETA)
    await h.prompt(session.id, "Explicitly attach @alpha.", [{ id: "alpha" }])
    pinned(h.provider.primary(session.id).at(-1)!)
    expect(JSON.stringify(h.provider.primary(session.id).at(-1)!.body)).not.toContain(
      "LOWER_PRECEDENCE_GLOBAL_BODY",
    )
    await h.updateSkill("alpha", "LOWER_PRECEDENCE_GLOBAL_BODY", () => rm(h.skillFile("alpha")))
    await h.prompt(session.id, "Use the remaining global definition.")
    pinned(h.provider.primary(session.id).at(-1)!, "LOWER_PRECEDENCE_GLOBAL_BODY")
    expect(systemText(h.provider.primary(session.id).at(-1)!)).toContain(global)
    expect(systemText(h.provider.primary(session.id).at(-1)!)).not.toContain(ALPHA)
    await h.prompt(session.id, "Explicitly attach @hidden.", [{ id: "hidden" }])
    pinned(h.provider.primary(session.id).at(-1)!, "HIDDEN_COMPLETE_RULE")
  } finally {
    await h.close()
  }
})

test("a rejected @skill admission does not leave a phantom activation", async () => {
  const h = await harness()
  try {
    const session = await h.create()
    await expect(
      h.host.sessions.prompt({
        sessionID: session.id,
        text: "Invalid attachment.",
        skills: [{ id: "alpha" }, { id: "missing" }],
      }),
    ).rejects.toBeDefined()
    await h.prompt(session.id, "Proceed without those attachments.")
    expect(systemText(h.provider.primary(session.id).at(-1)!)).not.toContain(ALPHA)
  } finally {
    await h.close()
  }
})
