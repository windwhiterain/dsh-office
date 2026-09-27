# Hot reload

`@deepseek-ai/dsh-hmr` replaces configuration and module code in a running Host. What a change
needs before it is visible decides how you iterate on this package.

| Change | When the running Host sees it |
|---|---|
| A row's `config` in the **profile** patch | Live — the profile patch is watched |
| A row added inside an existing `insert` list | Live |
| A **profile patch rewritten wholesale** | Live for the rows whose composed `config` changed; every other row keeps the fiber it has — see below |
| A **preset's `plugins` list** in the profile patch | Live for the next agent composed from that preset; an agent that is **already live** keeps the revision it was composed with — see [below](#a-preset-edit-and-the-agents-that-are-already-live) |
| A bare top-level row in the profile patch | Never — the Loader reads it as an id-targeted override and warns |
| `index.js` or `client.js`, with a watch root that names the file | Live — the plugin is disposed and imported again |
| The package's own `cordis.patch.yml` (a bundle layer) | Restart — bundle layers are read at startup |
| Installing, removing, or upgrading the package | Restart |

Two consequences shape day-to-day work here:

- **A source reload re-runs `apply()`.** The offices remount against the domains they already
  own, so the roster, the channels, the mailbox, and every message outlive the generation that
  wrote them. Anything the previous generation held in module state — the mounted-office
  registry, the per-agent tool installs — is rebuilt from the source of truth. That holds for a
  reload of the whole plugin; a **partial remount** is the case [below](#when-the-panel-lists-nothing-while-the-office-is-still-writing).
- **A renamed config field needs a restart when the value comes from a bundle layer.** The
  running row keeps the `config` the Loader composed at startup, so a plugin that no longer
  accepts a field it used to refuse will fail that row's activation until the Host restarts.
  This is exactly what happened when `operatorName` became `userName`.

## Enabling a source watch root

The base bundle ships `hmr` with `root: []`, which keeps configuration reloads and turns module
watching off. To watch this package's sources, override the row in the *profile* patch:

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    base: 'file:///C:/resource'
    root:
      - 'C:/resource/dsh-office/index.js'
      - 'C:/resource/dsh-office/client.js'
```

An override replaces the whole `config`, so `root` must be restated. Verify the composed result
with `dsh --profile <profile> --dump-config`. Three rules decide whether a root actually works,
all measured on Windows with Node 24:

1. **`base` must be an ancestor of every root.** The watcher filters each changed path by
   `relative(baseDir, path)` against `ignored`, whose default `**/.*` matches the `..` segments a
   root outside `base` produces — so such a root is silently watched by nobody, with no warning.
2. **`base` accepts a relative path or a `file://` URL, not an absolute drive path.** The service
   resolves it with `new URL(config.base, ctx.baseUrl)`, where `C:/resource` parses as URL scheme
   `c:` and activation fails with `ERR_INVALID_URL_SCHEME`.
3. **Name the files, not their directory.** A directory root makes the watcher stat the whole
   tree, and on Windows that races atomic writes inside it (measured: 2 `EPERM` failures in 500
   renames under a directory root, 0 under file roots).

`client.js` has a second condition: the Host serves a client plugin's bundle, so a client change
is visible on the next page load, and reloads in place only while a client rebuild watcher is
running for the same checkout. A plain source edit to `client.js` is picked up by the bundle
route, which is enough to check the panel by reloading the page.

## Iterating without disturbing a live Host

An out-of-tree plugin is installed as a bundle, and the Host resolves it from the profile's
`node_modules`; a `link:` dependency resolves to a real directory, and that directory is the code
the Host runs. So the way to iterate safely is to control which directory the Host is allowed to
see:

| Tree | Role |
|---|---|
| the checkout the profile links to | **Stable.** Moves only at a checkpoint. |
| a second worktree on a feature branch | **Dev.** Every edit and every probe run. No profile links it. |

A worktree keeps its own `node_modules`, so install the package's dependencies there before
running anything. Then run a **second Host** for the dev tree, with its own `DSH_HOME`, profile,
and port, so restarting it interrupts no session anywhere else:

```powershell
git -C C:\resource\dsh-office worktree add C:\resource\dsh-office-dev -b feat/office-dev
$env:DSH_HOME = 'C:\resource\dsh-office-dev-home'
dsh --profile office-dev --from-default-profile web          # initialize the profile (no boot)
dsh plugin --profile office-dev add C:/resource/dsh-office-dev
dsh --profile office-dev --port 3081 --no-open               # boot it
```

A separate `DSH_HOME` separates profiles, sessions, storages, settings, and credentials — copy
`.credentials.yaml` into it. Ports must differ: the web server fails with `EADDRINUSE` rather
than picking another port. The dev profile's patch is the place for dev-only rows: the `hmr`
config above, and a `danger-full-access` default preset when the plugin's tools need it.

Promoting a checkpoint is then a fast-forward of the stable tree:

```powershell
git -C C:\resource\dsh-office-dev commit -am "..."
git -C C:\resource\dsh-office merge --ff-only feat/office-dev
```

The Host watching the stable tree reloads the plugin at that moment; without a watch root for it,
the change applies at its next restart. Keep the stable tree at the last working commit — any
restart loads whatever it holds, including a half-finished edit.

## When the panel lists nothing while the office is still writing

The panel reads the mounted offices from `GET /dsh-office/offices` and then one snapshot from
`GET /dsh-office/offices/state`. An **empty roster and empty channel and mailbox columns with no
error message** has more than one cause that looks identical on screen, so read the browser's
Network tab before touching anything:

| `GET /dsh-office/offices` | `GET /dsh-office/offices/state` | What it is |
|---|---|---|
| `200` `{"offices":[...]}` | `200` with a snapshot | The office is served; the page is drawing an answer it never repainted from, so reload it |
| `200` `{"offices":[...]}` | pending for seconds | A slow snapshot, which is what the page's loading state is drawn for — see below |
| `200` `{"offices":[]}` | `404` | The registry is empty: the office is mounted nowhere the host row can see |
| `401`/`403`/`503` | any | The connection fence. The page was not opened through the URL `dsh web` printed |
| any | `500` | The route's own data path, and the answer body names the failure |

### Measured recurrence, 2026-09-27

`web` profile, this package linked into it. The panel drew the office shell with empty columns
while the office was quiet — its storage file did not change across a 30-second window — and the
state route answered in **10–12 seconds**, five times in a row. The cost was in the route rather
than in the Host's load: `/dsh-office/offices` answered in 4 ms throughout, the state snapshot
itself was 50 KB, and the Host process spent 2.5 s of an 8.3 s request in CPU.

What the route was doing was resolving the roster's **names**. `listColleagues` asked
`sessionQuery.readTitle` once per colleague, sequentially, and that read resolves the session's
source and copies every event of its log — measured here at 121 ms for the largest colleague alone
(8852 events, 19.3 MB of text). The snapshot asked for the roster twice (once for the statuses,
once to exclude adopted sessions from the adopt picker), `modelRouteOf` could add a full
`readSession` per live colleague, and the panel polled every 4 seconds **with no in-flight guard**,
so two or three of those snapshots were always outstanding and the page never caught up. The office
was healthy throughout; only its listing was slow.

What changed as a result, all of it inside this package:

- A roster's names come from the listing pair every other surface already reads — a live session's
  `title` projection, else the projection cache's row by header — and the log fold is the last
  resort rather than the first read. One corpus listing per request serves both the names and the
  adopt picker, which excludes the roster by session id and resolves no name at all.
- A poll of a page already on screen hands back the snapshot's token and is answered `unchanged`
  while nothing it describes has moved — see
  [design.md](design.md#what-a-panel-poll-costs).
- The panel asks for one office and channel at a time, and only its first answer gates the page.

It is worth re-measuring rather than assuming after any change here: the same authenticated read
is one command, and the route is the one the panel lives on.

```powershell
# with the browser session cookie of the profile's Host
$sw = [Diagnostics.Stopwatch]::StartNew()
Invoke-WebRequest -Uri 'http://127.0.0.1:3080/dsh-office/offices/state?office=<name>' -Headers @{ Cookie = $cookie } -UseBasicParsing | Out-Null
$sw.Elapsed.TotalMilliseconds
```

### Earlier observation, 2026-09-27 11:46

The panel listed nothing while `office_planet_x.json` kept advancing — the colleagues were posting
and the roster and record were intact (8 colleagues, 376 messages) — right after the profile patch
was rewritten wholesale (29931 → 22599 bytes, a `dsh-history-access` row added). Writing the
watched `index.js` re-applied the plugin generation, and the panel's next read showed the office
again. The pairing is real — the office *tools* kept writing while the *routes* answered nothing —
but its cause was never measured, and it is **not** the recurrence above: there the office list
itself answered with the office. The partial-remount explanation first offered for it (a patch
rewrite remounting only the rows whose composed `config` changed, leaving one generation's tools
beside another's routes) remains a hypothesis that fits and was never confirmed, so the code was
not changed to defend against it.

Operating rules:

- **A busy answer is not an empty one.** Wait out the first snapshot; that wait is what the loading
  state is drawn for. A panel that stays empty while `/offices` answers with the office is a page
  that needs a reload, not a repair.
- **`{"offices":[]}` while the office is writing is a registry problem, not a data problem.** Write
  to a watched source file to re-apply the plugin generation; no Host restart, and the office's
  storage is untouched either way.
- A generation reload does not dispose the colleagues the office woke: `ensureAgent` resumes
  through the process root context ([delivery.md](delivery.md#cold-resume)). The reloads recorded
  above left every running colleague alive — the office-resumed one included.

## A preset edit and the agents that are already live

A preset declaration owns a **generation**: one mounted scope that every agent composed from that
preset is parented to, kept alive for its users and retired only when the last of them lets go
(`agent-preset-registry`'s `Generation`). A profile-patch reload mounts a new generation for the
new composition, so:

- an agent composed **after** the edit runs the new composition;
- an agent that is **already live** keeps the composition it was composed with — including a row the
  edit removed, and including the *absence* of a row the edit added.

That is deliberate: an operator tuning a preset must not pull the plane out from under a session
that is mid-turn. But it means a preset edit is not visible to a live agent, and the office keeps
colleagues alive across reloads on purpose ([README](../README.md#installation-lifetime)), so an
office is where a stale plane is most likely to be met. Two consequences for working here:

- **A preset change is not a colleague change.** The edit reaches the colleagues the office composes
  *after* it — a cold wake mounts the preset the session's log names, a colleague found live without
  one is rebound ([delivery.md](delivery.md#cold-resume)) — so a colleague that keeps working
  through the edit keeps the plane it had. Read the plane rather than assuming it.
- **A colleague's plane is a fact the office reports.** `office_colleagues` prints each live
  colleague's agent preset and how many tools it holds; `none`, or a count in the single digits where
  the preset declares dozens, is a colleague holding only the office's own tools.

### Reading a lost plane back from the record

```powershell
node probe/session-tool-scan.mjs <session.v4.jsonl.zstd> [name-regex]
```

It prints every tool catalog a session's requests carried — one line per change, with the sequence
and time — beside the tools it actually called. The catalog list is the load-bearing half: a plane
the session never called a tool from is invisible to a call log, and a colleague stripped of its
shell is exactly a session with no shell calls and a *smaller* request header.

Observed on a live Host (2026-09-27, `web` profile, this package linked into it): a colleague's
catalog went from 27 tools to 8 at the moment the office woke it cold, while its 112 `git_bash`
calls all sat *before* that line. The cause was the wake, not the catalog: the office resumed the
session without the `setup` that mounts its preset, so the resume published an agent holding the
office's own tools and the deployment's globals and nothing else. That is what `delivery.md`'s cold
resume section now forbids, and what the smoke probe pins.
