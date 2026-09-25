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
- **Delivery** — merging a burst into one turn, a durable hold surviving a simulated restart,
  cold resume on the route the session last logged, delivery statuses, and the frames, including
  the role-aware answering rule.
- **The user mailbox** — `@user` in a public post filing a copy with its `origin`, `office_dm` to
  the user waking nobody, and every spelling of the mailbox being refused to `office_read` and
  `office_compact` while `channel: "*"` never reaches it.
- **The panel routes** — the state snapshot (roster, roles, mailbox, totals), the history page a
  folded row asks for, hire, configure, dismiss, and the connection policy each one applies.

Keep it out of `index.js`: the shipped plugin carries no test code, and `package.json`'s `files`
list ships neither `probe/` nor `docs/`.

## The panel render check

```powershell
$env:DSH_OFFICE_PROBE_MODULES = 'C:\resource\deepseek-harness'
node probe/panel-render.mjs
```

It loads `client.js` the way the shell does — through `window.__ModuleLoader__`, with the client
primitives stubbed — renders the panel into jsdom against a stubbed office route, and drives the
interactions: collapsing and reopening the roster column, opening the mailbox sidebar and
asserting its scrollport is not the channel's, closing it again from the sidebar's own button,
unfolding a folded history row (asserting the history request is made *below* the oldest message
the feed holds, and that the older page is prepended), and seeding the colleague dialog from the
colleague it was opened on.

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
