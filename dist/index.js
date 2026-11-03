import { Plugin } from "@opencode/plugin";
import { confirmation, record } from "./types.js";
import { Store } from "./store.js";
import { RecentJournal } from "./recent.js";
import { denied, renderSkill } from "./skills.js";
export default Plugin.define({
    id: "opencode-skill-pin",
    async setup(ctx) {
        const store = new Store(ctx.storage);
        const journal = new RecentJournal(ctx.storage);
        // Serialize same-session journal updates, not independent sessions or individual tools.
        const pending = new Map();
        const serialized = (sessionID, work) => {
            const next = (pending.get(sessionID) ?? Promise.resolve()).catch(() => { }).then(work);
            pending.set(sessionID, next);
            return next.finally(() => {
                if (pending.get(sessionID) === next)
                    pending.delete(sessionID);
            });
        };
        await ctx.tool.hook("execute.after", async (event) => {
            if (event.tool !== "skill" ||
                event.status !== "completed" ||
                !record(event.input) ||
                typeof event.input.id !== "string")
                return;
            const output = event.result.output;
            // Recognize the standard skill result; leave unrelated replacement tools alone.
            if (!record(output) ||
                typeof output.name !== "string" ||
                typeof output.directory !== "string" ||
                typeof output.output !== "string")
                return;
            await store.activate(event.sessionID, event.input.id, "tool");
            const text = confirmation(event.input.id);
            event.result = { ...event.result, content: text, output: { ...output, output: text } };
        });
        const prepare = (event, inject) => serialized(event.sessionID, async () => {
            const history = await ctx.session.context({ sessionID: event.sessionID });
            const source = new Map(history.map((message) => [message.id, message]));
            const spans = await journal.load(event.sessionID);
            for (const message of history) {
                if (message.type === "user") {
                    for (const skill of message.skills ?? [])
                        await store.activate(event.sessionID, skill.id, "user");
                }
                else if (message.type === "skill") {
                    await store.activate(event.sessionID, message.skill, "user");
                }
            }
            event.messages = event.messages.map((message) => {
                const original = message.id ? source.get(message.id) : undefined;
                if (!original)
                    return message;
                if (original.type === "user") {
                    const loaded = (original.skills ?? []).filter((skill) => skill.text !== undefined);
                    return {
                        ...message,
                        content: message.content.map((part, index) => {
                            const skill = loaded[index];
                            return skill && part.type === "text" && part.text === skill.text
                                ? { ...part, text: confirmation(skill.id) }
                                : part;
                        }),
                    };
                }
                if (original.type === "skill") {
                    return {
                        ...message,
                        content: message.content.map((part) => part.type === "text" && part.text === original.text
                            ? { ...part, text: confirmation(original.skill) }
                            : part),
                    };
                }
                if (original.type === "compaction" &&
                    original.status === "completed" &&
                    typeof original.metadata?.recent === "string") {
                    const recent = original.metadata.recent;
                    const cleaned = journal.clean(recent, original.metadata.keepID, spans);
                    if (cleaned === recent)
                        return message;
                    const suffix = `<recent-context>\n${recent}\n</recent-context>\n</conversation-checkpoint>`;
                    return {
                        ...message,
                        content: message.content.map((part) => part.type === "text" && part.text.endsWith(suffix)
                            ? {
                                ...part,
                                text: part.text.slice(0, -suffix.length) +
                                    `<recent-context>\n${cleaned}\n</recent-context>\n</conversation-checkpoint>`,
                            }
                            : part),
                    };
                }
                return message;
            });
            await journal.remember(event.sessionID, history, spans);
            if (!inject)
                return;
            const active = await store.active(event.sessionID);
            if (!active.size)
                return;
            const [catalog, agent, session] = await Promise.all([
                ctx.skill.list(),
                ctx.agent.get({ agentID: event.agent }),
                ctx.session.get({ sessionID: event.sessionID }),
            ]);
            const rules = [...agent.data.permissions, ...(session.permissions ?? [])];
            const blocks = [];
            for (const skill of [...catalog.data].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
                const activation = active.get(skill.id);
                if (!activation || (!activation.explicit && denied(skill.id, rules)))
                    continue;
                blocks.push(await renderSkill(skill));
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
                });
        });
        await ctx.session.hook("context", (event) => prepare(event, true));
        await ctx.session.hook("generate", (event) => prepare(event, true));
        // Capture activations before a checkpoint can hide their original messages. Summary
        // requests need confirmations, not another copy of the pinned instruction bodies.
        await ctx.session.hook("compaction", (event) => prepare(event, false));
    },
});
