import type { SkillInfo } from "./types.js";
export declare function renderSkill(skill: SkillInfo): Promise<string>;
type Rule = {
    action: string;
    resource: string;
    effect: "allow" | "deny" | "ask";
};
export declare const denied: (id: string, rules: readonly Rule[]) => boolean;
export {};
