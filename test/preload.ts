import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir()
mkdirSync(base, { recursive: true })
const root = mkdtempSync(path.join(base, "skill-pin-test-"))
process.env.SKILL_PIN_TEST_ROOT = root
process.env.OPENCODE_TEST_HOME = root
process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
for (const key of ["DATA", "CONFIG", "CACHE", "STATE"])
  process.env[`XDG_${key}_HOME`] = path.join(root, key.toLowerCase())
process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
