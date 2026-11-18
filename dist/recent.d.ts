import type { Context, History, StoredMessage } from "./types.js";
type Span = {
    id: string;
    length: number;
    hash: string;
    prefix: number;
    replacement: string;
};
/** An admitted user prompt that can join a checkpoint's retained tail before any request shows it. */
export type AdmittedUser = Pick<Extract<StoredMessage, {
    type: "user";
}>, "id" | "type" | "text" | "skills" | "files">;
type RecentMessage = StoredMessage | AdmittedUser;
export declare function recentText(message: RecentMessage): string;
export declare class RecentJournal {
    private readonly storage;
    constructor(storage: Context["storage"]);
    load(sessionID: string): Promise<Span[]>;
    clean(recent: string, keepID: unknown, spans: Span[]): string;
    remember(sessionID: string, history: History, previous: Span[]): Promise<void>;
    admit(sessionID: string, message: AdmittedUser): Promise<void>;
    private key;
}
export {};
