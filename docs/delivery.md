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

## A wake is steered by default, and merged when asked for

A colleague that is **idle** is handed the message now, as an ordinary `followup` turn — together
with anything it was already waiting for, because those wakes were held for exactly this moment.
That is the same delivery whichever timing was asked for: a timing only decides what happens to a
colleague that is **mid-turn**.

A busy colleague is never interrupted. What its sender chooses is whether it hears about the
message while it works or when it stops:

| `notify` | what a mid-turn colleague gets |
|---|---|
| `step-end` (default) | the message is spliced into the turn that is running and read at that turn's next step boundary |
| `turn-end` | the office holds the message and hands it over as one turn when that turn stops |

`step-end` is the default because a notification that waits for a turn to end answers something the
colleague has already moved past; `turn-end` is the merge, and a caller asks for it when the message
can wait. It is not a queue of single-message turns either: `turn-end` holds everything that
arrives and hands it over as **one** turn, in order, because a queue of single-message turns makes a
colleague answer each message minutes after it was written and answer the last one long after the
conversation moved on. A merged turn costs one, and the colleague answers once.

Both timings are on both carrying tools — `office_dm` and `office_post` — and the panel route,
which has no timing control of its own, sends none and gets the default. So a post to a busy
colleague is read at its next step boundary unless its sender asked for the turn end, and a
broadcast is read that way by every busy colleague at once.

Nothing refuses a wake. There is **no per-colleague budget and no cascade-depth bound**: every
notification that is made is delivered, immediately or held. The only brake is what a colleague
does with the turn it was given, which is why the answering rules are standing context rather than
part of a frame; see [The answering rule](#the-answering-rule).

## Step-end: steering a running turn

`step-end` is what a call that names no timing gets, on `office_dm` and on `office_post` alike. It
is the harness's own steering: the message enters the colleague's inbox as pending step input, and
the loop claims pending input at every step boundary, so the colleague reads it between the steps
it is running rather than after them. That is what a caller wants when the point is to change what
the colleague is doing — the wrong branch, a correction, a fact the next step needs — and it is the
office's default because reaching a colleague while it works is what a notification is for. The
timing table is under [A wake is steered by default](#a-wake-is-steered-by-default-and-merged-when-asked-for).

An idle colleague has no turn to steer, so it receives the message now either way, and the recorded
outcome says which happened: `steered` for the splice, `delivered` for a turn.

### What the receiving session's Chat shows

A delivered frame is visible in the receiving session's Chat, and which row it becomes is decided by
its `source.kind` ([The delivered turn](#the-delivered-turn)):

| delivery | `source.kind` | what the receiving Chat draws |
|---|---|---|
| a `step-end` splice | `user` | a pending bubble the moment the office steers it, and an in-turn message row once a step boundary claims it |
| a turn — an idle colleague, a merged `turn-end` burst, a recovered splice, an onboarding | `office-message` | the visible trigger row that opens that turn, and for `turn-end` a row in the queue strip while the merge waits |

The split exists because the Web Chat draws a message whose source is **not** `user` as injected
context, and a `context` node is not one of its visible rows; the pending tail filters the same way,
taking only `source.kind === 'user'`. A splice is the one delivery that would therefore leave
nothing in the conversation it belongs to — it is read by a colleague that is already working, so
nothing else ever opens a turn for it — and it is also the office's default. So the splice claims
`user`, and only the splice does: a delivery that opens a turn is already drawn, and disguising it
too would make the office's own messages look like the human's in the sessions the human watches,
the boss's included.

**That claim is a deliberate trade, not a free one.** `kind === 'user'` is the harness's marker for
"a human at this keyboard", and several harness readers act on it, so office traffic now reaches
them:

- `tool-skill` scans the text blocks of every `user` message for `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/`
  and loads each named user-invocable skill into that step. Its own invariant is that *external
  text cannot forge the gesture*, and a frame carries a colleague's text, so a body containing a
  token like ` /deploy ` loads that skill in the receiving session.
- `tool-goal`'s `requireDirectHuman` accepts a `user` message in the open turn as proof of a direct
  human turn, so a colleague's private message mid-turn satisfies an operation meant to require the
  human.
- `tool-jobs` clears its `maxConsecutiveWakes` budget when a `user` message is claimed, so office
  traffic refills the wake damper; `repeat-tool-reminder` clears its repeat chain on one; the
  session list records `lastPromptAt` from one.

The office accepts this because seeing what a working colleague was told is worth more to an
operator than the isolation the honest kind buys. Two notes for anyone revisiting it. **Wrapping the
body is not by itself enough**: the gesture regex accepts a slash token after any whitespace, so
prefixing a line still matches — neutralizing it means escaping the slash (`\/`) or otherwise
breaking that boundary. And the alternative fix is not in this package's tree: a Chat that drew an
addressed peer message as an in-turn row would need a change to the harness's own classification.

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

Every tool that writes a message takes a **required** `wake`, and nothing wakes anybody by
default. It names colleagues, or one level, and the two spellings are never mixed:

| call | audience |
|---|---|
| `office_post` with `wake: ["@alice", "@bob"]` | exactly the named colleagues, whether or not the channel holds them |
| `office_post` with `wake: ["#leader"]` to `#general` | every colleague at the leader rung or above, except the sender |
| `office_post` with `wake: ["#member"]` to a group channel | that channel's members among the member rung and above, except the sender |
| `office_post` with `wake: []` | nobody; the message is written to the channel |
| `office_post` naming the user (`"@user"`) | the other names it was given, and a copy in the mailbox |
| `office_dm` with `wake: ["@alice"]` | that colleague alone, at the timing its `notify` asks for |
| `office_dm` with `wake: ["@user"]` | the mailbox; no session is woken, and `notify` means nothing to a user with no session |
| the office's own idle notice | whoever the row's `idleNotice.wake` names: `["#leader"]` unless it says otherwise |

A level is the **lowest rung it may reach**: it wakes its own privilege and every rung above it, so
`#consultant` reaches the whole office, `#member` reaches the members and the leaders, and
`#leader` reaches the leaders alone. The rung is the session permission a role runs under, which
is why the read-only `consultant` is the bottom one; the ladder and its table are in
[README.md](../README.md#who-a-message-wakes).

Two rules narrow a level and never a name. A level is **scoped to the channel** it is posted to —
the whole roster in `#general`, that channel's members in a group one — because its members decide
who a post there wakes; naming a colleague addresses that colleague, so the channel does not
intervene. And a session never receives its own message, whichever spelling was used.

`office_dm` names exactly one colleague and refuses a level: a private message is one
conversation, and a rung is reached with `office_post`. Every `office_post` row carries the same
timing choice as `office_dm`: a post and a dm differ in who they reach, never in when a recipient
that is mid-turn reads them.

The office is the one sender that is not a session, and it has one message to send: when the whole
roster has stopped and something was written since the office last asked, it posts `idleNotice.text`
to `idleNotice.channel`, addressed to `idleNotice.wake` — the leaders alone unless the row says
otherwise — and it asks nothing at all when that audience would be empty. That is the only wake in
the office no session asked for; [design.md](design.md) says why it exists and what stops it from
repeating.

The panel carries no audience of its own: it sends the body, and the office derives the wake from
the **stored body** by the same token rule the panel colors — `@` names and `#` levels. So no
client can wake a colleague the message does not name, and the composer has no switch to keep in
step with the server.

Waking is not the same as reading. A message nobody is notified for still sits in its channel,
where `office_read` finds it. That is the point of the empty wake: a notice that is not worth a
turn.

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

The wake is a standard `user/message`. Its `source.kind` is `office-message`, except on a `step-end`
splice, which claims `user`:

```js
{
  id: `office-${newest.messageId}`,
  role: 'user',
  content: [{ type: 'text', text: '<the frame>' }],
  source: {
    // `user` on a step-end splice, `office-message` on every other delivery; the reason is under
    // [What the receiving session's Chat shows](#what-the-receiving-sessions-chat-shows).
    kind: steered ? 'user' : 'office-message',
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
```

The frame names the destination, the sender, and the message identity, so the receiving colleague
can attribute and answer the message without reading the office domain. It carries **no** standing
rule: [The answering rule](#the-answering-rule) says where that rule lives instead, and why.

### The staleness line

`newestSeq` is the newest sequence of the delivered message's channel **at the moment the turn was
queued**. When it is greater than the message's own sequence, the frame says so:

```text
(#general had already reached general-27 when this turn was queued; newer messages are not in it.)
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

Any caller can address the whole office with one level, and a colleague that answers every wake in
public multiplies that reach: one post wakes every colleague, each woken colleague posts an
answer, and the answers wake the office again. Three rules stop that:

- **Silence is the normal answer** to a delivered message.
- **A message is answered where it stands**: in its channel when it was public, with `office_dm`
  when it was private. A direct message never becomes a public one, because that is not the
  recipient's call to make.
- **An acknowledgement is never posted** — not to agree with a message, and not to announce that
  work is under way, because a public post wakes every colleague and each of them spends a turn.

They are stated once, in `office_post`'s description. Every predefined role holds `office_post` —
`member`, `leader`, and `consultant` alike, and the boss holds it too — so the tool a colleague
answers with is the tool that says how.

**That placement replaced a per-frame tail, and the move is the point.** The rules used to be
appended to every frame, chosen from the receiving role's capabilities so that no frame named a
tool its recipient lacked. A frame is written into the receiving colleague's session, though, so
the same paragraph was copied into its history once per delivered message — around 400 characters
for a public message, silence rule and acknowledgement rule together — and re-sent with every later
request for the life of that history. A tool description is assembled into each request rather than
accumulated in the session, so the rules now cost one statement instead of one per wake.

Two things went with the tail. A merged burst is one answer rather than one post per message, which
its header states by counting the messages it carries. And the capability-selected branch that told
a role holding no channel-write tool that `Nothing you write here reaches the office…` went too: no
predefined role holds neither `office_post` nor `office_dm`, so the branch could not be reached,
and a colleague's own tool set is what tells it what it holds.

A frame therefore carries the message, its destination, its sender, and its identity, and nothing
else. Delivery is still a private turn in the target's own session, so nothing anyone else reads
happens by answering it — that is a property of the delivery, not a sentence every frame repeats.

Two consequences follow, and both are deliberate:

- **A message nobody is notified for reaches nobody's context.** A post with `wake: []` sits
  in its channel until someone reads it with `office_read`.
- **A held message waits for the turn to end.** Its sender asked for `turn-end`, is told `queued`
  rather than `delivered`, and the message is in the next turn that colleague takes. A message
  under the default timing is reported as `steered` instead, and a colleague may also take what is
  held for it with `office_read_notifications`, which records it `delivered`.

## Durable holds

A hold lives in the `pending` table, keyed by the waiting colleague and the message. The hold is
durable because a wake is a promise the office keeps:

- Activating an office delivers whatever a previous process was holding — **one turn per
  colleague**, whatever that colleague was waiting for.
- A step-end hold is released when the harness claims its message into a step, and recovered as the
  office's own turn when nothing did; see
  [A step-end wake is held too](#a-step-end-wake-is-held-too).
- A step-end hold is also released when its colleague reads it for itself, which is
  [Reading what is held, in the middle of a turn](#reading-what-is-held-in-the-middle-of-a-turn).
- A message compacted away while it was held is dropped from the batch on purpose: its summary is
  what replaced it, and the summary is what a reader meets.
- A **dismissed** colleague's holds are deleted with its roster entry. Nothing would deliver them,
  and the office would otherwise hold another office's messages for ever.
- Delivery of a batch happens only when the colleague's live agent is idle. A colleague that is
  busy again by the time the office gets to it keeps its holds; the next idle transition delivers
  them.
- The hold records are deleted only **after** the turn has been queued, so a failure while
  releasing them leaves them held and the next idle transition retries.

## Reading what is held, in the middle of a turn

`office_read_notifications` returns what the office is holding for the **calling** colleague and
takes it, so a colleague that is working can read its mail at a step of its own choosing instead of
waiting for the turn to end. It is the only release that does not wait for the colleague to stop,
and the only one where the colleague is the reader rather than the recipient of a turn.

```text
office_read_notifications  {}

[office office] 2 notifications were held for you, read here on request:

[office DM from alice | dm-….4]
can you look at this before I ship?

[office #general from bob | general-9] (held until the end of your turn)
release is cut
```

| Field | Meaning |
|---|---|
| `messageId`, `channelId`, `channelName`, `kind`, `senderName`, `seq`, `createdAt` | The message, exactly as a frame names it. |
| `notify` | The timing it was held under, which is the timing its sender asked for. `turn-end` is the one the frame calls out, because it is the one a reader would otherwise not expect. |
| `text` | The body. |

- **Every role holds it, and it has no `office`-free form of another colleague.** What is held was
  addressed to that colleague alone, so there is no argument naming one: a boss able to read a
  colleague's holds would be able to answer for it.
- **The tool result is the delivery.** Each taken message gets the same `delivered` outcome a
  handed-over turn records, with a detail naming the read. Leaving it `queued` would report a
  message the colleague has read as unread for ever. No `batch` is recorded, because no turn
  carried it.
- **It reads only what the harness has not claimed.** A hold still present while the colleague's
  session log already carries the message is the race between a step claiming a step-end wake and
  the office deleting its hold; it is dropped rather than handed over a second time, and the log is
  what settles it — the same judgement
  [a recovered step-end wake](#a-step-end-wake-is-held-too) makes.
- **It takes the delivery, never the message.** The message stays in its channel, where
  `office_read` finds it. Reading twice takes nothing the second time.
- **It is not a substitute for `office_read`.** A wake carries only what was addressed to the
  colleague, so a notification read this way is exactly that and no more; the channel record the
  colleague was not notified about is still read with `office_read`.

## Delivery statuses

Each recipient's outcome is recorded on the message in `deliveries`, keyed by that recipient's
session id — or by the user's name for the mailbox — and reported in the tool result:

| Status | Meaning |
|---|---|
| `delivered` | The turn was handed to the colleague, now or as part of a merged batch. A batch records how many messages it carried. A recovered step-end wake, and a notification the colleague read for itself, record it with a detail naming why. |
| `queued` | The colleague was mid-turn and the sender asked for `turn-end`, so the message is held in `pending` and goes into its next turn, merged with whatever else is held for it. |
| `steered` | The colleague was mid-turn and the message was spliced into the turn it was running, to be read at that turn's next step boundary. This is what the default timing reports. |
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
