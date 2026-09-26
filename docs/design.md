# Design

Why `dsh-office` is shaped this way: the row kinds, the host/office split, the boss preset's
mask, how the profile patch is edited, the role model, who a wake reaches, why a wake can be
timed, and what the one message the office writes itself is for. Read this
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
| config | `readLimit`, `readLimitMax`, `bossPreset`, `profilePatch` | `officeName` (required), `officeId`, `bossPreset`, `userName`, `rolePermissions`, `maxMessageChars`, `wakesEnabled`, `idleNotice` |
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

### The model-facing text budget

Everything this package puts in front of a model is billed on every request of the session that
carries it, so the three surfaces are kept deliberately terse:

| surface | where it lives | paid |
|---|---|---|
| the boss persona | `cordis.patch.yml`, the `persona` row's `prefix` | every boss request |
| the office tool schemas | `index.js`, each tool's `description` and its parameter `description`s | every request of every office session |
| the onboarding turn | `index.js`, `greet()` | every request of a hired colleague, for the life of its history |

The split of responsibility is the rule that keeps them from growing back:

- A tool's `description` says **when** to reach for the tool and what its result means. It does
  not restate a parameter's allowed values, and it does not restate an error the tool already
  reports.
- A parameter's `description` says what the value is. A default or an enum is stated once, in the
  parameter that declares it.
- Recovery advice belongs in the thrown error, which is read exactly when it is needed and costs
  nothing until then. `office_dm`'s refusal of a wake level, for instance, names `office_post` as
  the tool that does take one.
- Behaviour that is a *norm* rather than an interface — never post to acknowledge a message —
  is stated once, in the onboarding turn, and only in the compressed form the tool description
  needs.
- The onboarding turn states the colleague's place and those norms, and deliberately does not
  enumerate the tools the role holds. The scope's own schema declares them, and the turn stays in
  the colleague's history for the life of its session, so a copied catalog would be paid on every
  later request. The role still decides the tool set; the turn only stops restating it.

Shared parameters are declared once, by a builder, so a wording change lands in every tool that
carries them: `officeArgument()`, `roleProperty()`, `descriptionProperty()`, and
`notifyProperty()`. The `office` argument is the one worth watching, because a boss emits it in
all eighteen tools.

Measured with the literals concatenated the way the model receives them:

| surface | before | after |
|---|---:|---:|
| a boss's eighteen tool schemas | 14,725 | 9,061 |
| a member's six tool schemas | 6,560 | 3,468 |
| the boss persona | 1,080 | 779 |
| a member's onboarding turn | 1,607 | 1,143 |
| a leader's onboarding turn | 2,248 | 1,408 |

Output schemas are not part of these figures: a canonical request carries `parameters` only, so
`output.schema` costs nothing outside PTC presentation.

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
`office-message`, except on a `step-end` splice, which claims `user` so the Web Chat draws it as an
in-turn message instead of as invisible injected context; the session read path requires a nonempty
source `kind` and does not constrain its value, which makes this the only model-visible channel open
to the plugin. See [delivery.md](delivery.md) for the payload, its JSON rules, and what claiming
`user` costs.

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

## One required wake, and the ladder a level climbs

Three surfaces used to answer "who hears this?" three different ways: `office_post` took
`mentions` plus a `mention_all` flag whose default flipped depending on whether `mentions` was
present, `office_dm` took a single `to`, the panel derived an audience from the body's `@` names
and a **Wake everyone** checkbox, and the idle notice hardcoded the `leader` role in code. The
audience is one question and it now has one answer: a **required** `wake` argument, on every tool
that stores a message and in the row config of the notice. Required, not defaulted, because every
default that was tried here was wrong — waking the whole office by omission spends a turn of every
colleague, and waking nobody by omission hides the message from the people it was written for.

`wake` names colleagues (`["@alice", "@bob"]`) or one level (`["#consultant"]`, `["#member"]`,
`["#leader"]`), never both. Two spellings, one meaning: a **level is the lowest rung it may
reach**, so it wakes its own privilege and every rung above it. That direction is the point. A
level is not "the members", it is "at least the members", which is what makes it an escalation
ladder rather than three more names for the three roles: `#consultant` therefore reaches the whole
office.

The rungs are ordered by the **session permission** a role runs under, not by its office
capabilities, and that is the one place the two axes of the role model disagree: `member` and
`consultant` hold exactly the same tools, while the default map runs the consultant's session
`read-only`. The consultant is therefore the bottom rung — the least authority reaches the most
colleagues — and `#member` stops below it. Reading the ladder off the capability table instead
would make `#member` and `#consultant` equal, which is a ladder that cannot be climbed.

Two rules narrow a level and neither narrows a name. A level is scoped to the channel it is posted
to, because a group channel's members already decide who a post there wakes; naming a colleague is
addressing that colleague, and the channel does not get between them. And no session is ever in its
own audience, which the old `mention_all` path enforced and the named path did not. `office_dm`
accepts names only: a private message is one conversation, and a rung is reached with
`office_post`, so a level there is refused with a message that says where to go instead.

`wake: []` is a decision rather than an omission — it writes the message to the record and wakes
nobody. It replaces `mention_all: false` and `mentions: []`, which is what kept the office's own
history from being a side effect of its notifications: a note worth storing but not worth a turn
still needs a spelling.

The panel keeps deriving its audience from the **stored body** and sends no audience of its own,
because that invariant is what stops a client from waking a colleague the message does not address.
It had to grow the same vocabulary to do it: `#` opens the three levels where `@` opens the roster,
`levelsIn` resolves them by the boundary rule `mentionsIn` uses, and the **Wake everyone** checkbox
went away rather than being kept in step with the server — a check box cannot express "at least the
members", and a token in the body can. The message record carries the level it addressed in
`audience`, which is how the panel colors a level token only where it actually decided the wake
(see [data-model.md](data-model.md)).

## Group channels and the `channels` capability

Beside the standing `#general` and the mailbox, the boss and the leaders can build **group**
channels: shared feeds whose stored `members` decide who may read them, who may write to them,
and whom a post there wakes. A group channel is a `dm` with more than two people and a public
name — the same membership record answers every question, `visibleChannels` is the same filter,
and the wake audience is the same list. The boss is privy to every channel it manages, `#general`
records no members because every colleague belongs to it, and the mailbox stays the one channel
no colleague can read through a tool.

The three management tools — `office_channel_create`, `office_channel_delete`, and
`office_channel_members` — are the `channels` capability: the boss holds it because it runs the
office, and a leader holds it because building and tending the channels an office carries is the
growth of the record that role curates. `office_channels`, the listing tool, holds no gate at all:
every role holds it, because a colleague that cannot find a channel it belongs to cannot take part
in it, and the listing reports exactly the channels the caller is allowed to read — never more.

Deleting a group channel deletes its messages with it, which is deliberate: a feed that the office
no longer holds would otherwise keep history no tool could address, and the holds it owed its
members are dropped rather than left stranded unread. Deletion is a boss and leader act through
the same capability as creation. Every member a tool or route stores must resolve to a colleague
of the office at the write, so membership cannot drift out of the roster by a typo; a colleague
that is dismissed leaves its stored membership behind, but it loses the office tools at the same
moment, so the stale entry is inert rather than a doorway.

## The panel's channel column

The panel reads one channel at a time, and one `state` request carrying that channel is what feeds
it. Two rules keep a switch a decision rather than a race, and both matter only when a reader
switches while a poll is in flight.

**An answer is published only while it answers the question still being asked.** A poll already in
flight for the channel the reader left arrives afterwards carrying that channel's messages, and the
panel treats the answered channel as the one to read. Publishing it therefore made the panel follow
a channel the reader had left, ask for it, receive the answer to the channel they had chosen,
follow that, and ask again — a ping-pong between two channels that never settles, because each
answer legitimately contradicts the request the other one was for. Every round also threw the whole
snapshot away, which is what a reader saw as the panel reloading without end, and the last round
tripped the stored choice. The published snapshot is therefore tagged with the office and the
channel it was asked for, and an answer that names anything else is dropped.

**The reader's choice is authoritative while its answer is on its way.** The column draws the
channel that was chosen, not the last one answered, so the server's own fallback — a channel
deleted or renamed while it was stored — still converges: that answer *is* the current one, so the
panel follows it and stores it. A superseded answer can no longer write the stored choice, which is
the channel the panel reopens on and therefore the difference between a preference and a race.

Only the messages in a snapshot belong to one channel. The roster, the channel list, the mailbox,
and the options the dialogs offer belong to the office, so a switch keeps them on screen rather
than blanking the panel and refilling it a round trip later. The same distinction decides who the
roster **column** holds: `#general` records no members because every colleague belongs to it, so it
lists the office roster, while a group channel's stored membership is exactly who may read it and
is therefore who the column lists. The composer's `@` menu is deliberately not scoped that way:
naming a colleague addresses that colleague wherever the post goes, and a level posted into a
channel is already narrowed by that channel's membership.

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

Every tool that carries a message takes `notify: 'step-end' | 'turn-end'`, and a call that names
none gets `step-end`. The two things a colleague can be sent are genuinely different questions:
*change what you are doing* cannot wait for the turn to end without arriving useless, and *answer
this afterwards* is what a held, merged turn is for. The office's default is the first, because a
notification that waits for a turn to end answers something the colleague has already moved past:
reaching a colleague while it works is what a notification is for, and the merge is the option a
caller asks for when the message can wait.

`step-end` is the only way an office wake is ever spliced into a turn that is already running, and
three harness contracts make it safe rather than a fire-and-forget splice:

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

**`office_post` carries the timing too, and that reversed an earlier decision.** The first version
refused it there, because one public post reaches every busy colleague, so the timing turns a
single message into a splice into every run in the office at once — and because a default
`step-end` takes the merged burst away from every caller that does not ask for it, which is the
turn-count damper against a wake loop. That reasoning still holds about what is given up; what
changed is the weight of what it bought. A held turn answers a message the colleague has already
moved past, and the common case in this office is a correction or a fact that is worth more before
the work it is about than after it. So the timing is offered on every carrying tool and defaults
to reaching the colleague, the merge is one argument away, and the same default reaches the panel
route, which has no timing control of its own. A caller that broadcasts should expect every busy
colleague to read it at its next step boundary.

What each timing looks like to a human watching the receiving session is a presentation choice the
office has to make, because the Web Chat draws a message whose source is not `user` as invisible
injected context: the `step-end` splice therefore claims `user` to become an in-turn message, while
every delivery that opens a turn keeps `office-message` and stays the visible trigger it already is.
[delivery.md](delivery.md#what-the-receiving-sessions-chat-shows) records the trade that claim
makes.

## Reading what is held, in the middle of a turn

A hold is invisible to the colleague it is held for. That is the point of holding it — the
colleague is working, and the office will not interrupt — but it also means a colleague has no way
to notice that something arrived, and `office_colleagues`, which reports how many messages are
held for each colleague, reports them to the office rather than to their recipient.
`office_read_notifications` closes that: it returns what the office is holding for the **calling**
colleague and releases it, so the colleague reads its mail at a step of its own choosing rather
than waiting for the turn to end.

Three properties decide its shape:

- **It is not a capability.** What the office holds was addressed to that colleague alone, so no
  role gate applies and every predefined role holds it, exactly as every role holds `office_read`.
  It also takes only the caller's own holds: there is no argument naming a colleague, because a
  boss able to drain a colleague's mail would be able to answer for it.
- **It is a read, and a delivery.** The tool result *is* the delivery, so the hold is released and
  the sender's recorded outcome becomes `delivered` with a detail naming the read; leaving it
  `queued` would report a message as unread for ever. The frame the colleague receives is the one a
  wake would have carried, answering rule included, so what a colleague reads does not depend on
  whether it waited or asked.
- **It takes the delivery, never the message.** The message stays in its channel, where
  `office_read` finds it, so a colleague that reads its notifications and then loses its turn has
  lost nothing: the office gave up a delivery it can no longer make twice, not a record. The one
  state that must not be read twice is the race between a step claiming a `step-end` wake and the
  office deleting the hold for it; the colleague's session log settles it, exactly as it settles
  the recovery case.

## Why the office asks a question of its own

Every message the office stores was written by somebody: the user, or a colleague with something to
say. The one message the office writes itself exists for a case it is otherwise blind to — the
whole roster has stopped, and nothing in the record says what comes next. No colleague can notice
that on its own: the ones who would notice are idle, and an idle session has no turn to notice
anything in. `idleNotice`, off by default on every office row, is the office taking that turn for
them: it posts one question to `idleNotice.channel`, addressed to `idleNotice.wake` — the colleagues
at the `#leader` rung and above, unless the row asks somebody else — and asks them to decide what
happens next.

Three properties decide its shape.

- **It is triggered by a colleague's turn ending, never by a clock.** The office listens for the one
  moment the question is meaningful — a colleague becoming idle — and then asks whether the whole
  roster has stopped. `inactive` counts as stopped: a colleague whose session is not loaded has no
  turn to be in either state of. Nothing polls, so an office nothing happens in costs nothing, and
  there is no interval for a deployment to tune. The office also asks once at activation, which is
  what makes switching the feature on take effect without waiting for work that may never come.
- **It cannot repeat on its own, and that is deliberately not configurable.** The notice wakes its
  audience, their turns end, and the office is idle again with the record it had before — so "ask
  whenever everyone is idle" would ask for ever, spending a turn of every colleague it addresses
  every turn-latency to be told there is nothing to do. The office therefore asks only when
  something was written since it last asked, which makes work the thing that arms the next
  question: a colleague's post, the user's next request, a compaction, anything that lands in
  `messages`. What it compares is a message identity rather than a timestamp, for the reason in
  [data-model.md](data-model.md): the work that arms a notice and the notice itself can be written
  in the same millisecond, and a clock cannot tell those two apart — it would either repeat the
  question for work the leaders were already told about, or hide work from them for ever.
- **It is an ordinary stored message, authored by the office, addressed like any other.** It is
  written to a channel, so it is in the record where `office_read` finds it and where the panel
  shows it, and its audience answers it the way they answer anything else. Its audience is the
  row's own `wake`, so asking a different rung is a config change rather than a second mechanism;
  a `wake` that could reach nobody is refused when the row loads, because an enabled notice nobody
  receives asks nothing. Its sender is `office`, with no session id: naming the user would read as
  the user speaking, and naming a colleague would attribute the office's question to that
  colleague.

Two conditions are refusals rather than defaults. `wakesEnabled: false` is a promise that no session
is ever woken, and a question nobody is woken for is not a question, so such an office writes
nothing. And a configured channel the office does not hold fails the send rather than the question:
the office reports it and asks again at the next idle transition, so a deployment that renamed or
deleted the channel finds out instead of wondering why its leaders went quiet.

The notice runs **after** the wake flush of the same idle transition, because the two are ordered by
what they know: a colleague that has just been handed held mail is working again, and asking the
leaders while the office is still moving asks about a state that no longer holds.

