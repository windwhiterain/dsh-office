# Hot reload

`@deepseek-ai/dsh-hmr` replaces configuration and module code in a running Host. What a change
needs before it is visible decides how you iterate on this package.

| Change | When the running Host sees it |
|---|---|
| A row's `config` in the **profile** patch | Live — the profile patch is watched |
| A row added inside an existing `insert` list | Live |
| A **profile patch rewritten wholesale** | Live for the rows whose composed `config` changed; every other row keeps the fiber it has — see below |
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
error message** is what an *empty office list* looks like: the registry read failed or answered
nothing, `useOffices` keeps the list it already had, and a freshly loaded page starts from an
empty one — so the panel renders nothing and says nothing.

Observed on a live Host (2026-09-27, `web` profile, this package linked into it):

| Time | Event |
|---|---|
| 11:46:04 | The profile patch was rewritten wholesale (29931 → 22599 bytes; a `dsh-history-access` row added) — a live config reload |
| then | The panel listed nothing, while `office_planet_x.json` kept advancing: the colleagues were posting, the roster and the record were intact (8 colleagues, 376 messages) |
| 11:52–11:54 | Writing the watched `index.js` re-applied the plugin generation; one activation marker recorded `03:54:10.926Z applyOffice planet_x` |
| after | The panel's next read showed the office again, with every colleague and message in place |

What is **observed** is the pairing: the office *tools* kept writing while the *routes* read an
empty registry, and a reload of the whole plugin generation cleared it. The explanation that fits
is a **partial remount** — a patch rewrite remounts only the rows whose composed `config` changed,
so the tools can remain bound to the office object of one generation while the routes answer from
another, whose module registry the office row's own disposer already emptied. The office's storage
is the source of truth either way, so nothing is lost while the two halves disagree.

Operating rules:

- **Empty panel + advancing office storage → reload the plugin generation.** Any write to a
  watched source file does it; no Host restart, no data loss. Distinguish it from a refused
  request first if you can: in the browser's Network tab, `200` with `{"offices":[]}` is this case,
  while `401`/`403`/`503` is the connection fence and `500` is the route's own data path.
- **A recurrence with nobody touching files is a defect**, not an operator mistake: it would mean
  the Loader's remount path itself leaves a plugin's routes and tools on different generations.
- A generation reload no longer disposes the colleagues the office woke: `ensureAgent` resumes
  through the process root context ([delivery.md](delivery.md#cold-resume)). The reloads in the
  table above left every running colleague alive — the office-resumed one included.
