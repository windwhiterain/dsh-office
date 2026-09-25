# Delivery

What happens when something is posted: how the message is stored, who is woken, what the woken
session receives, and how a wake that could not be handed over survives. The reasons behind the
delivery contract are in [design.md](design.md); the tables and identities it uses are in
[data-model.md](data-model.md).

## Post, then deliver

`office_post` and `office_dm` append the message to the office domain **first**, then attempt
delivery to every colleague the call notifies. Reading the message back never depends on a wake
having happened: a wake that failed leaves the message in its channel, where `office_read` still
finds it.

The order inside one post is fixed:

1. The body is bounded by the office's `maxMessageChars`.
2. The channel is resolved (`#general`, a group channel the caller is a member of, or the direct
   channel for `kind: 'dm'`), and the audience with it — the whole roster except the sender for
   the standing public channel, the group channel's **members** for one the office created, or
   the named recipients.
3. The sequence is allocated, and the message record is written with an empty `deliveries`.
4. If the message also addresses the user, it is copied into the mailbox **after** the message
   itself is stored, so the office's own history never depends on the mailbox being writable. A
   copy that fails reports `failed` for the user instead of losing the message.
5. Each recipient is delivered to in turn, and each outcome is recorded on the message.

`wakesEnabled: false` stops after step 4: every recipient reports `wakes-disabled` and no session
is touched.

## A wake is merged, not queued

A colleague that is **idle** is handed the message now, as an ordinary `followup` turn — together
with anything it was already waiting for, because those wakes were held for exactly this moment.
One that is **mid-turn** is not interrupted: nothing is spliced into the turn it is running, and
it is not queued a row of single-message turns either. Its wake is held, and when the colleague
goes idle it receives **one** turn carrying everything that arrived meanwhile, in order.

That is the difference between answering a conversation and answering a queue. A queue of
single-message turns makes a colleague answer each message minutes after it was written and
answer the last one long after the conversation moved on; a merged turn costs one, and the
colleague answers once.

`office_dm` may ask for the running turn instead, with `notify: 'step-end'`; the merge above is
what every other wake, and every caller that names no timing, gets. That choice is described under
[Step-end: steering a running turn](#step-end-steering-a-running-turn).

Nothing refuses a wake. There is **no per-colleague budget and no cascade-depth bound**: every
notification that is made is delivered, immediately or held. The only brake is what a colleague
does with the turn it was given, which is why every frame carries the answering rule described
under [The answering rule](#the-answering-rule).

## Step-end: steering a running turn

`office_dm` carries one timing argument, `notify`, and it decides only what happens to a colleague
that is **mid-turn**:

| `notify` | what a mid-turn colleague gets |
|---|---|
| `turn-end` (default) | the office holds the message and hands it over as one turn when that turn stops |
| `step-end` | the message is spliced into the turn that is running and read at that turn's next step boundary |

`step-end` is the harness's own steering: the message enters the colleague's inbox as pending step
input, and the loop claims pending input at every step boundary, so the colleague reads it between
the steps it is running rather than after them. That is what a caller wants when the point is to
change what the colleague is doing — the wrong branch, a correction, a fact the next step needs —
where the default answers it afterwards. It is deliberately **not** an option on `office_post`:
one public post that reaches every busy colleague would otherwise splice into every run in the
office.

An idle colleague has no turn to steer, so it receives the message now either way, and the recorded
outcome says which happened: `steered` for the splice, `delivered` for a turn.

### A step-end wake is held too

A step-end wake is written to the `pending` table before it is steered, and that hold is what makes
it durable. The message reaches the colleague's inbox as pending step input, which is itself a
durable session projection — but an inbox is only claimed by a turn, and nothing resumes a colleague
whose host died mid-turn, so the hold is what the restarted office acts on.

The hold is deleted when the harness **claims** the message into a step (`agent/inbox/claimed`),
not when the office queues a turn: what the table holds for one colleague is exactly what the
harness has not taken. A hold that outlives that claim is therefore recoverable, and `flushWakes`
recovers it at the next idle transition and at activation:

- A message still pending in the colleague's inbox is **taken back** (`Agent.inbox.remove`) and
  handed over as the office's own turn, so the step boundary that is coming cannot deliver it a
  second time.
- A message the colleague's **session log** already carries drops the hold instead, because a
  claimed message is appended to its session as a `user/message` before the request that reads it.
  That read is the durable answer to "did this colleague receive this?", which is what the answer
  has to survive a restart to be worth anything.
- A message in neither place — a turn cancelled before its next step, a session whose pending input
  was discarded — is the case the hold exists for, and it is handed over as the office's own turn.

A recovered wake records `delivered` with a detail naming the recovery: the status is what the
colleague actually got, and the detail is why it was not the splice its sender asked for.

## Who is woken

`office_post` wakes the whole roster unless the caller narrows it:

| call | audience |
|---|---|
| `office_post` to `#general` with no `mentions` | every colleague except the sender |
| `office_post` to a group channel with no `mentions` | exactly that channel's members except the sender |
| `office_post` with `mentions` | exactly the named colleagues |
| `office_post` with `mention_all: false` | nobody; the message is written to the channel |
| `office_post` naming the user | the named colleagues, and a copy in the mailbox |
| `office_dm` to a colleague | that colleague alone, at the timing its `notify` asks for |
| `office_dm` to the user | the mailbox; no session is woken, and `notify` means nothing to a user with no session |

`mention_all` defaults to true when `mentions` is absent and to false when it is present, so
naming colleagues narrows the audience rather than adding to it, and `mentions: []` posts a notice
nobody is woken for. A session never receives its own message.

The panel sends the same shape and makes the same choice: its **Wake everyone** box starts
checked, and unchecking it narrows the wake to the names the stored body carries with `@`. The
audience is derived from the **stored body** by the same mention rule the panel colors, so no
client can wake a colleague the message does not name.

Waking is not the same as reading. A message nobody is notified for still sits in its channel,
where `office_read` finds it. That is the point of the option: a notice that is not worth a turn.

## Cold resume

An inactive colleague is reached with `ctx.agents.resume({ resumeSessionId, agentOptions })`, the
only harness operation that reaches an unloaded ordinary session. `AgentRegistry.resume` takes the
options object alone; the `(ownerCtx, options)` form is the lower-level `agentLoop` factory
contract.

`agentOptions` is **mandatory**, not optional: the `provider` and `model` prompt variables read
`agent.options`, so a resume without a route fails prompt assembly with
`prompt variable "{{model}}" has no value for this assembly`. The route is resolved in this order:

1. The session's own last logged `request/header` event, which is the route that session last ran
   on. The newest such event wins, and a header missing either half is skipped.
2. The deployment's default-model service (`ctx.get('agentDefaultModel').currentSelection()`).

With neither source, the delivery fails and says so, rather than resuming into an assembly that
cannot run.

The resumed agent handle is deliberately not retained: the agent stays live in the registry for
the plugin's lifetime, because disposing the handle would tear the session down underneath a
browser that has it open.

## The delivered turn

The wake is a standard `user/message` whose `source.kind` is `office-message`:

```js
{
  id: `office-${newest.messageId}`,
  role: 'user',
  content: [{ type: 'text', text: '<the frame>' }],
  source: {
    kind: 'office-message',
    channelId, messageId, senderName, senderSessionId,
    batch: <count>,          // only when the turn carries more than one message
  },
}
```

The batch takes the **newest** message's identity, `channelId`, `messageId`, and `senderName`, so
one turn is addressable exactly like a single delivery; every message keeps its own header inside
the body.

Every field reaches the session log, which is JSON, and `Session.append` rejects a value JSON
cannot round-trip. A field with no value is therefore **absent rather than present and
`undefined`**: a message the user posted from the panel has no sender session, so
`source.senderSessionId` is absent on it. Leaving it in as `undefined` fails the whole delivery
with "carries non-JSON-serializable data".

### The frame

One message:

```text
[office #general from alice | general-9]
@bob can you take this?

(Your reply stays in this session and reaches nobody. Most messages need no answer, and silence is a normal one. Post important information to #general so everyone can learn from it; send short exchanges privately with office_dm. Never post to acknowledge a message, to agree with it, or to say that you are working on it: a public post wakes every colleague, and each of them spends a turn on it.)
```

A turn that carries a merged burst — its header says how many, and each message keeps its own:

```text
[office office | 3 messages arrived while you were working]

[office #general from carol | general-6]
the build is green again

[office #general from dave | general-7]
thanks — merging

[office DM from erin | dm-….4]
can you look at this before I ship?

(These arrived while your previous turn was running. They are one turn because they arrived together, not because each one asks for an answer. Your reply stays in this session and reaches nobody. Most messages need no answer, and silence is a normal one. …)
```

The frame names the destination, the sender, and the message identity, so the receiving colleague
can attribute and answer the message without reading the office domain. It also states where a
reply does and does not surface: delivery is a private turn in the target's own session, so
nothing anyone else reads happens by answering it.

### The staleness line

`newestSeq` is the newest sequence of the delivered message's channel **at the moment the turn was
queued**. When it is greater than the message's own sequence, the frame says so:

```text
(#general had already reached general-27 when this turn was queued. Newer messages are not part of it; office_read reads them.)
```

A merged turn carries the line once, after its frames, and reads it from the last message's
channel. Without it, a message from ten minutes ago is indistinguishable from a live one, and
answering it reads as engaging with something already settled. It states what the office knew when
the turn was created, not what it knows when the message is finally answered, and it is the only
staleness signal a colleague gets.

A step-end wake carries **no** staleness line: it is read at the end of the step that is running,
so the office does not read the channel's newest sequence for it, and the message is in the turn
that is being taken rather than in a turn queued behind it.

The frame carries **only** the messages it names. The office does not replay the channel into a
wake and a colleague has no read position: `office_read` is how anyone sees what they were not
notified about, which keeps a turn's cost proportional to the messages in it.

## The answering rule

The office's tools default to waking the whole roster, and a colleague that answers every wake in
public multiplies that default: one post wakes every colleague, each woken colleague posts an
answer, and the answers wake the office again. So every frame ends with the same rule, stated
where the choice is made — the default answer to a delivered message is silence — and a public
message adds where an answer belongs when there is one.

The rule is chosen from the capabilities the receiving colleague's role holds, because a rule
cannot name a tool its recipient does not hold. Every predefined role holds `office_post` and
`office_dm`, so for the roles that exist today the message kind decides:

| the message was | what the frame says |
|---|---|
| a direct message | `To answer the sender, use office_dm.` |
| a public message | the public answering rule quoted above: post important information to `#general` so everyone can learn from it, send short exchanges privately with `office_dm`, and never post an acknowledgement |

(`consultant` speaks like a `member`: `read-only` is only its session's preset, which the
office's own storage does not answer to. A role that held no channel-write capability would
instead hear `Nothing you write here reaches the office…`, and no predefined role is that role
today.)

A direct message never suggests a public post, because turning a private message into a public one
is not the recipient's call to make. A merged burst is answered with the public rule, so a batch
that contains a direct message is framed as the public case.

Two consequences follow, and both are deliberate:

- **A message nobody is notified for reaches nobody's context.** A `mention_all: false` post sits
  in its channel until someone reads it with `office_read`.
- **A held message waits for the turn to end.** Its sender is told `queued`, not `delivered`, and
  the message is in the next turn that colleague takes. A `step-end` wake is the one exception its
  sender can ask for, and it is reported as `steered` rather than `queued`.

## Durable holds

A hold lives in the `pending` table, keyed by the waiting colleague and the message. The hold is
durable because a wake is a promise the office keeps:

- Activating an office delivers whatever a previous process was holding — **one turn per
  colleague**, whatever that colleague was waiting for.
- A step-end hold is released when the harness claims its message into a step, and recovered as the
  office's own turn when nothing did; see
  [A step-end wake is held too](#a-step-end-wake-is-held-too).
- A message compacted away while it was held is dropped from the batch on purpose: its summary is
  what replaced it, and the summary is what a reader meets.
- A **dismissed** colleague's holds are deleted with its roster entry. Nothing would deliver them,
  and the office would otherwise hold another office's messages for ever.
- Delivery of a batch happens only when the colleague's live agent is idle. A colleague that is
  busy again by the time the office gets to it keeps its holds; the next idle transition delivers
  them.
- The hold records are deleted only **after** the turn has been queued, so a failure while
  releasing them leaves them held and the next idle transition retries.

## Delivery statuses

Each recipient's outcome is recorded on the message in `deliveries`, keyed by that recipient's
session id — or by the user's name for the mailbox — and reported in the tool result:

| Status | Meaning |
|---|---|
| `delivered` | The turn was handed to the colleague, now or as part of a merged batch. A batch records how many messages it carried. A recovered step-end wake records it with a detail naming the recovery. |
| `queued` | The colleague was mid-turn at that moment, so the message is held in `pending` and goes into its next turn, merged with whatever else is held for it. |
| `steered` | The colleague was mid-turn and the message was spliced into the turn it was running, to be read at that turn's next step boundary. |
| `wakes-disabled` | The office runs with `wakesEnabled: false`; the message is stored and no session is touched. |
| `mailbox` | The message was addressed to the **user**, who has no session to wake, so it waits in the user mailbox. |
| `failed` | The delivery itself threw; the message stays in its channel and `office_read` still finds it. |

`mailbox` is the status that makes the user addressable: it reports that no session was woken
rather than reporting a delivery that never happened. A message that is only mail — an `office_dm`
to the user — reports that one outcome and nothing else, because the user is its only recipient;
a public post that names the user reports it alongside the colleagues' outcomes, and the rendered
text names the user in the same delivery list. When a post has no deliveries at all — nobody was
named and nobody was woken — the rendered result says so: `No colleague was woken; the message
waits in the office for office_read.`

## The reading contract

`office_read` is a **query** over stored history and the only way to see what a colleague was not
woken for: a wake carries only what was addressed to the colleague, and this tool answers for any
range or filter the caller names.

| Argument | Meaning |
|---|---|
| `channel` | **Required.** `#general`, a colleague's session title for the direct channel with that colleague, or `*` for every channel the caller can read. |
| `from`, `to` | Inclusive sequence range inside each channel, as the `seq` of any earlier result reports it. |
| `limit` | At most this many messages, newest kept. Default `readLimit`, maximum `readLimitMax`. |
| `sender` | A colleague's session title, or `userName`. A colleague is matched by **session id**, so renaming a session cannot split its own history; the user's messages are the ones stored without a sender session. |
| `contains` | Substring of the body, ignoring case. |
| `mentions` | `me`, a colleague's session title, or `userName`. |
| `since`, `until` | Inclusive bounds on the message's `createdAt`, in Unix milliseconds. |
| `brief` | Omit the bodies, for scanning a large range before reading it. |

The filters compose and every returned message carries its `channelId` and `seq`, so a caller that
scanned with `brief` can come back for the bodies. `*` (or `all`) reads every channel
`visibleChannels` admits: `#general` and the caller's own direct channels, **never** the mailbox.
The mailbox is also refused by name, and a channel that is not `#general` and does not name a
colleague is refused rather than being read as something else.

**A partial result says that it is partial.** The result carries `total`, how many messages
matched before `limit` kept the newest, and `truncated` when some were left out; the rendered text
adds `That is the newest N of M matching messages; older ones are not in this result`. A window
that does not announce itself is worse than an error, because it reads as data: a caller that
concludes "the office never discussed this" is wrong and has no signal that it is wrong. A result
with no matches distinguishes the two cases for the same reason — `no messages yet` when no filter
was set, and `no matching messages` when one was.

An omitted required argument fails as the omission it is, not as an unknown channel named
`"undefined"`: `office_read: channel is required`. The panel's own history route caps one page at
the host's `readLimitMax` when it is asked for no explicit limit.

## Compaction

`#general` grows without bound, and history is read on demand rather than replayed, so
`office_compact` replaces a sequence range with a summary a model wrote for it.

```text
office_compact({ office: 'office', from: 1, to: 30, summary: 'The team agreed to ship Friday; carol owns the release.' })
```

- **The summary takes the lowest sequence of the range**, and the covered messages are deleted. A
  reader starting from the beginning meets the summary exactly where those messages stood, so the
  channel still reads as one narrative.
- **A summary that is itself compacted hands over its coverage.** The range a call names is
  widened by the `covers` of every summary inside it, so `covers` always describes what is gone,
  never what one call happened to name.
- **No sequence is renumbered.** A message delivered before the compaction keeps its place in the
  transcript of whoever received it, and the sequence is not reused.
- **The model writes the summary**, because only a model can reduce a conversation to what
  mattered. The tool stores the text it is given; it never invents one, and the text is bounded by
  `maxMessageChars` like any other body.
- **Compaction is destructive and there is no undo**, so a range nobody will need in full is the
  range to compact.

`compact` is a **capability**, not a boss-only tool: a boss holds it because it runs the office,
and a `leader` holds it because tending the office's shared record is what its role is for. Every
other colleague's scope carries no `office_compact` at all; see [design.md](design.md) for the
capability model and [data-model.md](data-model.md) for the `summary` record it writes.

The result reports the summary's id, the coverage `[lower, upper]`, and how many records were
replaced — a count of records, not of sequence numbers, so a compacted range that already had gaps
reports only what it actually removed. A caller reads the range first and passes the sequences it
covered; a range that contains no message is refused rather than written as an empty summary.
