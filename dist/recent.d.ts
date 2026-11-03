import type { Context, History, StoredMessage } from "./types.js";
type Span = {
    id: string;
    length: number;
    hash: string;
    prefix: number;
    replacement: string;
};
export declare function recentText(message: StoredMessage): string;
export declare class RecentJournal {
    private readonly storage;
    constructor(storage: Context["storage"]);
    load(sessionID: string): Promise<Span[]>;
    clean(recent: string, keepID: unknown, spans: Span[]): string;
    remember(sessionID: string, history: History, previous: Span[]): Promise<void>;
    private key;
}
export {};
