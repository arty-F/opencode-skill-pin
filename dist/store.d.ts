import type { Context } from "./types.js";
export declare class Store {
    private readonly storage;
    constructor(storage: Context["storage"]);
    private prefix;
    activate(sessionID: string, id: string, source: "tool" | "user"): Promise<void>;
    active(sessionID: string): Promise<Map<string, {
        explicit: boolean;
    }>>;
}
