import { createHash } from "node:crypto";
import { confirmation, record } from "./types.js";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const clip = (value) => {
    const chars = Array.from(value);
    return chars.length <= 1250 ? value : `${chars.slice(0, 1250).join("")}\n[truncated]`;
};
export function recentText(message) {
    switch (message.type) {
        case "user":
            return [
                ...(message.skills ?? []).flatMap((skill) => skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`]),
                `[User]: ${message.text}`,
                ...(message.files ?? []).map((file) => `[Attached ${file.mime}: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}]`),
            ].join("\n");
        case "skill":
            return `[Skill activated: ${message.name}]\n${message.text}`;
        case "synthetic":
            return `[Synthetic context]: ${message.text}`;
        case "location-switched":
            return `[User]: The working directory has been changed to ${message.location.directory}.`;
        case "shell":
            return message.metadata?.background === true
                ? ""
                : `[Shell]: ${message.command}\n${clip(message.output?.output ?? "")}`;
        case "assistant":
            return message.content
                .flatMap((part) => {
                if (part.type === "text")
                    return [`[Assistant]: ${part.text}`];
                if (part.type === "reasoning")
                    return [];
                const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input);
                const call = `[Assistant tool call]: ${part.name}(${input})`;
                if (part.state.status === "error")
                    return [call, `[Tool error]: ${part.state.error.message}`];
                if (part.state.status !== "completed")
                    return [call];
                const output = part.state.content
                    .map((item) => item.type === "text"
                    ? item.text
                    : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`)
                    .join("\n");
                return [call, `[Tool result]: ${clip(output)}`];
            })
                .join("\n");
        default:
            return "";
    }
}
function span(message) {
    const text = recentText(message);
    if (!text)
        return;
    let prefix = 0;
    let replacement = "";
    if (message.type === "user") {
        const skills = (message.skills ?? []).filter((skill) => skill.text !== undefined);
        prefix = skills.reduce((sum, skill) => sum + `[Skill activated: ${skill.name}]\n${skill.text}\n`.length, 0);
        replacement = skills.map((skill) => `${confirmation(skill.id)}\n`).join("");
    }
    else if (message.type === "skill") {
        prefix = text.length;
        replacement = confirmation(message.skill);
    }
    return { id: message.id, length: text.length, hash: hash(text), prefix, replacement };
}
function isSpan(value) {
    return (record(value) &&
        typeof value.id === "string" &&
        typeof value.hash === "string" &&
        typeof value.length === "number" &&
        typeof value.prefix === "number" &&
        typeof value.replacement === "string");
}
export class RecentJournal {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    async load(sessionID) {
        const value = await this.storage.get(this.key(sessionID));
        return Array.isArray(value) ? value.filter(isSpan) : [];
    }
    clean(recent, keepID, spans) {
        if (typeof keepID !== "string")
            return recent;
        const start = spans.findIndex((item) => item.id === keepID);
        if (start < 0)
            return recent;
        let offset = 0;
        const edits = [];
        for (const item of spans.slice(start)) {
            const text = recent.slice(offset, offset + item.length);
            // Never guess at boundaries or strip skill-looking text authored by the user.
            if (hash(text) !== item.hash)
                break;
            if (item.prefix)
                edits.push({ start: offset, end: offset + item.prefix, text: item.replacement });
            offset += item.length;
            if (offset === recent.length)
                break;
            if (recent.slice(offset, offset + 2) !== "\n\n")
                break;
            offset += 2;
        }
        for (const edit of edits.reverse())
            recent = recent.slice(0, edit.start) + edit.text + recent.slice(edit.end);
        return recent;
    }
    async remember(sessionID, history, previous) {
        // Retain only the current checkpoint's range plus new messages, including
        // tool-driven continuations, without copying transcripts.
        const checkpoint = history.find((message) => message.type === "compaction" && message.status === "completed");
        const keepID = checkpoint?.metadata?.keepID;
        const index = previous.findIndex((item) => item.id === keepID);
        const retained = checkpoint ? (index < 0 ? [] : previous.slice(index)) : previous;
        const entries = new Map(retained.map((item) => [item.id, item]));
        for (const message of history) {
            const item = span(message);
            if (item)
                entries.set(item.id, item);
        }
        const next = [...entries.values()];
        if (JSON.stringify(next) !== JSON.stringify(previous))
            await this.storage.set(this.key(sessionID), next);
    }
    key(sessionID) {
        return `v1/session/${encodeURIComponent(sessionID)}/recent`;
    }
}
