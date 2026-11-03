# OpenCode Skill Pin

Keep activated skills in a **separate system block**, intact across compaction
and session restarts. For **OpenCode 2.2.5**.

## Context layout

After a skill is activated:

```text
Without plugin                     With Skill Pin
──────────────────────────────     ──────────────────────────────
SYSTEM                             SYSTEM
  OpenCode + AGENTS.md                OpenCode + AGENTS.md
  Skill catalog (descriptions)        Skill catalog (descriptions)
                                     <pinned_skills>
                                       Full skill instructions
                                     </pinned_skills>
HISTORY                            HISTORY
  User task                          User task
  skill → full instructions          skill → short confirmation
  Conversation                       Conversation
```

After compaction:

```text
Without plugin                     With Skill Pin
──────────────────────────────     ──────────────────────────────
SYSTEM                             SYSTEM
  OpenCode + AGENTS.md                OpenCode + AGENTS.md
  Skill catalog (descriptions)        Skill catalog (descriptions)
                                     <pinned_skills>
                                       Full skill instructions
                                     </pinned_skills>
HISTORY                            HISTORY
  Summary + retained history         Summary + retained history
    Skill text may be shortened        Activation confirmation
    or omitted                         Full text stays in SYSTEM
  Current task                       Current task
```

Only successfully activated skills are pinned: automatic `skill` calls and
explicit `@skill` attachments. One copy per ID, refreshed from OpenCode's current
catalog on every working request, including tool continuations.

## Install

Add this entry to `plugins` in your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:arty-F/opencode-skill-pin"],
}
```

OpenCode installs the package and its dependencies. No local clone or build is needed.
Activate skills normally.

For global installation: `opencode plugin add github:arty-F/opencode-skill-pin`.

**Scope:** verified with 2.2.5 summary compaction. Install before activation;
previously lost activations cannot be recovered. Pins consume context space.
File edits appear after OpenCode refreshes its catalog.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs formatting, type checks, build, and integration tests against
real OpenCode requests with a local mock provider; no paid model calls.
Set `SKILL_PIN_OPENCODE_BIN` to also test packed and Git installations against the
installed executable, including compaction and process restart. The Git test installs
from a temporary repository using OpenCode's native installer and downloads dependencies.

Rebuild with `bun run build:dist` and commit `dist/` with source changes. Git installs
use these files directly; CI checks that the committed build is up to date.

[MIT](LICENSE) · [Third-party notice](NOTICE)
