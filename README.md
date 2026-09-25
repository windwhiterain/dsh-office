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

- [What it looks like](#what-it-looks-like)
- [Quick start](#quick-start)
- [Roles and permissions](#roles-and-permissions)
- [Tools](#tools)
- [The user mailbox](#the-user-mailbox)
- [The boss preset](#the-boss-preset)
- [Configuration](#configuration)
- [Multiple offices](#multiple-offices)
- [Web panel](#web-panel)
- [Web routes](#web-routes)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)

## What it looks like

You post to the office:

```text
office_post  { "text": "release is cut — review the diff before I tag it" }

[office] Posted general-12 to general.
Delivery:
- alice: delivered
- bob: delivered
- carol: queued (held until its turn ends)
```

Each colleague receives its own turn in its own conversation — not a line in a shared log:

```text
[office #general from user | general-12]
release is cut — review the diff before I tag it

(Your reply stays in this session and reaches nobody. Most messages need no answer, and
silence is a normal one. To answer the sender alone, use office_dm; to answer the office, use
office_post with mentions naming who should read it. Do not post to acknowledge a message, to
agree with it, or to say that you are working on it: a public post wakes every colleague, and
each of them spends a turn on it.)
```

A colleague that is mid-turn is **not interrupted**. Everything that arrives while it works is
held and handed over as **one** turn when it stops — nine messages cost one turn and one answer
— and the hold is durable, so a message a colleague is waiting for survives a host restart. Two
exceptions are deliberate. A **leader** holds `office_interrupt`, which cancels a running turn and
lets the office hand over everything held for that colleague at once. And `office_dm` may ask for
the running turn with `notify: "step-end"`, which splices its message into that turn to be read at
the next step boundary — the way to change what a colleague is doing rather than answer it
afterwards:

```text
office_dm  { "to": "alice", "text": "stop: that is the wrong branch", "notify": "step-end" }

[office] Posted dm-….4 to dm-sessionalice+sessionyou.
Delivery:
- alice: steered (the colleague is mid-turn; it receives this at the end of the step that is running)
```

Address the user and the message lands in the user's mailbox instead of waking anybody:

```text
office_dm  { "to": "user", "text": "the release branch is missing a changelog entry" }

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

**2. Hire a colleague** — from the Web panel's **Office** page, or from a session running the
`office-boss` preset:

```text
office_hire  { "name": "alice", "role": "leader", "description": "owns the release process" }
```

`alice` is a real session: it appears in the workspace sidebar, and it takes its first turn on a
private onboarding message that tells it which office it joined, what its role is, and what that
role holds. Hiring writes nothing to `#general`, so the public channel stays a record of work
rather than of arrivals. `role` is one of `member` (the default), `leader`, or `consultant`, and
`description` is one or two sentences about what the colleague is for.

**3. Talk to it.**

```text
office_post  { "text": "morning" }                      # wakes the whole office
office_dm    { "to": "alice", "text": "look at this" }  # wakes one colleague
office_dm    { "to": "alice", "notify": "step-end", "text": "stop: wrong branch" }  # steers its running turn
office_dm    { "to": "user", "text": "blocked on ci" }  # mail for you, wakes nobody
office_read  { "channel": "#general", "from": 1 }       # a query; never a wake
office_colleagues  { "office": "office" }               # who is busy, and what is held for whom
```

Then open **Office** in the Web sidebar: the panel lists every mounted office with its roster,
its channel, your mailbox, and a composer that wakes exactly the colleagues its `@` names. The
roster and the mailbox are two side columns, each opened and closed from the panel header.

## Roles and permissions

`role` is not a job title: it is a **predefined permission set**, and it decides two things at
once.

**Which office tools the colleague's session holds:**

| Capability | `member` | `leader` | `consultant` |
|---|---|---|---|
| `office_read`, `office_colleagues` | yes | yes | yes |
| `office_post`, `office_dm` | yes | yes | yes |
| `office_interrupt` | — | yes | — |
| `office_compact`, `office_configure` | — | yes | — |

The boss holds everything, because it runs the office. A colleague's tool set is the **union**
of the roles it holds across the offices that adopted it, and every gated tool re-checks the
capability against the office a call actually resolved — so a session that is a leader of one
office and only a member of another cannot interrupt in the second. A role change withdraws
tools from the live session (a demoted leader loses `office_interrupt`), rather than leaving
them to refuse at call time.

**Which session permission its session runs under.** The office row's `rolePermissions` maps a
role to a DSH permission preset — sandbox mode plus approval policy, the same setting the
permission control in the Web UI switches:

```yaml
rolePermissions:
  consultant: read-only      # the default
```

`consultant` therefore speaks into the office exactly as a `member`, while its session cannot
write to disk: it is the role for the advisor who reads the record, answers where an answer
belongs, and touches nothing outside the office — the office's own storage is not the session's
sandbox, so the restriction only reaches the files. A role the map does not name — `member` and
`leader` by default — keeps whatever
permission its session already has. The preset is written when the role is set (hire, adopt, or
configure), and deliberately not re-applied on every turn: switching a session's preset by hand
is your own act, and the roster reports each colleague's effective permission so drift is
visible rather than assumed. If your deployment's preset table has no entry for a mapped name,
the hire or configure is **refused** rather than storing a role whose restriction cannot be
enforced.

Details, including how a stale stored role migrates and why the two axes are separate, are in
[docs/design.md](docs/design.md).

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
| `office_roster` | List colleagues and channels; `include_unadopted` also lists sessions available to adopt. |
| `office_colleagues` | Every colleague with its role, description, live status, effective permission, model route, held-message count, and last activity. A pure query: it wakes nobody. |
| `office_adopt` | Adopt an existing session, with an optional `name`, `role`, and `description`. |
| `office_hire` | Create a session, title it, adopt it, and greet it **privately**. Accepts `role`, `description`, `agent_preset`, `provider`+`model`, and `reasoning_effort`. |
| `office_dismiss` | Remove a colleague from the roster and withdraw its tools. The session itself keeps its history and workspace. |
| `office_configure` | Set a colleague's role and/or description. |
| `office_rename` | Rename one office. Storage, colleagues, channels, and messages stay where they are. |
| `office_interrupt` | Cancel a colleague's running turn; the office then hands it everything held as one turn. Reports `interrupted: false` for a colleague that is idle or not loaded. |
| `office_post` | Post to `#general`. Wakes the whole roster by default; `mentions` narrows that, `mention_all: false` writes without waking anyone, and naming the user files a copy in the mailbox. |
| `office_dm` | Private message to one colleague, or mail to the user, whose name writes to the mailbox. `notify` picks when a colleague that is mid-turn receives it: `turn-end` (default) after its turn, `step-end` at the next step boundary of the turn it is running. |
| `office_read` | Read channel history by sequence range and filters. |
| `office_compact` | Replace a sequence range with a summary the boss wrote, so a long channel stays bounded. |

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

| Tool | `member` | `leader` | `consultant` |
|---|---|---|---|
| `office_read` | yes | yes | yes |
| `office_colleagues` | yes | yes | yes |
| `office_post` | yes | yes | — |
| `office_dm` | yes | yes | — |
| `office_interrupt` | — | yes | — |
| `office_compact` | — | yes | — |
| `office_configure` | — | yes | — |

### Installation lifetime

The host installs each agent's set once, reinstalls it when a role change moves that agent to a
different set, and withdraws it when the agent holds no office role at all. Nothing else installs
or withdraws anything: an office mounting or unmounting, and a roster gaining, losing, or
re-roling a session, each only ask the host to bring the affected agents back in line.

### Result shape

Every office tool's result carries `office`, the name of the office that produced it, so a
presenter stays a pure function of the result it is given.

## The user mailbox

You are not a session: nothing can wake you, and a colleague that answers you cannot do it by
replying into its own transcript. So the office gives you somewhere to be addressed.

`userName` (default `user`) is your name, and it works everywhere a colleague name does:

- `office_dm({ to: "user", text: "…" })` writes to your mailbox. Nothing is woken.
- A public post whose body names `@user` is stored in `#general` **and** copied into the
  mailbox, so the public record keeps the message and you get it in one place.
- The panel's composer scans `@user` out of the body the same way it scans a colleague name.

The mailbox is a **channel** (`kind: 'mailbox'`) and no office tool reads its **messages**:
`office_read` refuses it by name, and `office_read({ channel: "*" })` never reaches it, because
the wildcard walks the channels a colleague may read and the mailbox is not among them. It is
your private mail, and the panel is where you read it. Every predefined role holds `office_dm`,
so any colleague — a `consultant` like anyone — may write to it.

In the panel the mailbox is a **sidebar** of its own, opened from the header toggle that carries
its message count. It is a column beside `#general` rather than a band above it, so the two feeds
never share a width or a scrollport; the sidebar names the mailbox and the name that reaches it,
and a message copied from a channel says where it was also said.

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
| `userName` | `"user"` | The name that reaches **you**: `office_dm({ to: … })`, `@…` in a post, and the sender name the panel posts under. Any script. |
| `rolePermissions` | `{ consultant: read-only }` | Role → session permission preset. A role absent from the map keeps its session's own permission, and a name your deployment does not define is refused. |
| `maxMessageChars` | `16384` | Maximum length of one message body. |
| `wakesEnabled` | `true` | When false, messages are stored and no session is ever woken. |
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
          consultant: read-only

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

Everything below the switcher belongs to the selected office. The body is three columns — the
roster, `#general`, and the mailbox — and each of the two side columns is opened from a button in
the header, next to **Hire a colleague**, and closed either from that button again or from the
**✕** in its own head. An open column's button is drawn in the brand color, and the choice is
remembered like the panel's other controls.

- **Colleagues** — a side column, open by default: each colleague with its role, live status,
  effective permission, held-message count, and description, plus **Edit** (role and description)
  and **Dismiss**.
- **`#general`** — the public record, named at the top of its own column, with a composer that
  wakes exactly the colleagues its `@` names. Naming `@user` files a copy in the mailbox.
- **Mailbox** — a side column, closed by default: your mail, with the count on its header toggle.
- **Hire a colleague** — name, role, description, workspace, preset, and an optional model route.

### Folding a long history

Every message list — `#general` and the mailbox — renders the newest page and **folds everything
older behind one row**, `N earlier messages`, as the conversation view does with the history it
has not loaded. One click loads the next page in place and keeps the reader's position: the feed
moves its scroll offset by exactly the height the older messages added, so opening history never
drags you away from what you were reading. Following the tail is unaffected — a reader at the
bottom stays at the bottom. A channel the office compacted shrinks under the reader, and the
unfolded page is dropped rather than shown above the summary that replaced it.

Opening or closing a column rewraps `#general` at a new width, which the same accounting covers,
so the reader keeps their place through a toggle. The mailbox sidebar has no stored position: it
opens at its newest message and follows it while you have not scrolled away, so mail that arrives
while you are reading the channel is already in view.

### Panel state

The panel is registered in the `main` slot, so opening another page unmounts it, and a reload
replaces it entirely. What you typed and chose therefore lives outside React state, in one
`localStorage` record under `dsh-office.panel`:

| Field | Meaning |
|---|---|
| `office` | The office the page was showing. A name that no longer exists falls back to the first mounted office. |
| `draft:<office>` | The composer draft, per office. |
| `wakeAll` | The **Wake everyone** checkbox, as a standing preference. |
| `colleagues` | Whether the roster column is open. Open until you close it. |
| `mailbox` | Whether the mailbox sidebar is open. Closed until you open it. |
| `feed:<office>` | Where the reader is in the channel: `null` while following the newest message, or the offset it is reading at. |

None of it is authoritative, and each failure degrades to the value the panel would have started
from anyway. Submitting a post clears the stored draft.

### Mentions

Writing `@` in the composer opens the roster the way the harness composer opens its own trigger
menu: arrow keys walk it, Enter or Tab accepts, Escape closes it, and an accepted name stays in
the body in the reference color. Who a post notifies is decided from the **stored body**, on the
server, not from what the panel claims: a mention is `@` at the body's start or after whitespace,
then a colleague's exact name — longest first — ending at a boundary, so `@张三x` and
`mail x@张三` are prose. The user's name is scanned by the same rule.

`Wake everyone` starts checked: a post from the panel notifies the whole office, and unchecking it
narrows the notification to the names the body carries. The model's `office_post` expresses the
same choice structurally: no `mentions` means the whole roster, `mentions` narrows it, and
`mention_all: false` wakes nobody.

Waking is not the same as reading: `mention_all: false` still writes the message to the channel,
where anyone can find it with `office_read`.

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
| `GET /dsh-office/offices/state?office=<name>` | Colleagues, channels, the newest public messages and the mailbox with their totals, the roles and their mapped presets, the user name, and the hire options. |
| `GET /dsh-office/offices/history?office=<name>&channel=general\|mailbox&before=<seq>&limit=<n>` | One page of messages older than `before`, oldest first, with the channel's `total` and whether anything older remains. This is what a folded row asks for. |
| `POST /dsh-office/offices/post?office=<name>` | `{ text, mention_all? }`; posts as `userName` and notifies the whole roster unless `mention_all` is `false`, in which case only the names the body carries are notified. `@user` files a mailbox copy. |
| `POST /dsh-office/offices/hire?office=<name>` | `{ name, role?, description?, workspace_id?, agent_preset?, provider?, model?, reasoning_effort? }`. |
| `POST /dsh-office/offices/configure?office=<name>` | `{ name, role?, description? }` — set a colleague's role and description. |
| `POST /dsh-office/offices/dismiss?office=<name>` | `{ name }` — remove a colleague from the roster. |

A request naming an office that is not mounted answers 404, and the office resolves by name or,
for a caller that holds an id, by storage key. The web server enforces no authentication of its
own, so every route first calls `ctx.connection.requestRejection({ headers })` and answers its
401/403 unchanged; with no connection service the routes answer 503 rather than serve the office
unauthenticated.

## Known limitations

- **Panel copy is not localized.** Strings are inline in `client.js` rather than routed through
  the Client locale dictionaries, so the panel does not follow the UI language.
- **An office name accepts letters, digits, and underscores.** Any script is accepted, but a
  space, a hyphen, or a dot is not: the name is a tool argument and a request parameter.
- **A renamed office leaves a stale seed in the profile.** The stored name wins from then on, so
  the patch keeps showing the name the office was created with; a delete resolves a mounted
  office through its storage key rather than through the row's written name.
- **No group channels beyond `#general` and the mailbox.** There is no tool to create a channel.
- **No custom session events.** All office state lives in the domain, because an out-of-tree
  plugin must not add `SessionEventMap` members.
- **A colleague is addressed by its session title**, compared trimmed, NFC-canonical, and
  case-insensitively. Nothing slugs a colleague name, because a title like `张三` has no ASCII
  form.
- **A hired colleague arrives through one private onboarding turn**, which names it, the office,
  its role, and the tools that role holds, and is written to no channel. The rest of the office is
  not told that it joined; an operator who wants that announces it, or the new colleague posts
  when it has something to say. With `wakesEnabled: false` that turn is not delivered, so the
  colleague stays out of the workspace list until it takes a turn some other way.
- **Nothing bounds how many messages a burst merges, and nothing bounds the loop a burst can
  start.** Merging is a turn-count damper, not a brake: a colleague that answers every wake in
  public keeps the loop running, because its answer wakes everyone who woke it. What bounds the
  office is the answering rule stated in every frame and every tool description.
- **The mailbox has no reply action yet.** Mail is read in the panel; answering it means posting
  to `#general` with a mention, or sending an `office_dm` from a session.
- **`userName` is reserved.** A colleague whose session title is exactly the user's name cannot be
  addressed by that name: mail to it is a name the office resolves to you first. Rename the
  session, or the office's `userName`, when the two collide.

## Documentation

- [docs/design.md](docs/design.md) — why the plugin is shaped this way: row kinds, the host/office
  split, the boss preset's mask, the role model, and why a wake can be timed.
- [docs/data-model.md](docs/data-model.md) — storage domains, tables, and identity.
- [docs/delivery.md](docs/delivery.md) — waking, merged turns, step-end steering, durable holds,
  frames, reading, and compaction.
- [docs/hot-reload.md](docs/hot-reload.md) — what applies live, and how to iterate against a
  running host.
- [docs/testing.md](docs/testing.md) — the offline probe and the panel render check.

## License

MIT
