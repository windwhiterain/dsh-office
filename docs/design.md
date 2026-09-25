# Design

Why `dsh-office` is shaped this way: the row kinds, the host/office split, the boss preset's
mask, how the profile patch is edited, the role model, and why a wake can be timed. Read this
before changing `index.js`; the storage and identity contract is in
[data-model.md](data-model.md), and what happens when something is posted is in
[delivery.md](delivery.md).

## Two kinds of row, told apart by the row id

Every row of this package imports the same module and calls `apply`. The row whose id is
`office-host` is the **host**; every other row is an **office**. The id decides, and no config
field could:

- A patch override **replaces the whole `config`**. An operator tuning one value on the office
  row would drop the field that says which kind of row it is, the row would be read as a second
  host, and the process would refuse it: only one host row may mount.
- A row id is the patch's own match key. An override addresses a row *by* its id, so no override
  can remove or change it.

The same property is why `config.officeId` defaults to the row id: an override that dropped an
explicit `officeId` would otherwise repoint the office at another storage unit. Both halves of
the identity therefore hang off the one identifier an override cannot touch.

### Why `officeName` is required and never defaulted

`officeName` is the name the user, the panel, and the model read and pass. There is no honest
default for it: the row id is already spoken for as the storage key, and any other value would be
a name nobody chose. An office row that lost its name could not be addressed by any surface, so
`resolveOfficeConfig` refuses the row instead — the missing name fails activation, where the
operator is looking, rather than producing an office that exists and cannot be reached.
Overriding any office value therefore means restating `officeName`.

## The host and the office

| | the host | an office |
|---|---|---|
| how many | exactly one per process | any number |
| config | `readLimit`, `readLimitMax`, `bossPreset`, `profilePatch` | `officeName` (required), `officeId`, `bossPreset`, `userName`, `rolePermissions`, `maxMessageChars`, `wakesEnabled` |
| owns | the agent tool set, the Web panel, `/dsh-office/*` | its storage domain, its roster, its channels |
| registers tools | yes, once per agent that holds an office role | **no** |
| registers routes | yes, one table for every office | **no** |

Each kind refuses the other's config fields rather than ignoring them, because a field on the
wrong kind of row would otherwise look configured while doing nothing.

### Why the office is an argument, not a bearer

An office that registered its own tools would need the office name inside every tool name,
because a scope rejects a duplicate tool name and N independent office rows cannot each register
`office_post`. The same argument applies to the routes: an office that registered its own would
need the name in the path, and every route would exist once per office. One host registering one
tool set and one route table removes that entirely, so the office travels as an argument
(`args.office`) or as the `office` query parameter.

The argument is also what keeps a boss's tool count constant: a boss that runs five offices holds
the same set it holds for one, because the office is never part of a name.

### Why the host holds no office

The host's lifetime is independent of the registry, so the panel and the tools survive the
registry being emptied. Delete every office and the panel still answers `/dsh-office/offices`
with an empty list and can create the first office again. Before the split, the built-in office
*was* the plugin's only UI host, so deleting it took the panel with it.

The same split keeps the door open for a second office row added while the process runs: the
panel's create route writes a row into the profile patch, the Loader mounts it, and the tool set
and route table were already there.

## The boss preset

The bundle's patch declares `office-boss`: a persona, the persistent shell rows, and
`presets/boss-restrict.mjs`. Two details are load-bearing.

### Why the mask is a deny list, not `allow: []`

A restriction filters what a scope **inherits** — the global layer and every ancestor layer — and
never what that scope's own layer registers. For an *agent*, the preset's standing layer is an
**ancestor**, so:

- `allow: []` admits no inherited name at all, which would hide this preset's shell along with
  the globals.
- `allow: ['bash']` is refused outright: `restrict()` validates every name against the
  pre-restriction inherited set, and a scoped registration is not in it. The registry would
  answer `names unknown global tool "bash"`.

So the row denies the global **names** instead, which removes exactly the globals and leaves the
preset's own shell standing. The shell's own name is excluded from the deny list because a
restriction matches by name rather than by the layer that registered it, so denying `bash` would
hide the shell too.

The office tools are unaffected either way: the office host registers them through `agent.ctx`,
so they sit in the agent's **own** layer, which no restriction filters.

There is no per-deployment configuration of the mask. A deployment that mounts a global `bash`
of its own keeps it.

### Why the shell path is resolved, not pinned

The PTY backend hands `shellPath` straight to the native spawn, which **does not search PATH**: a
bare `bash` fails at call time with `File not found` even when bash is on PATH. The row
therefore resolves an absolute path from PATH in a `!!js` expression at load time, rather than
pinning one machine's Git for Windows install into this package. The expression falls back to
the bare name, so a deployment whose bash is not on PATH loses the shell tool alone — not the
office tools with it.

## The profile patch

The panel's create, delete, and rename routes edit the profile patch
(`ctx.profileContext.patchPath`, or `config.profilePatch` when a deployment names one). The path
is read per request, because that service may activate after this plugin does.

### Why the edit goes through the YAML document model

The patch is parsed with `parseDocument` and written back with `String(document)`. Parsing to
plain data and re-serializing would discard the operator's own comments, so every edit would
rewrite the file the user maintains by hand. The document is also how a row is located
structurally — `officeRowPath` asks the document for `config.officeName`, `config.officeId`, and
`id` — instead of by matching text.

Both the create and the delete write beside the file and rename over it, so a partial write can
never leave an unparseable patch for the next boot. Deletion erases data through the domain API
because the storage backend exposes no unit drop, which leaves an empty medium rather than
removing it and keeps the operation backend-agnostic.

### Why a create writes an `insert` list

The new office row is added as `{ insert: [ { id, name: 'dsh-office', config: {...} } ] }`. The
Loader appends a patch entry's `insert` list to the tree, but reads an entry **without** one as
an id-targeted override of a row an earlier layer created: it looks the id up in the built map,
and on a miss warns `patch: entry <id> not found` and skips the entry. A bare top-level
`- id: office_studio` therefore matches nothing and never mounts — the office silently does not
exist, with no failure anywhere the operator would look.

That is also why the two row forms are not equivalent to delete:

| row form | action | why |
|---|---|---|
| inside an `insert` list | removed | this profile inserted it, so the row is the only thing mounting the office. |
| top level, office mounted | **disabled** | it only overrides a row an earlier layer inserted — the package's own `office` row is the case — so removing it would restore that layer's config and leave the office mounted. |
| top level, office not mounted | removed | it overrides nothing, so it is a dead row from a hand edit; leaving it would block a later create of the same name. |

A row is located by its `config.officeName` first, then by its `config.officeId`, and only then
by the row id, which also matches the `office-<name>` ids older versions wrote and the shipped
`office` row. The name is what the operator reads; the key catches the row after the office was
renamed, because a rename changes stored data rather than the profile. Matching on a defaulted
name instead would mistake any unrelated override, such as `- id: browser`, for an office row.

A created row takes the **host's** `bossPreset`, so everything the panel creates shares one boss
by default. Its row id is generated from the name — a Latin name keeps a readable slug, anything
else is digested — because the row id is the office's default storage key and has to be usable as
one. The generated id is written out as `officeId` as well, so a later edit to the row id cannot
move the office's storage by accident.

## Office state lives in the domain

All authoritative state is in the office's storage domain: the four tables and the global slot.
No custom `SessionEventMap` member is added, and that is a harness contract rather than a
preference:

- `KNOWN_SESSION_EVENT_TYPES` is generated from the harness source, so an out-of-tree event type
  is not in it.
- `Session.append` cannot stamp the envelope's `ignorable` marker, so a custom event type would
  make the owning session unreadable at its next open.

Delivery into a colleague uses a standard `user/message` whose `source.kind` is
`office-message`; the session read path requires a nonempty source `kind` and does not constrain
its value, which makes this the only model-visible channel open to the plugin. See
[delivery.md](delivery.md) for the payload and its JSON rules.

## Predefined colleague roles

A colleague's stored `role` is one of `member`, `leader`, or `consultant`, and nothing else. The
role is not a label because it decides which office tools that colleague's session receives: a
free-text label would be a permission nobody can predict from the roster, and a rename of the
label would silently change what a session may do. `canonicalRole` reads an absent or no longer
predefined value as `member`, which is also the migration path for records written before roles
existed; `requireRole` refuses an unrecognized value a caller supplies.

A role is two independent things at once:

| axis | what it decides | enforced by |
|---|---|---|
| capability set | which office tools the colleague's session holds | which definitions `createOfficeTools` builds |
| session permission preset | sandbox mode and approval policy the colleague's session runs under | `config.rolePermissions`, applied through `ctx.permissionPresets` |

They are separate because they answer different questions: what a colleague may say into the
office, and what its session may write to disk. The two diverge in `consultant`: its capability
set speaks like a `member`'s, and the default map runs its session under `read-only`. The two
restrictions do not compound, because an office tool is this plugin's own code writing through
the office's storage domain — not a confined capability of the session — so a session that
cannot write a file can still write history. `member` and `leader` keep whatever permission
their session already has, because the default map names no preset for them.

The preset is applied when a role is **set** — at hire, at adopt, and at the configure that
carries a role. It is deliberately **not** re-applied on every turn, nor on a description-only
configure: switching a session's preset from the Web UI is the user's own act, and reverting it
silently at the next wake would be a surprise. The roster reports each colleague's effective
preset instead, so the drift stays visible. A mapping the deployment cannot enforce — no
`permissionPresets` service, or a name it does not define — is refused rather than skipped: a
restriction that did not apply must not look like one that did.

### The union grants the tool, the office decides the right

A session may be a colleague of several offices, and it holds a different predefined role in
each. The tool set is a property of the *agent*, so it is the union of its roles' capabilities,
and a colleague's scope receives every tool any of its memberships admits.

The union grants the tool; the capability is checked again against the office a call resolved, in
`tool.require`. A session that is a `leader` of one office and a `member` of another therefore
holds `office_interrupt` but is refused when it aims that call at the second office. The office
argument is likewise resolved against the registry as it is *now*, not against the set the tools
were built from, because a session can join or leave an office between two calls.

### A role change reinstalls the tool set

`installOfficeTools` compares a signature of the agent's acting role and capability union and
reinstalls when it changes. A demoted leader must lose `office_interrupt` and `office_compact`
from its scope, not merely be refused by them: a tool a model can see but cannot use spends a
turn, and the refusal is invisible until the model tries. Every roster event — adopted,
configured, dismissed — and every office mount or unmount therefore only asks the host to resync
the affected agents; only the host installs or withdraws.

## The user mailbox is a channel

The user is not a session, so nothing can wake them and a colleague cannot answer them by
writing into its own transcript. The office gives them somewhere to be addressed: a channel of
`kind: 'mailbox'`, created on activation beside `#general`.

It is a channel rather than a query because the mail is authoritative stored state: a message
addressed to the user is written once, in sequence order, and the panel reads it. A query
assembled by scanning channels at read time would have to re-derive the user's mail from every
channel and would make the office's own history depend on that derivation. Storing it also gives
a copied message one place to carry its `origin`, so the panel can say the same thing was also
said in a channel.

No office tool reads it, and that is enforced in one place: `visibleChannels` excludes
`kind: 'mailbox'`, and `office_read({ channel: '*' })` walks exactly that list. `office_read`
additionally refuses the mailbox by name, and `resolveDirectChannel` refuses it for `office_dm`
and `office_compact`, so a colleague cannot reach the user's mail through any spelling of it.
Colleagues may still *write* to it — every predefined role holds `office_dm` — and a public post
that names the user is stored in its channel and then copied in. See
[delivery.md](delivery.md) for the copy's ordering and its delivery outcome,
and [data-model.md](data-model.md) for the record shape.

## Why a wake can be timed, and why it is still durable

`office_dm` accepts `notify: 'turn-end' | 'step-end'`, and the second is the only way an office wake
is ever spliced into a turn that is already running. The two things a colleague can be sent are
genuinely different questions: *answer this afterwards* is what a held, merged turn is for, and
*stop doing that now* cannot wait for the turn to end without arriving useless.

Three harness contracts make it safe rather than a fire-and-forget splice:

- `Agent.steer` puts the message into the session's inbox as pending step input, which the loop
  claims at every step boundary. The colleague therefore reads it between the steps it is running,
  and the office is heard without interrupting anything.
- The inbox is a durable session projection, but nothing resumes a colleague whose process died
  mid-turn, so the office keeps the wake in its own `pending` table as well and deletes it when
  `agent/inbox/claimed` reports the claim. What stays held is exactly what the harness has not
  taken, which is the recovery case rather than the normal one.
- Whether a recovery would become a second delivery is answered by the **colleague's session log**,
  not by the office's bookkeeping: a claimed message is appended as a `user/message` before the
  request that reads it. The office already reads that log for a cold resume's route, and reading it
  here is what makes "did it arrive?" survive a restart. Where a lingering inbox copy exists it is
  removed (`Agent.inbox.remove`) before the office queues its own turn, so exactly one of the two
  carries the message.

`notify` is deliberately not on `office_post`: one public post reaches every busy colleague, so the
timing would turn a single message into an interruption of every run in the office at once.
