# OpenCode Skill Pin

**Activated skills belong in instructions, not in a lossy conversation summary.**

A standalone server plugin for **OpenCode V2.2.5**. It keeps the full, current
instructions of activated skills in a dedicated system block across tool calls,
compaction, and session restarts.

```text
OpenCode system instructions
Native project instructions, including AGENTS.md
Pinned skills — full instructions, once per skill ID
Conversation checkpoint + recent history + current task
```

## Why

Normally, the `skill` tool returns a skill's full instructions into conversation
history. Compaction can shorten or discard that output while the model still
remembers having loaded the skill.

Skill Pin records successful activations outside the conversation and injects
the effective definitions before every working model request. This is enforced
by plugin code; it does not depend on the model remembering to reload anything.

## Features

- **Automatic discovery stays native.** The model sees the normal skill catalog
  and chooses when to call `skill`. Only activated skills are pinned.
- **Both activation paths.** Standard `skill` calls and explicit `@skill`
  attachments are supported.
- **Immediate continuation.** The first request after activation receives the
  full instructions, including within a long chain of tool calls.
- **One pin per ID.** Repeated and parallel activations do not duplicate bodies.
- **Persistent, session-scoped state.** Compaction and restarting OpenCode do
  not clear the activation registry. Independent sessions remain isolated.
- **Current definitions.** Each request reads OpenCode's effective skill catalog,
  including source precedence and plugin-provided overrides.
- **Lean history.** Tool results become short confirmations. Generated `@skill`
  bodies are replaced in outgoing context, including retained checkpoint text.
- **Relative paths preserved.** Pins contain the ID, display name, base directory,
  and a sample of supporting file paths. Supporting file contents are never
  loaded automatically.

## Install

### From a local checkout

Requires OpenCode **2.2.5** and Bun for building the package.

```sh
bun install --frozen-lockfile
bun run build
```

Add the checkout directory to your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-skill-pin"],
}
```

On Windows, forward slashes work:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/path/to/opencode-skill-pin"],
}
```

OpenCode reloads configuration automatically. Activate a skill in a session to
start pinning it. The plugin has no required options or additional commands.
To use it across projects, add the same entry to your global configuration yourself.

### Install a locally packed package

```sh
bun pm pack
```

Install the resulting `.tgz` into a directory of your choice, then reference the
installed `node_modules/opencode-skill-pin` directory in `plugins`. The package
ships compiled JavaScript and TypeScript declarations. An npm publication is not
required for local installation.

## Behavior

### Activation and permissions

For model-initiated loading, OpenCode executes its standard `skill` tool and
permission checks first. Failed, missing, or rejected activations are not pinned.
An approval to load a skill also permits retaining those instructions for the
session; Skill Pin does not ask again on every model step.

An explicit `@skill` follows OpenCode's native user-attachment semantics. The
plugin adds no permission dialog. This authorizes attaching the instructions,
not automatically approving commands or edits described by them.

Current explicit `skill` deny rules suppress model-activated pins. Explicit user
attachments follow native user semantics instead. A skill removed from the
effective catalog is omitted, regardless of activation source. Its ID remains
remembered, so restoring availability restores the pin. Dynamic permission hooks
are evaluated by native activation; the plugin does not replay them on every
request or turn a one-time approval into a project-wide saved permission.

`autoinvoke: false` affects discovery, not an already activated skill.

### Updates

The catalog, not a saved copy of `SKILL.md`, supplies the instruction body.
Changes appear on the next request **after OpenCode refreshes its catalog**.
OpenCode 2.2.5's filesystem watcher has a short asynchronous debounce; saving a
file and immediately starting a request is not a synchronous refresh barrier.

### Compaction and persistence

The activation registry uses `ctx.storage`, backed by OpenCode's database and
namespaced by this plugin's stable ID. There is no separate database or daemon.
Pins last for the session; there is no manual unpin interface in this release.

The request hook reinjects pins after every compaction. It never waits for an
asynchronous "compaction finished" event. The compaction hook records any
newly delivered user activations before their source messages can be compacted.
Summary requests receive activation confirmations rather than pinned bodies.

Native `@skill` attachments remain in OpenCode's stored history and UI. Only the
outgoing model context is projected. A compact provenance journal stores message
IDs, lengths, hashes, and generated-prefix replacements, not user transcripts.
This distinguishes generated skill blocks from user quotations when OpenCode
rebuilds its retained recent-context text. User-authored quotations are preserved,
even when they repeat a skill's contents.

### Compatibility and boundaries

| Component             | Compatibility                                                 |
| --------------------- | ------------------------------------------------------------- |
| OpenCode              | **2.2.5**; CLI and server must use a compatible V2 plugin API |
| Plugin API dependency | `@opencode/plugin@2.2.5`                                      |
| Tested compaction     | OpenCode summary compaction, including retained recent text   |
| OpenCode V1           | Not supported                                                 |

The plugin uses public plugin APIs only; it imports no OpenCode Core internals.
The small checkpoint-text adapter is version-specific and must be checked when
adding support for another OpenCode release. Native provider compaction and
experimental background compaction are not part of the verified compatibility
matrix yet.

Install the plugin before activating skills. It cannot reconstruct activations
already lost to an earlier compaction before installation. Forked sessions do
not inherit the parent's private registry; activations still visible in the
fork's native user attachments are discovered normally.

Pinned instructions consume context space on every request. Compaction cannot
make a set of fixed instructions larger than a model's context window fit.
Later plugins can change the final request; place Skill Pin after other plugins
that rewrite conversation context and verify their combined behavior.

## How it works

1. `ctx.tool.hook("execute.after")` durably records a successful standard skill
   activation, then replaces its `content` and structured `output` body.
2. `ctx.session.hook("context")` discovers native user attachments, projects
   confirmations into history, resolves current definitions, and appends one
   pinned system block. The hook runs on tool-driven continuations too.
3. `ctx.session.hook("compaction")` captures activations and prepares the same
   history projection before summarization. Transient session generation also
   receives pins through the `generate` hook.

**Why not session instruction entries?** In 2.2.5, instruction entries maintain
an epoch baseline. Updates are introduced chronologically before a later
compaction promotes them into the baseline. A request hook puts the current
skill body directly in the system prefix of the current request instead.

OpenCode remains responsible for loading `AGENTS.md`; the plugin neither reads
nor duplicates it.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

Integration tests use the real `@opencode/sdk@2.2.5` runtime with a local HTTP
mock provider. They inspect serialized model requests, including system text,
tool-call/result pairing, and checkpoint context. No LLM account or paid request
is needed. Test configuration, databases, and home directories are isolated in
temporary directories.

Coverage includes both activation paths, repeated and parallel calls, consecutive
manual compactions, automatic compaction before a new attachment's first working
request, tool-only continuations, restart recovery, live file updates, source
overrides, permissions, session isolation, long bodies, preserved user quotations,
and native `AGENTS.md` ordering.

To additionally test a packed, installed plugin against your OpenCode executable:

```powershell
$env:SKILL_PIN_OPENCODE_BIN = 'C:/path/to/opencode.exe'
bun run test:installed
```

```sh
SKILL_PIN_OPENCODE_BIN=/path/to/opencode bun run test:installed
```

That test starts private server processes, compacts real sessions, stops and
restarts the server with the same test database, and checks the next requests.
It extracts the actual package tarball and reuses the dependencies already
installed from the lockfile; `tar` must be available on `PATH`.
It never connects to your shared service or changes your global configuration.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for the attributed OpenCode compatibility adapter.
