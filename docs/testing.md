# Testing

Three tools live outside the shipped package: `probe/smoke.mjs` covers the plugin logic without a
Harness, `probe/panel-render.mjs` covers the Web panel's render path and its contract with the
state route, and `probe/session-tool-scan.mjs` reads one stored session back for what it held and
what it called. None is part of what a deployment installs.

## The offline probe

```powershell
node probe/smoke.mjs
```

It drives `apply()` against in-memory fakes: a storage domain over plain maps, an agent registry
that publishes real Cordis root events, a permission-preset service, a session controller, a route
table that runs the handlers the panel calls, and — only for the checks that ask for it — the
long-term quota retry service another row would provide. It checks the office logic, the per-agent
tool scoping, every declared tool output against its own schema, and the routes. It needs no
running Harness and no dependencies beyond the package's own, so it runs on every edit.

What it covers, by area:

- **Activation and configuration** — row kinds, field validation, unknown fields, the office name
  and storage key rules, the profile-patch edits (create, delete, rename, disable) with the
  operator's comments preserved.
- **Roles** — the tool set each predefined role holds, the union across two memberships and the
  per-call capability check that narrows it, a role change withdrawing tools from the live
  session, the `rolePermissions` map and its fail-closed refusal, the migration of a stored
  role that is no longer predefined, and `askUserRoles` withdrawing the harness's question tool —
  per role, across a role change, across two offices that vote as a union, on a session the office
  never armed, and in a deployment that mounts no such tool at all.
- **The wake** — the required `wake` argument and its three spellings: each level reaching its own
  rung and every rung above it, a channel addressing exactly the members of the channel it names,
  a named wake staying exactly the colleagues it names, the sender never woken by its own post, an
  empty list waking nobody, and the refusals: an omitted or non-array `wake`, a name without its
  `@`, a level nobody predefined, a channel the office does not hold or one that is not
  addressable, a level or a channel combined with anything else, a wake level spelled with the
  trigger channels now use, and a name that matches no session title. `office_dm` naming exactly one
  colleague and refusing a level and a channel, and the panel route deriving the same tokens from
  the body it stores are covered beside it. The wake is also covered where an **agent** meets it: a
  delivered frame states the token, or the colleagues a named wake resolved to, and an `office_read`
  page states the same clause per message — including `nobody` for a message that woke nobody and a
  pre-`$` stored `audience` read back in the spelling that addresses it today.
- **Delivery** — the default timing steering a post and a dm into a running turn and the refusal of
  an unknown timing, the `source.kind` each delivery claims (`user` on the splice the Web Chat draws
  as an in-turn message, `office-message` on the turn it draws as a trigger), `turn-end` merging a
  burst into one turn, a durable hold surviving a simulated restart, cold resume on the route the
  session last logged, delivery statuses, and the frames, which name the sender as a colleague or as
  the user, state the wake the message was written with, and carry the one delivery line. A **leader's
  frame** also carries the office's own lines:
  the load tally counted at each hand-over rather than stored or cached, an unloaded colleague counted
  in the roster and never among the working, the leader reading a splice into its own turn counted in
  it, a merged turn stating it once, and the same lines on `office_read_notifications` for a leader
  and not for a member. The **roster line** is covered by what moves the revision and what does not:
  a colleague adopted, a description configured, a colleague renamed, a dismissal, a configure that
  changes nothing, one line per change rather than one per frame, a second leader told the same change
  on its own frame, a member told nothing and holding no baseline, and the read path reporting it too.
  A `step-end` wake is covered too: the
  steer into a running turn, the hold released when the harness claims the message, the recovery of a
  wake nothing claimed (still pending, discarded, or carried across a restart), and the hold deleted
  with a deleted channel. Every cold resume the suite performs is also checked for its **owning context**:
  the fakes accept a resume only on the process context (`ctx.root`) and refuse one on an office row,
  because a row-owned colleague is what a plugin reload would dispose mid-turn.
- **`office_read_notifications`** — taking a steered and a held notification in one read, the inbox
  copy going back with the hold so no step delivers it twice, the delivery recorded as `delivered`,
  the message left in its channel and in `office_read`, reading twice taking nothing, a colleague
  reading only its own holds, and the stale-hold race: a hold whose message a step already claimed
  is dropped rather than handed over again. The fake answers `readSession` per session so a check
  can put one wake in one session's log.
- **The user mailbox** — `@user` in a public post filing a copy with its `origin`, `office_dm` to
  the user waking nobody, and every spelling of the mailbox being refused to `office_read` and
  `office_compact` while `channel: "*"` never reaches it.
- **Group channels** — the `channels` capability per role, creating (and the reserved ids, the
  duplicates, and the unknown members it refuses), the membership-gated listings and reads, the
  audience a post to a group channel wakes, membership edits, the panel routes that mirror them,
  and a deletion taking its messages and its holds with it.
- **The idle notice** — the office asking its leaders once the last colleague stops, the audience it
  wakes (the row's `wake`: the leaders alone by default, and the rung it configures otherwise), the
  brake: a second idle transition with nothing new written sends nothing, and any new message
  re-arms it; a colleague that is still working, an office whose `wake` reaches nobody, a session
  outside the roster going idle, `wakesEnabled: false`, a configured channel the office does not
  hold being reported rather than swallowed, the record of the last notice surviving a restart, and
  the row validation that refuses a notice it could never send.
- **The quota wait** — the one status the office derives rather than reads: a colleague held in a
  wait reporting `quota-retry` while one no entry covers reports `running`, an entry with no wait
  armed reported as `running` too, an unloaded colleague reported `inactive` whatever a ledger
  holds, the private message carrying the status read *before* it delivered (and `office_post`
  declaring no such field), a deployment that composes no quota row reading the roster it always
  did, the panel token moving when a colleague enters or leaves the wait, and the interrupt result
  naming the wait it ended. The fake answers only for the harnesses that ask for it, which is what
  makes the absent-row case a case at all.
- **Do not disturb** — a colleague setting its own state through `office_do_not_disturb`, and what
  that state silences: a post that names it, a private message, and the mail of a colleague whose
  session is not loaded are each held rather than delivered, each reported to its own sender as
  `do-not-disturb` with the reason quoted, and none of them opens a turn in the colleague that
  asked to be left alone. The release reports what it is about to hand over and hands it over as one
  merged turn at the next idle transition, never inside the releasing call;
  `office_read_notifications` still returns and takes the caller's own holds while the state is set;
  a session that is not loaded is never resumed to be told that it is away; and one call writes
  every office that holds the colleague, whose colleagues each read the state the other office
  recorded. The roster reports the state and the reason to every reader, the panel's snapshot
  carries them, and the refusals are covered: a call that names no state, a state that is not a
  boolean, a note sent beside a release, and a note past the bound. A boss holds no such tool,
  because it is on no roster.
- **The panel routes** — the state snapshot (roster, roles, mailbox, totals, the channel the feed
  asked for), the history page a folded row asks for, hire, configure, dismiss, and the connection
  policy each one applies. The snapshot's own token is covered by what it is for: a poll naming the
  token it was answered with is told `unchanged` and carries no snapshot at all, a message in the
  channel the panel reads moves it, another channel's traffic does not, and a colleague's live
  status does. The roster's names are covered by the read they must not make: a check counts the
  log folds the fake was asked for and asserts the count is zero while a title projection is
  readable, for a first listing and for a rename.
- **The preset plane of a colleague** — that a cold resume hands the harness a `setup` which mounts
  the preset the session's log names (projection first, creation header as the fallback), that a
  resume on a deployment with no preset registry still works and mounts nothing, that a live
  colleague found without a plane is rebound rather than handed a turn it cannot work with, that a
  colleague whose preset nobody declares fails the wake instead of coming up stripped, and that the
  roster reports the preset and tool count a live colleague actually holds. A colleague rebuilt
  around a restored plane is checked to be armed with the same withdrawal a freshly composed one
  gets, and the fake registry refuses an unknown id and a broken declaration exactly as the real
  one does.

Keep it out of `index.js`: the shipped plugin carries no test code, and `package.json`'s `files`
list ships neither `probe/` nor `docs/`. `experience/` does ship: a hired leader's onboarding turn
names `experience/README.md` by its absolute path, and a path a prompt hands a model must exist.

## The panel render check

```powershell
$env:DSH_OFFICE_PROBE_MODULES = 'C:\resource\deepseek-harness'
node probe/panel-render.mjs
```

It loads `client.js` the way the shell does — through `window.__ModuleLoader__`, with the client
primitives stubbed — renders the panel into jsdom against a stubbed office route, and drives the
interactions: collapsing and reopening the roster column from the header toggle and from the ✕ in
its own head, opening the mailbox sidebar and asserting its scrollport is not the channel's,
closing it again from its own ✕, unfolding a folded history row (asserting the history request is
made *below* the oldest message the feed holds, and that the older page is prepended), switching
the channel column between `#general` and a group channel through the switcher, opening the
Channels dialog onto the group channels, seeding the colleague dialog from the colleague it
was opened on, and asserting the wake each feed message states — the token the office recorded for
it, and `nobody` for one that woke nobody — and the do-not-disturb state a colleague's roster row
draws, with the reason it published.

The first snapshot is held back, which is the page's loading window: the check asserts the body
says it is loading, holds **no button and no field at all**, and reports itself busy, and that
releasing the answer draws the office. One full poll interval is then waited out, which is the only
way to observe a poll: the check asserts the request carries the token the previous answer was
given, and that a `MutationObserver` watching the panel records **no mutation at all** while the
office answers that nothing moved — the page is not rebuilt, so the reader's place in it survives.

Four assertions belong to the switch itself, and they are the reason the stub can hold an answer
back (see below):

- A switch asks the state route with the channel chosen, **and never asks again for the channel it
  left**. Before the panel dropped superseded answers, the answer to the channel a reader left was
  published, the panel followed it, and the two asked for each other for ever — the spin a reader
  saw as one switch reloading the panel without end.
- The switcher and the stored `channel:<office>` both hold the chosen channel, which is what makes
  the choice survive a reload. The same spin is what used to overwrite it with the channel that won
  the last round trip.
- An answer that arrives **after** the reader moved on is dropped: the switch to the group channel
  is held mid-flight, the reader picks `#general`, and the late answer must change nothing.
- The roster column reads the channel the feed reads — `#general` holds every colleague, a group
  channel only its stored members — and the header counts the same list. The probe's roster
  deliberately carries one colleague the group channel does not admit.

The stub therefore has a `holding` predicate and a `releaseHeld()`: a `fetch` matching the
predicate parks until released, which is how the check reproduces a poll that loses its race with a
switch. A held answer is what the effect-based code could not survive, and it is the only way to
drive that race without a real network.

It is opt-in because it needs `react`, `react-dom`, and `jsdom`, which this package does not
depend on. Point `DSH_OFFICE_PROBE_MODULES` at a directory holding a `node_modules` with them (a
DeepSeek Harness checkout works, including its pnpm store layout). Without them it reports itself
skipped and exits 0, so it is safe to wire into any pipeline.

This check earns its place: it caught a message view that carried no sequence number — so the
panel could render a feed but never unfold it — and a props binding the rail needed and did not
have. Neither is visible to a schema check or a syntax check.

## Reading a session back

```powershell
node probe/session-tool-scan.mjs <session.v4.jsonl.zstd> [name-regex]
```

It prints two things from one stored session: **every tool catalog its requests carried**, one line
per change with the sequence and the time, and **the tools it actually called**, most used first,
with the first and last sequence each appears at. The optional regex filters the call summary only,
so one run can ask "did it ever call `git_bash`" without losing the catalogs.

It is not a check: nothing asserts, and its exit code is 2 only for a missing argument. It is the
instrument for a question the plugin cannot answer for itself — *which tools did this colleague
hold, and when did that change* — and it reads the record rather than a model's account of itself.
Two facts about the format are load-bearing and are why it is a scan: a stored session is a
concatenation of small zstd frames (one per event batch), and Node's zstd stream stops after the
first frame, so the reader walks every frame magic instead. A catalog the session never called a
tool from is the case a call log cannot show, which is exactly the one that mattered when a cold
resume published a colleague with no preset plane ([hot-reload.md](hot-reload.md#reading-a-lost-plane-back-from-the-record)).

## What is not covered

- **A real Host.** No check mounts the package in a running DSH: activation against the
  Loader's composed config, the client bundle route, and a browser are checked by running it, as
  [hot-reload.md](hot-reload.md) describes.
- **The harness APIs themselves.** The fakes stand in for `ctx.agents.resume` and its `setup`, the
  preset registry, the permission presets, and the session projection; their contracts are read from
  the harness source, not asserted against it.
