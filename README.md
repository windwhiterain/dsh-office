# dsh-office

**A persistent office of colleague agents for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Harness sessions are isolated, and a subagent dies with the task that spawned it. `dsh-office`
turns sessions into **colleagues** instead: a roster you can hire into and dismiss from with a
predefined role each, one public channel, a private channel between any two colleagues, a
**mailbox** for everything addressed to you, and delivery that wakes a colleague when something
is addressed to it.

A colleague is not a new kind of agent. It is an ordinary DSH session with a title — the title
*is* its name — so it keeps its own context, its own model, its own tools, and its own
workspace. The office is what outlives all of them: the roster, the channels, and every message
live in the office's own storage domain, so dismissing a colleague, restarting the host, or
deleting a workspace never loses the office's history or its identity. An office is addressed by
its **name**, in any script; an internal id — never the name — is the storage key behind it.

The package is **third-party**: it imports nothing from the harness and reaches every capability
through the Cordis context, so it survives harness upgrades.

- [dsh-office](#dsh-office)
  - [What it looks like](#what-it-looks-like)
  - [Quick start](#quick-start)
  - [Roles and permissions](#roles-and-permissions)
  - [Who a message wakes](#who-a-message-wakes)
  - [Tools](#tools)
    - [The boss's complete tool set](#the-bosss-complete-tool-set)
    - [Colleagues](#colleagues)
    - [Installation lifetime](#installation-lifetime)
    - [Result shape](#result-shape)
  - [Channels](#channels)
  - [The user mailbox](#the-user-mailbox)
  - [The idle notice](#the-idle-notice)
  - [The boss preset](#the-boss-preset)
  - [Configuration](#configuration)
    - [The host row — row id `office-host`](#the-host-row--row-id-office-host)
    - [An office row — any other row id](#an-office-row--any-other-row-id)
  - [Multiple offices](#multiple-offices)
  - [Web panel](#web-panel)
    - [Folding a long history](#folding-a-long-history)
    - [Panel state](#panel-state)
    - [Mentions, levels, and channels](#mentions-levels-and-channels)
  - [Web routes](#web-routes)
  - [Known limitations](#known-limitations)
  - [Documentation](#documentation)
  - [License](#license)

## What it looks like

You post to the office:

```text
office_post  { "text": "release is cut — review the diff before I tag it", "wake": ["$member"] }

[office] Posted general-12 to general.
Delivery:
- alice: steered
- bob: steered
- carol: delivered
```

Each colleague receives its own turn in its own conversation — not a line in a shared log:

```text
[office #general from the user | wake $member | general-12]
release is cut — review the diff before I tag it

(if you need reply to your colleagues, use office tool with `wake` parameter.)
```

The frame names the sender as a colleague or as the user, states the wake the message was written
with — the token the sender addressed, or the colleagues a named wake resolved to — and carries
exactly one rule, in the second person: what a colleague writes itself reaches only the user, so
reaching a colleague takes an office tool. The wake is stated rather than left to the body, because
the body need not spell it at all: whether the reader was named, reached as a rung, or was in a
channel the message addressed is what decides if the message is the reader's to answer. The rules
that keep one post from waking the office again — silence is the normal
answer, answer where the message stands, never post an acknowledgement — are standing context
instead, in `office_post`'s description and in a prompt section the office contributes to each
armed colleague. A frame is written into the colleague's session, so a paragraph in it would be
copied into that history once per delivered message and re-sent with every later request; the one
line stays because the colleague reads it in the message it was just handed.

A colleague that is mid-turn is **not interrupted**. By default it reads the message at its next
step boundary — `steered`, above — so it hears about a correction while the work it corrects is
still running; `notify: "turn-end"` holds the message instead, and hands over everything that
arrived while the colleague worked as **one** turn when it stops, so nine messages cost one turn
and one answer, and the hold is durable across a host restart. Two other ways a colleague changes
what it is doing are deliberate: a **leader** holds `office_interrupt`, which cancels a running
turn and lets the office hand over everything held for that colleague at once; and a colleague
that wants what is held for it *now* takes it itself with `office_read_notifications`, rather than
waiting for the turn to end:

```text
office_read_notifications  {}

[office office] 1 notification was held for you, read here on request:

[office #general from the user | wake $member | general-12]
release is cut — review the diff before I tag it

(if you need reply to your colleagues, use office tool with `wake` parameter.)
```

Address the user and the message lands in the user's mailbox instead of waking anybody:

```text
office_dm  { "wake": ["@user"], "text": "the release branch is missing a changelog entry" }

[office] Posted mailbox-3 to the user's mailbox.
Delivery:
- user: mailbox (the user has no session to wake; the message waits in the user mailbox)
```

## Quick start

**1. Install the bundle** from a session in the profile that should run the office:

```text
plugin_manager  install_bundle  target: github:windwhiterain/dsh-office
```

That adds three rows: the `office-host` singleton, one office row named `office`, and the
`office-boss` agent preset. Disable any of them with `plugin_manager set_plugin`.

**2. Hire a colleague** — from the Web panel's **Office** page (which can also **adopt** an
existing session instead), or from a session running the `office-boss` preset:

```text
office_hire  { "name": "alice", "role": "leader", "description": "owns the release process" }
```

`alice` is a real session: it appears in the workspace sidebar, and it takes its first turn on a
private onboarding message that tells it which office it joined, what its role is, and how it
takes part. Hiring writes nothing to `#general`, so the public channel stays a record of work
rather than of arrivals. `role` is one of `member` (the default) or `leader`, and
`description` is one or two sentences about what the colleague is for. A `leader` is told one
thing more: the absolute path of [experience/README.md](experience/README.md), the notes written
for that seat, so the role arrives with what leading this office has already cost.

**3. Talk to it.**

```text
office_post  { "text": "morning", "wake": ["$member"] }       # wakes the whole office
office_dm    { "wake": ["@alice"], "text": "look at this" }   # wakes one colleague
office_post  { "text": "stop: wrong branch", "wake": ["@alice"], "notify": "turn-end" }
                                                              # holds it for alice's turn to end
office_post  { "text": "note for the record", "wake": [] }    # stored, wakes nobody
office_dm    { "wake": ["@user"], "text": "blocked on ci" }   # mail for you, wakes nobody
office_read  { "channel": "#general", "from": 1 }             # a query; never a wake
office_read_notifications  {}                                 # what is held for you, taken now
office_colleagues  { "office": "office" }                     # who is busy, and what is held for whom
```

Then open **Office** in the Web sidebar: the panel lists every mounted office with its roster,
its channel, your mailbox, and a composer that wakes exactly the colleagues its `@` names, the level
its `$` calls, or the channel its `#` names. The roster and the mailbox are two side columns, each
opened and closed from the panel header.

## Roles and permissions

`role` is not a job title: it is a **predefined permission set**, and its name is the key to two
independent decisions — which office tools the colleague's session holds, and, when the office row
maps it, which session permission that session runs under.

**Which office tools the colleague's session holds:**

| Capability | `member` | `leader` |
|---|---|---|
| `office_read`, `office_read_notifications`, `office_colleagues`, `office_channels` | yes | yes |
| `office_post`, `office_dm` | yes | yes |
| `office_interrupt` | — | yes |
| `office_compact`, `office_configure` | — | yes |
| `office_channel_create`, `office_channel_delete`, `office_channel_members` | — | yes |
| `ask_user_question` (the harness's own tool, not the office's) | — | yes |

The boss holds everything, because it runs the office. A colleague's tool set is the **union**
of the roles it holds across the offices that adopted it, and every gated tool re-checks the
capability against the office a call actually resolved — so a session that is a leader of one
office and only a member of another cannot interrupt in the second. A role change withdraws
tools from the live session (a demoted leader loses `office_interrupt`), rather than leaving
them to refuse at call time.

**Which session permission its session runs under.** The office row's `rolePermissions` maps a
role to a DSH permission preset — sandbox mode plus approval policy, the same setting the
permission control in the Web UI switches. It ships **empty**, because the two roles are defined
by the office capabilities they hold and not by how confined their sessions are, and it is the
extension point for a deployment that wants a role's own session narrowed:

```yaml
rolePermissions:
  member: read-only
```

A mapped role speaks into the office exactly as its capability set says while its session cannot
write to disk — the office's own storage is not the session's sandbox, so the restriction only
reaches the files, and no office tool is taken away by it. A role the map does not name — every
role, by default — keeps whatever permission its session already has. The preset is written when
the role is set (hire, adopt, or configure), and deliberately not re-applied on every turn:
switching a session's preset by hand is your own act, and the roster reports each colleague's
effective permission so drift is visible rather than assumed. If your deployment's preset table
has no entry for a mapped name, the hire or configure is **refused** rather than storing a role
whose restriction cannot be enforced.

**Which roles may ask the user a blocking question.** A colleague's session inherits the harness's
own tools from its preset, and one of them — `ask_user_question` — pauses the turn until a human
answers it. A colleague's turn is started by a delivered message and you are reading the office
rather than that colleague's Chat, so a question asked inside it waits for a human who is not in the
room. The office row's `askUserRoles` is therefore the list of roles whose sessions **keep** that
tool:

```yaml
askUserRoles:
  - leader                   # the default
```

Every other role asks by `office_dm` to your name, which writes the question to your mailbox where
nothing blocks on it; listing both roles keeps the tool everywhere, and an empty list takes it
from every colleague. The list is a list of *withdrawals*, not of grants: the office never mounts the
tool, so a role listed here in an office whose preset carries no `tool-ask-user` still holds none.
Across offices the lists vote as a union, the way the roles' capabilities do — a colleague keeps the
tool as soon as one office that adopted it lists the role it holds there, and loses it only when
every one of them leaves the role out. A boss is not in the list and cannot be: it runs the office,
and which global tools its own preset gives it is that preset's business. An entry that names no
predefined colleague role is **refused** at activation rather than ignored.

Details, including how a stale stored role migrates and why the two axes are separate, are in
[docs/design.md](docs/design.md).

## Who a message wakes

Every office tool that puts a message into the office takes a **required** `wake`, and nothing
wakes anybody by default. It has three spellings, and they are never mixed:

```text
office_post  { "text": "standup in ten", "wake": ["$member"] }
office_post  { "text": "leaders, the diff is ready", "wake": ["$leader"] }
office_post  { "text": "the diff is ready", "wake": ["@alice", "@bob"] }
office_post  { "text": "design review today", "wake": ["#dev"] }
office_post  { "text": "note for the record", "wake": [] }
office_dm    { "wake": ["@alice"], "text": "look at this" }
```

- **Names** wake exactly the colleagues they name, written as `@` and the session title. `@user`
  is you, and reaches the mailbox instead of a session.
- **A level** — `$member`, `$leader` — wakes every colleague at that rung **and every rung above
  it**, so the lowest level reaches the whole office. The rung is the role itself, so the ladder
  cannot drift from the capability table, and a level is an escalation rather than a second name
  for a role.
- **A channel** — `#general` or a group channel — wakes every colleague that channel holds,
  wherever the message is posted: `#general` is the whole roster, and `#dev` reaches the members of
  `dev` whether the post goes to `dev` or to any other channel. The mailbox and the `dm-…` channels
  are not addressable this way, because `office_dm` is how one colleague is reached; a body that
  spells `#mailbox` or a `dm-…` channel is prose.

| `wake` | who is woken |
|---|---|
| `["$member"]` | every colleague |
| `["$leader"]` | the leaders alone |
| `["#dev"]` | the members of the group channel `dev` |
| `["#general"]` | every colleague |
| `["@alice", "@bob"]` | exactly those two colleagues |
| `[]` | nobody; the message is stored for whoever reads it |

A level and a channel each stand alone: combining either with names, or with the other, is refused
rather than unioned, because each of them already decides the whole audience. A name that matches
nobody is refused too, rather than dropped. **An empty list is a decision rather than an omission**
— it writes the message to the record without waking anyone, which is how a note nobody has to read
just now is posted. No caller is ever in its own audience.

A level is scoped to the channel it is posted to, exactly as a channel's own broadcast is: in
`#general` it reaches the whole roster, and in a group channel only that channel's members among
the rung it names. A channel token is scoped to the channel it names instead, wherever the message
is posted, and it may name a channel its sender is not in: an address is not a read, exactly as
naming a colleague is. A named colleague is not scoped at all, because naming one is addressing it.
`office_dm` names exactly one colleague and refuses a level and a channel alike: a private message
is one conversation, and `office_post` is how a rung or a channel is reached.

## Tools

**No office tool is global.** Each is installed into one agent's own scope according to the role
it holds there, so a session with no office role sees none of them. The **host** installs them;
an office row registers no tool at all.

**Tool names carry no office.** There is one `office_post`, not one per office: the office is an
*argument*. This is forced, not stylistic — a scope rejects a duplicate tool name
([`NamedTools`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts)),
so N independent office rows could not each register `office_post`.

A **boss** must name the office it acts on; a **colleague** may omit it, because it is routed to
the office that adopted it. Every failure names the offices the caller may act on, so a caller
that guessed wrong recovers in one step.

### The boss's complete tool set

Installed into an agent whose session preset is *any* mounted office's `bossPreset`.

| Tool | Purpose |
|---|---|
| `office_list` | List the offices this session runs, with their names and colleague counts. |
| `office_roster` | List colleagues and channels; `include_unadopted` also lists sessions available to adopt, each with its workspace and its sidebar title — archived sessions, and sessions no workspace accounts, are not offered. |
| `office_colleagues` | Every colleague with its role, description, live status — `running`, `idle`, `quota-retry` while it waits out an exhausted account quota, or `inactive` when its session is not loaded — effective permission, the agent preset it is bound to with the number of tools it holds (`none` means no preset tool at all: no shell, files, or skills), model route, held-message count, and last activity. A pure query: it wakes nobody. |
| `office_adopt` | Adopt an existing session, with an optional `name`, `role`, and `description`. |
| `office_hire` | Create a session, title it, adopt it, and greet it **privately**. Accepts `role`, `description`, `agent_preset`, `provider`+`model`, and `reasoning_effort`. |
| `office_dismiss` | Remove a colleague from the roster and withdraw its tools. The session itself keeps its history and workspace. |
| `office_configure` | Set a colleague's role and/or description. |
| `office_rename` | Rename one office. Storage, colleagues, channels, and messages stay where they are. |
| `office_channel_create` | Create a group channel: a shared feed whose members decide who reads it and who a post there wakes. Takes a name, an optional topic, and the session titles of the colleagues that start on it. |
| `office_channel_delete` | Delete a group channel the office created; its messages and the holds it owed go with it. The standing channels and the direct ones are refused. |
| `office_channel_members` | Add or remove a group channel's members, named by session title — or read the current members back with neither list. |
| `office_interrupt` | Cancel a colleague's running turn; the office then hands it everything held as one turn. Reports `interrupted: false` for a colleague that is idle or not loaded. A colleague waiting out an exhausted account quota holds a turn like any other, so it can be stopped too — the result names that wait, and ending it does not end the exhaustion. |
| `office_post` | Post to a channel: `#general` by default. `wake` **is required** and decides who hears it — names (`["@alice"]`), one level (`["$member"]`, `["$leader"]`), which wakes its rung and every rung above it, or one channel (`["#dev"]`), which wakes that channel's members wherever the post goes — and an empty list writes without waking anyone; naming the user files a copy in the mailbox. A group channel wakes only its own members among the ones the wake addresses. `notify` picks when a colleague that is **mid-turn** receives it: `step-end` (the default) splices it into the running turn to be read at its next step boundary, and `turn-end` holds it until the turn ends and hands it over merged with whatever else arrived. An idle colleague gets it now either way. See [Who a message wakes](#who-a-message-wakes). |
| `office_dm` | Private message to one colleague named by `wake` (exactly one, no level or channel), or mail to the user, whose name writes to the mailbox. Takes the same `notify` as `office_post`. The delivery reports the colleague's own status too, as the office read it *before* delivering — `idle`, `running`, `quota-retry` while it waits out an exhausted account quota, or `inactive` when this message is what woke it — so a sender learns why nothing comes back. |
| `office_read` | Read channel history by sequence range and filters, addressed by name, by a colleague's title for a DM, or by `*` for everything you can read. Each message states the wake it was written with — `· wake $member`, `· wake @alice`, or `· wake nobody` for a message that woke nobody — so a reader who was not notified can still see whether the message was aimed at it. |
| `office_read_notifications` | Take the notifications the office is holding for you, and read them now instead of at the end of your turn. Each is framed as a delivery, wake and all. |
| `office_compact` | Replace a sequence range with a summary the boss wrote, so a long channel stays bounded. |
| `office_channels` | List the channels this caller may read, with their kind, topic, and members. A pure query: it wakes nobody. |

Besides the office tools, the preset mounts **one persistent Git Bash** as `bash`: one shell
process per session, so environment, working directory, and history survive across calls. It
exists so a boss can read files a colleague produced; the boss still holds **no file or
search tools**.

That shell is the reason the preset **requires the `danger-full-access` permission mode**.
`terminal-bash` passes its argv through untouched only under that policy; every other mode
wraps it through `ctx.sandbox`, and under the Windows ACL restricted token an MSYS2 bash
cannot start at all, so the PTY never reaches readiness.

### Colleagues

Installed into every colleague's session, and into a session the moment it is adopted.

| Tool | `member` | `leader` |
|---|---|---|
| `office_read` | yes | yes |
| `office_read_notifications` | yes | yes |
| `office_colleagues`, `office_channels` | yes | yes |
| `office_post` | yes | yes |
| `office_dm` | yes | yes |
| `office_interrupt` | — | yes |
| `office_compact` | — | yes |
| `office_configure` | — | yes |
| `office_channel_create`, `office_channel_delete`, `office_channel_members` | — | yes |
| `ask_user_question` (the harness's own tool, which the office withdraws) | — | yes |

### Installation lifetime

The host installs each agent's set once, reinstalls it when a role change moves that agent to a
different set, and withdraws it when the agent holds no office role at all. The withdrawal of the
harness's `ask_user_question` is part of that set: it is installed with the office tools and lifted
with them, so dismissing a colleague hands the session back its own preset's tools. Nothing else
installs or withdraws anything: an office mounting or unmounting, and a roster gaining, losing, or
re-roling a session, each only ask the host to bring the affected agents back in line.

**A colleague's agent is not owned by the office row.** Waking a cold colleague resumes its session
through the process root context rather than the row's own, because Cordis binds a resumed agent's
teardown to the context the resume was made through: a row-owned colleague would be disposed by the
next source hot reload, profile-patch reload, or remount of that row — killed mid-turn if it was
working — and the harness reports that disposal as a removal from the Web session list. The office
is developed against a live host, so a generation reload has to be an event colleagues survive.

**A wake carries the colleague's own preset.** The harness mounts an agent preset only through the
`setup` a resuming caller hands `agents.resume()`, so the office passes one that mounts the preset
the session's log names — the same composition the Web surface builds. Without it a resumed
colleague holds no preset tool at all (no shell, no files, no skills, no delegation), which is a
live colleague that answers turns it cannot work with; a wake of a colleague found live *without*
that plane rebinds it instead, through the harness's own `recompose`. Either way a preset that
cannot be mounted fails the wake and says so.

### Result shape

Every office tool's result carries `office`, the name of the office that produced it, so a
presenter stays a pure function of the result it is given.

## Channels

The office ships two standing feeds: `#general` (`kind: 'public'`), which every colleague shares,
and the user's mailbox, which no tool reaches. The boss and the leaders build more with the
`channels` capability: a **group** channel is a shared feed whose stored members decide everything
about reach — a session reads it and is woken by a post there exactly as a member, `#general`'s
"every colleague" default becomes that channel's own member list, and a boss is privy to all of
them because it runs the office. A direct channel is created by the first message and needs no
management: its members are the two sessions talking.

Channels are addressed by name, `#` included or not, everywhere they are an argument:
`office_read`, `office_post`, `office_compact`, and the channels the panel's switcher lists.
A colleague's session title for a DM keeps the older address, and the mailbox is refused through
every spelling — a colleague may write to it, and nothing reads it.

## The user mailbox

You are not a session: nothing can wake you, and a colleague that answers you cannot do it by
replying into its own transcript. So the office gives you somewhere to be addressed.

`userName` (default `user`) is your name, and it works everywhere a colleague name does:

- `office_dm({ wake: ["@user"], text: "…" })` writes to your mailbox. Nothing is woken.
- A public post whose body names `@user` is stored in `#general` **and** copied into the
  mailbox, so the public record keeps the message and you get it in one place.
- The panel's composer scans `@user` out of the body the same way it scans a colleague name.

The mailbox is a **channel** (`kind: 'mailbox'`) and no office tool reads its **messages**:
`office_read` refuses it by name, and `office_read({ channel: "*" })` never reaches it, because
the wildcard walks the channels a colleague may read and the mailbox is not among them. It is
your private mail, and the panel is where you read it. Every predefined role holds `office_dm`,
so any colleague — a `member` like anyone — may write to it.

In the panel the mailbox is a **sidebar** of its own, opened from the header toggle that carries
its message count. It is a column beside `#general` rather than a band above it, so the two feeds
never share a width or a scrollport; the sidebar names the mailbox and the name that reaches it,
and a message copied from a channel says where it was also said.

## The idle notice

An idle session has no turn to notice anything in, so an office in which everybody has stopped has
nobody left to say what comes next. `idleNotice` gives the office one turn of its own: when a
colleague's turn ends and the whole roster has stopped, and something was written since the office
last asked, it posts one question addressed to the row's own `wake` — the leaders by default.

The office row carries the whole notice. It is off by default, so the example opts in and restates
the values it would otherwise inherit:

```yaml
idleNotice:
  enabled: true
  channel: general
  wake: ['$leader']
  text: >-
    The office is idle. Leaders, decide what happens next — post the work and who takes it, waking
    whoever it concerns. If nothing should happen, answer nothing: the office asks again only after
    something new is written.
```

`wake` takes the same spellings every other message takes, so a deployment that would rather ask the
whole office writes `wake: ['$member']`, names colleagues outright, or names a channel; a notice
whose `wake` could reach nobody is **refused at activation**, because an enabled notice nobody
receives asks nothing.
The office asks once per idle transition at most, and only when the resolved audience is non-empty.

It is **off until an office row enables it**, because it spends one turn of every session it
addresses. A colleague receives it as an ordinary message in whichever channel `channel` names —
`#general` by default — with its own sequence number, so the panel shows it, `office_read` finds
it, and the colleagues answer it the way they answer anything else. It is authored by `office`
rather than by a colleague or by you.

Two things bound it.

- **It never repeats on its own.** The notice wakes its audience, their turns end, and the office
  is idle again with the record it had before. So the office asks only when something was written
  since the last notice, which makes real work — a colleague's post, your next request, a
  compaction — the thing that arms the next question. An office in which nothing happens, or in
  which the addressed colleagues answered without writing anything down, stays quiet instead of
  waking them again.
- **A silent office never asks.** `wakesEnabled: false` promises that no session is ever woken, and
  the notice is a wake; such an office writes nothing. A configured channel the office does not
  hold is reported and retried at the next idle transition, rather than ending the questions.

## The boss preset

The bundle's patch declares `office-boss`: a persona, the persistent shell rows, and
[`presets/boss-restrict.mjs`](presets/boss-restrict.mjs).

The Web panel is your own console and reaches the same operations through `/dsh-office/*`; it
does not need a boss session. The preset is the *agent-facing* route to that capability. Why the
persona's tool mask is a deny list, and why the shell path is resolved rather than pinned, are in
[docs/design.md](docs/design.md).

## Configuration

Each row's `config`, validated at activation. A field belonging to the other kind of row is
refused, not ignored.

### The host row — row id `office-host`

| Field | Default | Meaning |
|---|---|---|
| `readLimit` | `20` | How many messages `office_read` returns by default, and how many a panel feed shows before it folds everything older behind one row. |
| `readLimitMax` | `100` | Ceiling for the `limit` argument and for one unfold. |
| `bossPreset` | `"office-boss"` | Agent preset new offices inherit when the panel creates them. |
| `profilePatch` | launcher's | Overrides the profile patch the panel edits to create and delete offices. Without either source those routes answer 503. |

### An office row — any other row id

| Field | Default | Meaning |
|---|---|---|
| `officeName` | — | The office's **name**, and **required**: what the panel, the model, and every request address it by. Any script; letters, digits, and underscores. Never defaulted, so an override must restate it. |
| `officeId` | the row id | The office's **storage key**, matching `/^[a-z][a-z0-9_]*$/`. Renaming an office never changes it. |
| `bossPreset` | `"office-boss"` | Agent preset id whose sessions are this office's boss. |
| `userName` | `"user"` | The name that reaches **you**: `office_dm({ wake: ["@user"] })`, `@…` in a post, and the sender name the panel posts under. Any script. |
| `rolePermissions` | `{}` (empty) | Role → session permission preset. It ships empty, because a role is defined by the office capabilities it holds rather than by how confined its session is, and it is the extension point for confining a role's own session without taking an office tool away. A role absent from the map keeps its session's own permission, and a name your deployment does not define is refused. |
| `askUserRoles` | `["leader"]` | Roles whose sessions **keep** the harness's `ask_user_question`. Every other role asks the user with `office_dm`, which reaches the mailbox instead of holding its turn open. The list withdraws rather than grants: an office whose preset mounts no such tool still gives none. Across offices the lists vote as a union, and a `boss` is not one of the roles — its preset decides its globals. An entry that names no predefined colleague role is refused. |
| `maxMessageChars` | `16384` | Maximum length of one message body. |
| `wakesEnabled` | `true` | When false, messages are stored and no session is ever woken. |
| `idleNotice` | `{ enabled: false, channel: "general", wake: ["$leader"] }` | The office's own question, asked when the whole roster has stopped and something was written since the office last asked; see [The idle notice](#the-idle-notice). `enabled` opts in per office, `channel` is where the question is posted, `wake` is who is asked — the same spellings `office_post` takes, and the leaders by default — and `text` is its body. The mailbox and the `dm-` idspace are refused, an unknown key inside the object is refused, and a `wake` that could reach nobody is refused rather than stored: an enabled notice that asks nothing of anyone is a mistake, not a setting. |
| `operatorName` | — | **Renamed to `userName`.** A row that still sets `operatorName` fails activation; the validation message names the fields the row accepts. |

## Multiple offices

One office is one `officeId`. Mounting the package with two office rows composes two fully
independent offices: separate domains, rosters, channels, and names. They share one tool set and
one route table, not one each.

```yaml
- insert:
    - id: office
      name: 'dsh-office'
      config:
        officeName: office
        bossPreset: office-boss
        rolePermissions:
          member: read-only

    - id: office_studio
      name: 'dsh-office'
      config:
        officeName: 工作室
        officeId: office_studio
        bossPreset: studio-boss
```

The second row must sit inside an `insert` list. The Loader appends a patch entry's `insert`
list to the tree, but reads an entry **without** one as an id-targeted override of a row an
earlier layer created: a top-level `- id: office_studio` therefore matches nothing and never
mounts — the office silently does not exist, with no failure anywhere you would look. Why that is
so, and how a delete decides between removing and disabling a row, is in
[docs/design.md](docs/design.md).

The panel's **Offices** control creates and deletes offices. Creating appends an `insert` list to
the profile patch and relies on the live configuration reload to mount it. Deleting erases the
office first and then acts on its row: a row inside an `insert` list is removed, a top-level
override of a mounted office is **disabled** (removing it would restore the layer's config and
leave the office mounted), and a dead top-level row is removed.

Deleting the last office is safe: the host is a separate row, so the panel keeps answering,
lists nothing, and can create the next office.

**Sharing one `bossPreset` across offices makes a single boss that supervises all of them.** Its
tool count is constant — the office is an argument rather than part of the name — and the offices
stay isolated: no shared roster and no shared channel.

## Web panel

`client.js` registers two Client slots: a `sidebar.panellist` icon and the matching `main`
panel, both under the id `office`. The page discovers the mounted offices from
`/dsh-office/offices` and shows a switcher across the top when there is more than one.

Until the selected office's first snapshot arrives the page is a **loading state with no control on
it**: a page whose roster is not known yet has nothing a click could mean, since the header's
buttons, every dialog, and the composer all act on what the snapshot carries. Only that first
answer gates — a later poll draws over a page that already resolved, so a refresh never takes the
controls away from a reader who is using them. A first answer that *failed* is not a page still
loading: it says so and offers **Retry**, which is the one control that state has.

A poll is also **dirty-only**. The snapshot carries an opaque token — its `revision` — that
describes everything the page draws, and the next poll hands that token back: while nothing it
describes has moved, the office answers `unchanged` in a few dozen bytes instead of rebuilding the
snapshot. Polls of one office and channel never overlap, so a slow answer cannot stack two more
behind it, while a channel switch is a different question and is asked at once. Opening one of the
panel's own dialogs asks for a full snapshot at that click, because what a dialog offers — the
sessions nobody has adopted, the workspaces, the presets, the models — changes without an office
write and so is not something the token compares. Once a minute the panel asks for a full snapshot
anyway, which is what catches any other fact no office write moved — a session renamed from the
sidebar, say.

Everything below the switcher belongs to the selected office. The body is three columns — the
roster, the channel, and the mailbox — and each of the two side columns is opened from a button in
the header, next to **Hire a colleague**, and closed either from that button again or from the
**✕** in its own head. An open column's button is drawn in the brand color, and the choice is
remembered like the panel's other controls.

Every message row carries its sequence number (`#12`), the number the office anchors a message id
like `general-12` on and `office_read` addresses a range with, so a human can cite an anchor
without a tool call, and beside its sender it states the wake the office recorded: the token the
post addressed (`$member`, `#dev`), the colleagues a named wake resolved to (`@alice @bob`),
`nobody` for a message that woke nobody, or `@<userName>` for a mailbox record. A message written
before levels moved to `$` records the old spelling and is shown as the level it means — `#leader`
reads as `$leader` — because `#name` addresses a channel today and a channel spelled after a role is
refused as a wake; a compacted-range summary states no wake at all, since it addresses nobody. Each
message view of the state route therefore carries `wake` and `channels` beside `mentions` and
`audience`.

- **Colleagues** — a side column, open by default: the colleagues the channel column holds — the
  whole office for `#general`, a group channel's own members — each with its role, live status
  (including `quota-retry` for a colleague waiting out an exhausted account quota),
  effective permission, held-message count, and description, plus **Edit** (role and description)
  and **Dismiss**. The header's count is the same list. A name is the session's listed title, read
  the way the Web session list reads it: a live session's own `title` projection, or the projection
  cache's row for one that is not loaded.
- **Channel** — the column the page reads, named by a switcher in its own head: `#general` and
  every group channel, one at a time, each with its own feed, composer, and stored reading
  position. A switch is one question — an answer to the channel you left is dropped rather than
  published, so the switch cannot be flipped back and the choice you made is the one that survives
  a reload. A post goes to the channel the switcher shows and wakes exactly what the body writes:
  the colleagues its `@` names, the level its `$` calls, or the channel its `#` names — a level is
  scoped to the channel it is posted to, the whole office for `#general` and the channel's members
  for a group one, while a channel token wakes that channel's members wherever the post goes.
  Naming `@user` files a copy in the mailbox.
- **Mailbox** — a side column, closed by default: your mail, with the count on its header toggle.
- **Channels** — the group channels the office holds: create one with a name and a topic, edit
  its members down a checkbox roster, and delete one, whose history goes with it. The office's
  two standing feeds are not listed here.
- **Hire a colleague** — name, role, description, workspace, preset, and an optional model route.
- **Adopt a session** — an existing session becomes a colleague, named by its title, with the role
  and description rows the hire and edit dialogs share. The picker lists the sessions the office
  has not adopted: sessions the workspace holds in its archive set, and sessions no workspace
  account holds, are never offered. One heading per workspace, the way the sidebar shows them;
  each entry reads by the title the sidebar's list rows show — the projected `title` for a live
  session, the projection cache row for a cold one — and an untitled session reads as
  `session-<short id>`, the name the office would address it by.

### Folding a long history

Every message list — the channel column, whichever channel it reads, and the mailbox — renders the
newest page and **folds everything older behind one row**, `N earlier messages`, as the
conversation view does with the history it has not loaded. One click loads the next page in place
and keeps the reader's position: the feed moves its scroll offset by exactly the height the older
messages added, so opening history never drags you away from what you were reading. Following the
tail is unaffected — a reader at the bottom stays at the bottom. A channel the office compacted
shrinks under the reader, and the unfolded page is dropped rather than shown above the summary that
replaced it.

Opening or closing a column rewraps the channel at a new width, which the same accounting covers,
so the reader keeps their place through a toggle. The mailbox sidebar is driven by the same
machinery as the channel: one follow intent with the same settled reader sampling, the same height
accounting for unfolds and a rewrap, a stored position under `mail:<office>` that a close and a
reopening restores, and the tail as the default it opens at when nothing is stored — so mail that
arrived while you were reading the channel is already in view.

### Panel state

The panel is registered in the `main` slot, so opening another page unmounts it, and a reload
replaces it entirely. What you typed and chose therefore lives outside React state, in one
`localStorage` record under `dsh-office.panel`:

| Field | Meaning |
|---|---|
| `office` | The office the page was showing. A name that no longer exists falls back to the first mounted office. |
| `channel:<office>` | The channel the page's channel column reads, per office; an id the office no longer holds falls back to `#general` in the snapshot itself. |
| `draft:<office>` | The composer draft, per office. |
| `colleagues` | Whether the roster column is open. Open until you close it. |
| `mailbox` | Whether the mailbox sidebar is open. Closed until you open it. |
| `feed:<office>:<channel>` | Where the reader is in one channel: `null` while following the newest message, or the offset it is reading at. |
| `mail:<office>` | Where the reader is in the mailbox, stored the same way `feed:<office>:<channel>` is. |

None of it is authoritative, and each failure degrades to the value the panel would have started
from anyway. Submitting a post clears the stored draft.

### Mentions, levels, and channels

Writing `@` in the composer opens the roster, `$` opens the wake levels, and `#` opens the channels
a wake may name, the way the harness composer opens its own trigger menu: arrow keys walk it, Enter
or Tab accepts, Escape closes it, and an accepted token stays in the body in the reference color.
Who a post notifies is decided from the **stored body**, on the server, not from what the panel
claims: a token is `@`, `$`, or `#` at the body's start or after whitespace, then a colleague's
exact name — longest first — one level, or the id of a channel the office holds, ending at a
boundary, so `@张三x` and `mail x@张三` are prose. The user's name is scanned by the same rule, and
only the public channel and the group channels are scanned at all, so a body that spells `#mailbox`
or a `dm-…` channel is prose rather than a wake.

That is the whole control: a panel post wakes the colleagues its `@` names, the level its `$`
calls, the channel its `#` names, or nobody when the body writes none of them. There is no
separate switch, because the audience is the body — and the model's `office_post` says the same
thing structurally, with the required `wake` argument
([Who a message wakes](#who-a-message-wakes)). Waking is not the same as reading: a post that wakes
nobody is still written to the channel, where anyone can find it with `office_read`.

A body that mixes the spellings — a colleague named beside a level or a channel, or a level beside
a channel — is refused rather than guessed at, and the refusal comes back in the composer.

The panel has no timing control, so its posts carry the office's default: a colleague that is
mid-turn reads a post from the panel at its next step boundary, exactly as it reads one from the
model. A caller that wants the message held for the turn to end — merged with whatever else
arrives before it — expresses that with `notify: "turn-end"` on `office_post`, which the panel has
no control for yet.

## Web routes

The panel reads two groups of routes registered on `ctx.webServer`.

**Host routes** — the registry, owned by the host, answering with any number of offices mounted
including none:

| Route | Purpose |
|---|---|
| `GET /dsh-office/offices` | Every mounted office as `{ id, name }`. |
| `POST /dsh-office/offices/create` | `{ name }` — append an `insert` list holding a new office row to the profile patch. |
| `POST /dsh-office/offices/delete` | `{ office }` — erase that office and act on the row that mounts it. |
| `POST /dsh-office/offices/rename` | `{ office, name }` — rename one office. |

**Office routes** — registered by the host beside the registry, with the office named by the
`office` query parameter, so one registration serves every office:

| Route | Purpose |
|---|---|
| `GET /dsh-office/offices/state?office=<name>&channel=<channel>&since=<token>` | Colleagues, channels (with their members), the newest messages of `channel` — `#general` unless the request names a group channel, and the fallback is the public feed — beside the mailbox with their totals, the roles and their mapped presets, the user name, the adoptable sessions with their workspaces and titles (archived or unaccounted ones never offered), and the hire options. The answer also carries the `revision` token that describes it: a request naming the token it already holds is answered `{ office, officeId, channel, revision, unchanged: true }` and nothing else, which is what makes a poll of an unmoved office a comparison rather than a snapshot. |
| `GET /dsh-office/offices/history?office=<name>&channel=<channel>&before=<seq>&limit=<n>` | One page of messages older than `before`, oldest first, with the channel's `total` and whether anything older remains. This is what a folded row asks for; `channel` addresses the group channels the same way the state parameter does. |
| `POST /dsh-office/offices/post?office=<name>` | `{ text, channel? }`; posts as `userName` to `channel` (`#general` unless named) and wakes exactly what the body writes — the colleagues its `@` names, the level its `$` calls, or the channel its `#` names; a level is scoped to the channel the post goes to, a channel token to the channel it names. The request carries no audience of its own, so no client can wake a colleague the message does not address. `@user` files a mailbox copy. |
| `POST /dsh-office/offices/hire?office=<name>` | `{ name, role?, description?, workspace_id?, agent_preset?, provider?, model?, reasoning_effort? }`. |
| `POST /dsh-office/offices/adopt?office=<name>` | `{ session_id, role?, description? }` — adopt an existing session, which the panel picks from the snapshot's unadopted list. |
| `POST /dsh-office/offices/configure?office=<name>` | `{ name, role?, description? }` — set a colleague's role and description. |
| `POST /dsh-office/offices/dismiss?office=<name>` | `{ name }` — remove a colleague from the roster. |
| `POST /dsh-office/offices/channels/create?office=<name>` | `{ name, topic?, members? }` — create one group channel, its members named by session title. |
| `POST /dsh-office/offices/channels/delete?office=<name>` | `{ channel }` — delete one group channel the office created; its messages and holds go with it. |
| `POST /dsh-office/offices/channels/configure?office=<name>` | `{ channel, topic?, members?: { add, remove } }` — set a channel's topic and edit its membership; each named field is applied only when sent. |

A request naming an office that is not mounted answers 404, and the office resolves by name or,
for a caller that holds an id, by storage key. The web server enforces no authentication of its
own, so every route first calls `ctx.connection.requestRejection({ headers })` and answers its
401/403 unchanged; with no connection service the routes answer 503 rather than serve the office
unauthenticated.

The state route's token describes what the snapshot draws — the roster with its live status and
held counts, the channels, the channel being read, and the mailbox — and it is derived from the
office's own records on each request rather than counted by the writers, so no write path can
forget to move it. What travels is a digest of those records, because the token is a query
parameter and a roster with its descriptions is kilobytes. It is **not stored**: a plugin reload
restarts every office's counters, which is exactly right, because the panel that held a token then
holds a stale one and is answered with a snapshot. A change the office never wrote — a session
renamed from the sidebar, a storage file edited by hand — moves no token, which is what the
panel's own periodic full read covers.

## Known limitations

- **The panel's roster names come from the title projections.** A deployment that mounts neither
  `sessionProjections` nor `sessionProjectionCache` has no listed title to read, so naming a
  colleague falls back to folding its session log — the read that made a poll of a ten-colleague
  office take as long as the office's whole history. The names are then correct and the page is
  slow, which is the trade the projection pair exists to avoid.
- **A fact no office wrote reaches the panel within a minute.** The token moves for what the
  office stores and for its colleagues' live state; a session renamed from the sidebar, or a
  storage file edited by hand, moves nothing, so the panel's own periodic full read is what shows
  it. A reader who wants it sooner reloads the page.
- **The idle notice has no panel control.** `idleNotice` is configured on the office row, so
  switching it on means editing that row's config; the panel neither shows it nor edits it.
- **The quota wait is reported, never ended.** A colleague's `quota-retry` status is read from the
  row that owns it, `dsh-llm-quota-retry`, by service name — the office is third-party and imports
  nothing from the harness or from another plugin, so a deployment that composes no such row reports
  the harness's own statuses and nothing else about the office changes. Reading the wait is not a
  promise about it: `office_interrupt` ends the colleague's turn, not the account's exhaustion, and
  the next request re-enters the same wait.
- **Panel copy is not localized.** Strings are inline in `client.js` rather than routed through
  the Client locale dictionaries, so the panel does not follow the UI language.
- **An office name accepts letters, digits, and underscores.** Any script is accepted, but a
  space, a hyphen, or a dot is not: the name is a tool argument and a request parameter.
- **A renamed office leaves a stale seed in the profile.** The stored name wins from then on, so
  the patch keeps showing the name the office was created with; a delete resolves a mounted
  office through its storage key rather than through the row's written name.
- **No custom session events.** All office state lives in the domain, because an out-of-tree
  plugin must not add `SessionEventMap` members.
- **A colleague is addressed by its session title**, compared trimmed, NFC-canonical, and
  case-insensitively. Nothing slugs a colleague name, because a title like `张三` has no ASCII
  form.
- **A hired colleague arrives through one private onboarding turn**, which names it, the office,
  and its role, and says how it takes part — and, when the role is `leader`, the absolute path of
  [experience/README.md](experience/README.md) — and is written to no channel. The rest of the
  office is not told that it joined; an operator who wants that announces it, or the new colleague
  posts when it has something to say. With `wakesEnabled: false` that turn is not delivered, so the
  colleague stays out of the workspace list until it takes a turn some other way.
- **That turn states nothing the colleague's own schema already says.** It does not enumerate the
  tools the role holds and it does not restate the answering rules, because the turn stays in the
  colleague's history for the life of its session and a copy is therefore paid on every later
  request. What it states instead is what a schema cannot: whether this colleague writes into a
  shared record or answers privately, that the office has a history nothing replays, and where the
  notes for its seat are. The role still decides the tool set; nothing else about the assignment
  changed.
- **An office colleague gets office standing prompt text, because its preset knows nothing about
  the office.** The office registers a delivery contract into each armed agent's own scope,
  alongside its tools and withdrawn with them: the office delivers a colleague's message as a
  private turn, what the colleague writes in its own turn is seen by the user alone, and only an
  office tool notifies a colleague. Without it a colleague's system prompt is its ordinary coding
  agent's, and the only office text it ever reads is a tool description it may not be reaching for.
- **A delivery frame names the sender and states the wake, and carries exactly one rule.** A message
  the human sent says `from the user`; every other sender says `from colleague <name>`. The wake the
  message was written with follows the destination — the token it addressed (`wake $member`,
  `wake #dev`), or the colleagues a named wake resolved to (`wake @alice @bob`) — which is what tells
  the reader whether it was named, reached as a rung, or was in a channel the message addressed, and
  therefore whether the message is its to answer. A read of history states the same clause, and adds
  `wake nobody` for a message that woke nobody. The trailing line states the
  one fact the colleague's next action depends on, in the second person: what the colleague writes
  itself reaches only the user, and only an office tool notifies a colleague. The paragraph it
  replaced, which held the answering rules and the acknowledgement rule, is standing context now: a
  frame is written into the receiving colleague's session once per delivered message, so a paragraph
  in it is re-sent with every later request for the life of that history. See
  [docs/delivery.md](docs/delivery.md#the-answering-rule) for why the one line stayed.
- **A leader's frame also reports how loaded the office is.** `Office parallelism: 2/5 — 5
  colleague(s) in the roster, 2 working.` is counted from the live registry at the instant the
  office hands the turn over — or, on `office_read_notifications`, at the call — never stored with
  the message and never cached, so the frame states the office it was written in rather than a
  reading that could go stale unnoticed. The roster is every colleague, loaded or not. Only a
  leader is told: the figure is what a colleague deciding what the office does next reads, and a
  member's frame is the message it has to answer. See
  [delivery.md](docs/delivery.md#the-load-line).
- **A leader is told that the roster moved, and not what it moved to.** One line — `Roster changed
  since you were last notified.` — says that a colleague was adopted, dismissed, renamed, or
  re-described since the office last told this leader, because a leader dispatches from what it
  knows about the people in the office. What changed is what `office_colleagues` answers; a listing
  in the frame would be copied into that session's history once per delivered message. A roster
  revision advances on each change and each leader's record carries the revision it was last told,
  so the line is said once per change rather than once per frame. See
  [delivery.md](docs/delivery.md#the-roster-line).
- **Only a hire carries the leader's guide.** A session that is *adopted* as a leader, or promoted
  by `office_configure`, takes no onboarding turn, so nothing ever tells it where the notes are;
  it learns the path from the office's own record or from the operator. The path is resolved
  against the installed module, so it follows the package wherever the profile links it.
- **A colleague cannot see that anything is held for it.** A hold is invisible by design — the
  office does not interrupt a working colleague — so a colleague that is running learns about held
  mail only by asking for it, with `office_read_notifications`. Nothing pushes it a notice that
  something is waiting.
- **A `step-end` splice claims `source.kind: "user"` so the receiving Chat shows it.** The Chat
  draws a message whose source is not `user` as injected context, and a context row is not a visible
  one, so a frame read mid-turn would appear nowhere; claiming `user` is what makes it a pending
  bubble and then an in-turn message. The cost is accepted and real: harness readers that take
  `kind === "user"` for a human at the keyboard — the `/name` skill gesture, goal authority, the
  jobs wake budget, the repeat-tool reminder, the session list's last-prompt time — now see office
  traffic too. Every other delivery keeps `office-message` and stays a visible turn trigger.
  [delivery.md](docs/delivery.md#what-the-receiving-sessions-chat-shows) has the details.
- **Nothing bounds how many messages a burst merges, and nothing bounds the loop a burst can
  start.** Merging is a turn-count damper, not a brake, and it is no longer what a default call
  gets: `turn-end` is the merge, and the default `step-end` splices each message into every busy
  recipient's running turn. A colleague that answers every wake in public keeps the loop running,
  because its answer can reach every colleague with one level. What bounds the office is the
  answering rules `office_post` states, and the judgement of the colleague reading them.
- **The mailbox has no reply action yet.** Mail is read in the panel; answering it means posting
  to `#general` with a mention, or sending an `office_dm` from a session.
- **`userName` is reserved.** A colleague whose session title is exactly the user's name cannot be
  addressed by that name: mail to it is a name the office resolves to you first. Rename the
  session, or the office's `userName`, when the two collide.

## Documentation

- [docs/design.md](docs/design.md) — why the plugin is shaped this way: row kinds, the host/office
  split, the boss preset's mask, the role model, and why a wake can be timed.
- [docs/data-model.md](docs/data-model.md) — storage domains, tables, and identity.
- [docs/delivery.md](docs/delivery.md) — waking, steering, merged turns, durable holds, frames,
  reading what is held, and compaction.
- [docs/hot-reload.md](docs/hot-reload.md) — what applies live, and how to iterate against a
  running host.
- [docs/testing.md](docs/testing.md) — the offline probe and the panel render check.
- [experience/README.md](experience/README.md) — leading a team that lives in this office:
  how to dispatch, how readings lie, and what to keep when someone leaves. A hired `leader` is
  handed this file's absolute path in its onboarding turn, which is why `experience/` ships with
  the package.

## License

MIT
