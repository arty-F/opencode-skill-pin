import { readdir } from "node:fs/promises";
import path from "node:path";
const ignored = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** A small path-only sample; never read supporting file contents or follow directory symlinks. */
async function supportingFiles(skill) {
    if (path.basename(skill.path) !== "SKILL.md")
        return [];
    const files = [];
    async function walk(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (files.length >= 10)
                return;
            if (ignored.has(entry.name))
                continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory())
                await walk(file);
            else if (entry.isFile() && entry.name !== "SKILL.md")
                files.push(file);
        }
    }
    try {
        await walk(path.dirname(skill.path));
    }
    catch (error) {
        // Embedded/plugin-defined definitions can have a virtual path.
        if (!(error instanceof Error) ||
            !("code" in error) ||
            !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code)))
            throw error;
    }
    return files;
}
export async function renderSkill(skill) {
    const files = await supportingFiles(skill);
    return [
        `<skill_content id="${xml(skill.id)}" name="${xml(skill.name)}">`,
        `# Skill: ${skill.name}`,
        "",
        skill.content,
        "",
        `Base directory for this skill: ${path.dirname(skill.path)}`,
        "Relative paths in this skill are relative to this base directory.",
        "Supporting file paths below are a sample; their contents have not been loaded.",
        "<skill_files>",
        ...files.map((file) => `<file>${xml(file)}</file>`),
        "</skill_files>",
        "</skill_content>",
    ].join("\n");
}
/** OpenCode 2.2.5's documented whole-value wildcard semantics, including Windows matching. */
function matches(value, pattern) {
    let expression = pattern
        .replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
    if (expression.endsWith(" .*"))
        expression = expression.slice(0, -3) + "( .*)?";
    return new RegExp(`^${expression}$`, process.platform === "win32" ? "si" : "s").test(value.replaceAll("\\", "/"));
}
export const denied = (id, rules) => rules.findLast((rule) => matches("skill", rule.action) && matches(id, rule.resource))?.effect === "deny";
