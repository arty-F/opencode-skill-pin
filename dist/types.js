export const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export const confirmation = (id) => `Skill ${JSON.stringify(id)} activated. Its current instructions are pinned in the session's system context.`;
