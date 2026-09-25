# Data model

The storage and identity contract: what one office owns, what each record holds, and what counts
as the same name. Why the storage is shaped this way is in [design.md](design.md); what the
office does with these records is in [delivery.md](delivery.md).

## One domain per office

One office is one **storage domain**, named by its `officeId`: one JSON unit at
`$DSH_HOME/storages/<officeId>.json`. The domain declaration carries `version: 1`, a `global`
slot, and four tables:

```js
{
  name: officeId,                       // the unit name; renaming the office never changes it
  version: 1,
  global: { schema, initial: { officeId, name } },
  tables: { colleagues, channels, messages, pending },
}
```

The unit is named by the id rather than by the name because the storage hub requires a unit name
to match `/^[a-z][a-z0-9_]*$/` — a backend turns it into a file-name or SQL-identifier segment —
while an office name accepts any script. The **global slot holds `{ officeId, name }`**: the name
is data, which is what lets an office be renamed without moving its storage.

The global is read on activation and treated as authoritative from then on:

- A stored `officeId` that differs from the configured one fails activation. The unit was opened
  for an office that is not the one configuring it, and no backend would notice, because the unit
  is closed and reopened between two rows.
- The stored `name` wins over `config.officeName`. The configured name seeds the global the first
  time the unit is written, and is not consulted again, so a rename outlives a restart.
- A storage written by an older version may carry the name under `label`; that value is read as
  the seed and rewritten as `name`.

The tables declare only a passthrough schema, because the domain facility calls nothing but
`valueSchema.parse` on stored records. Record validation therefore belongs to this plugin, and it
happens at the read: `validateColleague`, `validateChannel`, and `validateMessage` reject a
hand-edited medium loud, instead of letting a missing field surface later as a property access or
as a malformed tool result.

## Tables

| Table | Key | Record |
|---|---|---|
| `colleagues` | session id | `{ sessionId, role, description?, adoptedAt }` |
| `channels` | channel id | `{ channelId, kind, name, topic, members, createdAt, nextSeq }` |
| `messages` | `<channelId>#<seq>` | `{ messageId, channelId, channelName, kind, seq, senderName, senderSessionId?, recipients, text, createdAt, deliveries, covers?, replaced?, origin? }` |
| `pending` | `<sessionId>#<messageId>` | `{ sessionId, channelId, seq, at }` |

### `colleagues`

A record exists for every adopted session and for nothing else. `sessionId` is the key, so one
session is a colleague of an office at most once.

| Field | Meaning |
|---|---|
| `sessionId` | The colleague's session; the record key. |
| `role` | One of `member`, `leader`, `consultant`. Canonicalized on **every** write, so a stored value that is absent or no longer predefined reads as `member` and is rewritten as such. |
| `description` | Optional. Trimmed, at most 2000 characters, and removed entirely when the caller passes an empty string, so the field is absent rather than empty. It reaches the colleague's onboarding turn, the roster, and the panel. |
| `adoptedAt` | When the session entered the roster; preserved across a re-adopt or a role change. |

`validateColleague` requires `sessionId` to be a string and, when present, `role` and
`description` to be strings. Both optional fields reach a declared tool result schema, which
types every key it lists, so a hand-edited medium carrying a number there must fail at the read
rather than at the tool.

`role` and `description` are the only per-colleague facts the office stores. Everything else a
roster reports — status, effective permission, model route, held messages, last activity — is
read at the moment it is asked for and is therefore never stale in storage. The model route in
particular is read from the session's own `modelSelection` projection, which is the value the Web
UI shows (a pending selection wins over the one last used), not from `agent.options`: that field
holds only the route the colleague's agent process was constructed or resumed with, so a model
switched afterwards is invisible in it.

### `channels`

| Field | Meaning |
|---|---|
| `channelId` | The record key, and the prefix of every message key in the channel. `general`, `mailbox`, or `dm-<ids>`. |
| `kind` | `public`, `dm`, or `mailbox`. |
| `name` | The display name: the channel id for the two standing channels, `A ↔ B` for a direct channel. |
| `topic` | A sentence describing the channel. |
| `members` | The session ids of a direct channel, sorted. Empty for `general` and `mailbox`. |
| `createdAt`, `nextSeq` | When the channel was created, and the next sequence number to allocate. |

Two channels exist on activation: `general` (`kind: 'public'`) and `mailbox`
(`kind: 'mailbox'`, whose topic names the configured user). A direct channel is created on the
first message between two sessions. A direct channel's id is built from the two session ids, not
from their titles, so renaming a colleague cannot split one conversation across two channels.
The **mailbox** kind exists beside `public` and `dm` so that the one channel every colleague is
refused is identifiable by kind rather than by name: `visibleChannels` filters on it, which is
what keeps `office_read({ channel: '*' })` out of the user's mail.

### `messages`

| Field | Meaning |
|---|---|
| `messageId` | `<channelId>-<seq>`, stable and addressable in a frame and in a tool result. |
| `channelId`, `channelName` | Where the message lives, by key and by display name. |
| `kind` | `public`, `dm`, `mailbox`, or `summary`. |
| `seq` | The sequence number within the channel. Allocated by incrementing `channels.nextSeq`, never renumbered. |
| `senderName` | The sender's name at the time of writing: a session title, the short-id fallback, or `userName`. |
| `senderSessionId` | The sender's session, **absent** when the user posted from the panel. |
| `recipients` | The session ids the message was addressed to. Empty on a summary or a mailbox record. |
| `text` | The body. A summary's body is the text a model wrote for the range. |
| `createdAt` | Unix milliseconds. |
| `deliveries` | One outcome per recipient, keyed by the recipient's session id, or by `userName` for the user. Its values and statuses are in [delivery.md](delivery.md). |
| `covers` | On a `summary` only: `[lower, upper]`, the sequence range the summary replaced. |
| `replaced` | On a `summary` only: how many records the summary replaced. |
| `origin` | On a **mailbox copy** only: `{ channelId, messageId }`, where the same message was also published. |

The message key is `<channelId>#<seq>` with the sequence zero-padded to twelve digits, so key
order is sequence order inside a channel and the `pending` table can name a message by
`(channelId, seq)` alone. `validateMessage` requires `messageId` and `text` to be strings and a
`summary` to carry a two-integer `covers`; a summary that lost that pair would otherwise fail
later as an index into nothing.

### `pending`

One record per message held for one colleague, written when a delivery could not be handed over
because the colleague was not idle, and deleted only after that message's turn has been queued.
The key is `<sessionId>#<messageId>`, so a hold is idempotent per message and the office can
select a colleague's holds by key prefix.

| Field | Meaning |
|---|---|
| `sessionId` | The colleague that is waiting. |
| `channelId`, `seq` | Which message is held; the pair reconstructs its key in `messages`. |
| `at` | When the hold was taken, for diagnostics. |

The table is what makes a wake durable across a restart, and it is also where a dismissed
colleague's holds are dropped: nothing would ever deliver them. See
[delivery.md](delivery.md) for the batch a hold is released as.

## Identity

A colleague **is** a session. The office stores no name of its own: a colleague is addressed by
that session's title, so renaming the session from any other surface — the sidebar, a tool, the
session controller — renames the colleague, with nothing to sync. A session with no committed
title falls back to `session-<first eight characters of the id>`.

An office has the same split, with one difference: it is not a session, so it carries its own
pair.

| | key | name |
|---|---|---|
| a session | `sessionId`, opaque, never shown as an address | the session **title**, which is the colleague's name |
| an office | `officeId`, the storage unit name | `officeName`, which every request and every tool argument uses |

`officeId` is plumbing: it names the storage unit and nothing else, and it defaults to the row id
because a patch override cannot replace a row id. It must match `/^[a-z][a-z0-9_]*$/` and be at
most 64 characters. `officeName` is what a person reads and what the model passes as the `office`
argument, so it accepts any script and must match `/^[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*$/u`;
underscore is the only punctuation it takes, because the name travels in a tool argument and in a
query parameter.

### Canonicalization

Two rules turn spellings into identities:

- `canonicalName` trims and NFC-normalizes. Unicode lets the same name be spelled with composed
  or decomposed accents, and only the canonical spelling may reach storage, comparison, the
  panel, or a tool argument.
- `nameKey` is `canonicalName` lower-cased, and it is the comparison used for an office name and
  for a session title. Two names that differ only in case would be ambiguous everywhere, so they
  are one name; the stored spelling keeps whatever the user typed.

Comparison is a Unicode one and not a slug, because a colleague titled `张三` has no ASCII form:
an ASCII-only normalization would erase the title and make every mention of it fail.

### A rename never moves storage

`office_rename`, the panel's rename control, and `POST /dsh-office/offices/rename` all change
only the stored `name` in the global slot. The `officeId` stays the key behind the storage unit,
so every colleague, channel, and message survives, and every surface addresses the new name from
then on. The row's `officeName` is left as it was: it seeded the global once and is not consulted
again, which is why a delete resolves a mounted office through its storage key rather than through
the name its row was written with.

## Consequences

- **Session titles are not unique.** A name that matches two colleagues fails loud and names the
  candidate session ids; the office never picks one silently.
- **Direct-message channels are keyed by session ids**, not by titles, so renaming a colleague
  cannot split one conversation across two channels.
- **A session with no committed title falls back to `session-<short id>`**, so an unnamed sender
  is never attributed to an ambiguous `user`.
- **Office names are unique across a process.** A second office mounting the same name fails
  activation, because the name is how the panel and the tools reach exactly one office.
- **The storage unit records the office it belongs to.** Two rows sharing one `officeId` fail
  activation on the second rather than merging two rosters.
- **One host per process.** A second `office-host` row fails activation, because the host is the
  process's single owner of the tool set and the panel.
- **A matching boss preset wins over membership.** A session that both runs an office and was
  adopted by another acts as the **boss** of the offices it runs, so the tools it holds are the
  ones for those offices.
- **A session that belongs to two offices chooses with the `office` argument.** It holds the
  union of its roles' capabilities, and it must name an office whenever the two could differ; a
  call that omits the name fails when more than one office holds it, rather than picking one.

## Where the user fits

The user is **not** a session and has no id. Nothing can wake them, and no session log holds
their side of a conversation, so the office addresses them by name instead:

| | |
|---|---|
| name | `config.userName`, default `user`, any script. Canonicalized by the same rules as a colleague name. |
| matched | Case-insensitively against `config.userName` wherever a name is resolved: `office_dm({ to })`, `mentions`, and `office_read`'s `sender` and `mentions` filters. |
| without a session | A message the user posts from the panel is stored with `senderSessionId` absent, which is how the `sender` filter and the panel recognize it. |
| mail | The `mailbox` channel: what `office_dm` to the user writes, and where a public post that named the user is copied. |

Because the user has no session, a message addressed to them has no delivery to attempt and no
session to wake. It is stored and waits in the mailbox, which the panel reads; the delivery
outcome that reports it is described in [delivery.md](delivery.md).
