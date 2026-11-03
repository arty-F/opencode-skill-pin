export type WireMessage = {
  role: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}
export type Captured = {
  sessionID: string
  kind: string
  body: { messages: WireMessage[]; [key: string]: unknown }
}
export type Reply = ({ text: string } | { calls: { name: string; input: Record<string, unknown> }[] }) & {
  inputTokens?: number
}

export function mockProvider() {
  const requests: Captured[] = []
  const replies = new Map<string, Reply[]>()
  let count = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("Unexpected endpoint", { status: 404 })
      const sessionID = request.headers.get("x-opencode-session-id") ?? ""
      const kind = request.headers.get("x-skill-pin-kind") ?? "primary"
      const body = (await request.json()) as Captured["body"]
      requests.push({ sessionID, kind, body })
      const reply: Reply =
        kind === "compaction"
          ? { text: "## Objective\nContinue the fixture task.\n\n## Next Move\nContinue." }
          : (replies.get(sessionID)?.shift() ?? { text: "Fixture complete." })
      const id = `chatcmpl_fixture_${++count}`
      const base = { id, object: "chat.completion.chunk", created: 1, model: "fixture" }
      const delta =
        "text" in reply
          ? { content: reply.text }
          : {
              tool_calls: reply.calls.map((call, index) => ({
                index,
                id: `call_${count}_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
          usage: {
            prompt_tokens: reply.inputTokens ?? 100,
            completion_tokens: 20,
            total_tokens: (reply.inputTokens ?? 100) + 20,
          },
        },
      ]
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    enqueue: (sessionID: string, ...items: Reply[]) =>
      replies.set(sessionID, [...(replies.get(sessionID) ?? []), ...items]),
    primary: (sessionID: string) =>
      requests.filter((request) => request.sessionID === sessionID && request.kind === "primary"),
    stop: () => server.stop(true),
  }
}

export const systemText = (request: Captured) =>
  request.body.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => text(message.content))
    .join("\n")
export const historyText = (request: Captured) =>
  request.body.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => text(message.content))
    .join("\n")
export function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  return ""
}
