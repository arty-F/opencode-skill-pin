import { record } from "./types.js";
export class Store {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    prefix(sessionID) {
        return `v1/session/${encodeURIComponent(sessionID)}/active/`;
    }
    async activate(sessionID, id, source) {
        // Independent, idempotent keys avoid read/modify/write races between parallel calls.
        // A later tool activation must not erase an explicit user activation.
        await this.storage.set(`${this.prefix(sessionID)}${source}/${encodeURIComponent(id)}`, { id, source });
    }
    async active(sessionID) {
        const result = new Map();
        let after;
        do {
            const page = await this.storage.scan({ prefix: this.prefix(sessionID), after, limit: 100 });
            for (const { value } of page.entries) {
                if (!record(value) || typeof value.id !== "string")
                    continue;
                result.set(value.id, { explicit: value.source === "user" || result.get(value.id)?.explicit === true });
            }
            after = page.next;
        } while (after);
        return result;
    }
}
