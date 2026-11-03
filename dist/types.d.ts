import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
export type Context = Plugin.Context;
export type Request = SessionContext;
export type History = Awaited<ReturnType<Context["session"]["context"]>>;
export type StoredMessage = History[number];
export type SkillInfo = Awaited<ReturnType<Context["skill"]["list"]>>["data"][number];
export declare const record: (value: unknown) => value is Record<string, unknown>;
export declare const confirmation: (id: string) => string;
