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

Build this checkout:

```sh
bun install --frozen-lockfile
bun run build
```

Add it to your project's `opencode.jsonc` (Windows paths can use `/`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-skill-pin"],
}
```

Activate skills normally. No extra commands or options.

**Scope:** verified with 2.2.5 summary compaction. Install before activation;
previously lost activations cannot be recovered. Pins consume context space.
File edits appear after OpenCode refreshes its catalog.

## Verify

`bun run check` runs formatting, type checks, build, and integration tests against
real OpenCode requests with a local mock provider; no paid model calls.
Set `SKILL_PIN_OPENCODE_BIN` to also test the installed executable and process restart.

[MIT](LICENSE) · [Third-party notice](NOTICE)
