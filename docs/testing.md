# Testing

Two checks live outside the shipped package: `probe/smoke.mjs` covers the plugin logic without a
Harness, and `probe/panel-render.mjs` covers the Web panel's render path and its contract with
the state route. Neither is part of what a deployment installs.

## The offline probe

```powershell
node probe/smoke.mjs
```

It drives `apply()` against in-memory fakes: a storage domain over plain maps, an agent registry
that publishes real Cordis root events, a permission-preset service, a session controller, and a
route table that runs the handlers the panel calls. It checks the office logic, the per-agent
tool scoping, every declared tool output against its own schema, and the routes. It needs no
running Harness and no dependencies beyond the package's own, so it runs on every edit.

What it covers, by area:

- **Activation and configuration** — row kinds, field validation, unknown fields, the office name
  and storage key rules, the profile-patch edits (create, delete, rename, disable) with the
  operator's comments preserved.
- **Roles** — the tool set each predefined role holds, the union across two memberships and the
  per-call capability check that narrows it, a role change withdrawing tools from the live
  session, the `rolePermissions` map and its fail-closed refusal, and the migration of a stored
  role that is no longer predefined.
- **The wake** — the required `wake` argument and its two spellings: each level reaching its own
  rung and every rung above it, a named wake staying exactly the colleagues it names, the sender
  never woken by its own post, an empty list waking nobody, and the refusals: an omitted or
  non-array `wake`, a name without its `@`, a level nobody predefined, a level combined with
  anything else, and a name that matches no session title. `office_dm` naming exactly one colleague
  and refusing a level, and the panel route deriving the same tokens from the body it stores are
  covered beside it.
- **Delivery** — the default timing steering a post and a dm into a running turn and the refusal of
  an unknown timing, the `source.kind` each delivery claims (`user` on the splice the Web Chat draws
  as an in-turn message, `office-message` on the turn it draws as a trigger), `turn-end` merging a
  burst into one turn, a durable hold surviving a simulated restart, cold resume on the route the
  session last logged, delivery statuses, and the frames, including the role-aware answering rule. A
  `step-end` wake is covered too: the steer into a running turn, the hold released when the harness
  claims the message, the recovery of a wake nothing claimed (still pending, discarded, or carried
  across a restart), and the hold deleted with a deleted channel.
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
- **The panel routes** — the state snapshot (roster, roles, mailbox, totals, the channel the feed
  asked for), the history page a folded row asks for, hire, configure, dismiss, and the connection
  policy each one applies.

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
Channels dialog onto the group channels, and seeding the colleague dialog from the colleague it
was opened on.

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

## What is not covered

- **A real Host.** Neither check mounts the package in a running DSH: activation against the
  Loader's composed config, the client bundle route, and a browser are checked by running it, as
  [hot-reload.md](hot-reload.md) describes.
- **The harness APIs themselves.** The fakes stand in for `ctx.agents.resume`, the permission
  presets, and the session projection; their contracts are read from the harness source, not
  asserted against it.
