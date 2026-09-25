# Hot reload

`@deepseek-ai/dsh-hmr` replaces configuration and module code in a running Host. What a change
needs before it is visible decides how you iterate on this package.

| Change | When the running Host sees it |
|---|---|
| A row's `config` in the **profile** patch | Live — the profile patch is watched |
| A row added inside an existing `insert` list | Live |
| A bare top-level row in the profile patch | Never — the Loader reads it as an id-targeted override and warns |
| `index.js` or `client.js`, with a watch root that names the file | Live — the plugin is disposed and imported again |
| The package's own `cordis.patch.yml` (a bundle layer) | Restart — bundle layers are read at startup |
| Installing, removing, or upgrading the package | Restart |

Two consequences shape day-to-day work here:

- **A source reload re-runs `apply()`.** The offices remount against the domains they already
  own, so the roster, the channels, the mailbox, and every message outlive the generation that
  wrote them. Anything the previous generation held in module state — the mounted-office
  registry, the per-agent tool installs — is rebuilt from the source of truth.
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
