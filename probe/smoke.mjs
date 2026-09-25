/**
 * Offline probe for dsh-office.
 *
 * Drives `apply()` against in-memory fakes so the office logic, the per-agent tool
 * scoping, and every declared tool output can be checked without a running Harness.
 *
 * Run: node probe/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parse } from 'yaml'
import { apply } from '../index.js'

/** Scratch profile patch this probe edits; kept inside the package, removed at the end. */
const PATCH_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'patch-scratch.yml')

/** Seed patch carrying a user comment that every edit must preserve. */
const PATCH_SEED = `# user comment that must survive every edit
- id: office
  name: 'dsh-office'
  disabled: false
  config:
    officeName: office
`

/**
 * Office rows of a profile patch the Loader would mount.
 *
 * The Loader appends a patch entry's `insert` list to the tree and reads an entry
 * without one as an id-targeted override, which is skipped with a warning when no row
 * carries that id. Checking a row's presence in the file's text cannot tell those apart,
 * which is how a created office once reached the profile without ever mounting.
 * @param text - the profile patch file's contents.
 * @returns the inserted rows whose module is this package.
 */
function mountedOfficeRows(text) {
  return parse(text)
    .flatMap(entry => entry?.insert ?? [])
    .filter(row => row?.name === 'dsh-office')
}

/** Office rows written as a top-level entry, which the Loader only reads as an override. */
function overrideOfficeRows(text) {
  return parse(text).filter(entry => entry?.name === 'dsh-office')
}

/** Minimal JSON Schema check over the subset the tools declare. */
function validate(value, schema, path = 'value') {  const errors = []
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path} must be an object`]
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      const declared = Object.keys(schema.properties ?? {})
      for (const key of Object.keys(value)) {
        if (!declared.includes(key)) errors.push(`${path}.${key} is not a declared property`)
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`))
    }
    return errors
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    return value.flatMap((item, index) => validate(item, schema.items ?? {}, `${path}[${index}]`))
  }
  if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path} must be a string`)
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) errors.push(`${path} must be an integer`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be a boolean`)
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join('|')}`)
  }
  return errors
}

/**
 * Check one tool's parameter schema against the rules the providers enforce.
 *
 * A `required` array with a repeated element is rejected at the API boundary before any
 * call is made, and the rejection names one tool while invalidating the whole batch. The
 * declaration helper adds the role's `office` argument itself, so a tool that lists
 * `office` a second time duplicates it here.
 * @param schema - the `parameters` schema of one registered tool.
 * @param path - the diagnostic prefix.
 * @returns the violations, empty when the schema is well formed.
 */
function parameterSchemaErrors(schema, path = 'parameters') {
  const errors = []
  if (schema?.type !== 'object') errors.push(`${path}.type must be "object"`)
  const required = schema?.required ?? []
  if (new Set(required).size !== required.length) {
    errors.push(`${path}.required has non-unique elements: ${JSON.stringify(required)}`)
  }
  const declared = Object.keys(schema?.properties ?? {})
  for (const key of required) {
    if (!declared.includes(key)) errors.push(`${path}.required names "${key}", which the properties do not declare`)
  }
  return errors
}

/** One in-memory `KvTable` with the domain facility's read and write contract. */
function makeTable() {
  const records = new Map()
  return {
    get: key => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size },
    put: async (key, value) => { records.set(key, value) },
    delete: async key => records.delete(key),
    update: async (key, transform) => {
      if (!records.has(key)) throw new Error(`missing-key: ${key}`)
      const next = transform(records.get(key))
      records.set(key, next)
      return next
    },
  }
}

/** Execute one registered route against a minimal request and response. */
function callRoute(routes, path, options = {}) {
  const [pathname] = path.split('?')
  const route = routes.get(pathname)
  assert.ok(route, `route ${pathname} must be registered`)
  const { method = 'GET', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const listeners = new Map()
    const req = {
      method,
      headers,
      // The Web server matches on `new URL(req.url).pathname` and reads the query from the
      // same URL, so a fake request carries the whole path.
      url: path,
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(listener)
        return req
      },
      destroy() {},
    }
    const res = {
      status: undefined,
      payload: undefined,
      writeHead(status) { this.status = status },
      end(text) {
        this.payload = text === undefined ? undefined : JSON.parse(text)
        resolve(this)
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
    if (method === 'POST') {
      queueMicrotask(() => {
        for (const listener of listeners.get('data') ?? []) listener(Buffer.from(JSON.stringify(body ?? {})))
        for (const listener of listeners.get('end') ?? []) listener()
      })
    }
  })
}

/**
 * Whether one value survives a JSON round trip, which is what `Session.append` requires.
 *
 * The session log is JSON, so the harness rejects a value JSON would change: `undefined`, a
 * function, a symbol, a BigInt, a non-finite or negative-zero number, a sparse array, and any
 * object whose prototype is not `Object.prototype` — a `Map`, a `Set`, a `Date`, a class
 * instance. A delivered message is appended to the target's log inside an
 * `agent/inbox/spliced` event, so this is the check a fake agent must apply to it.
 * @param value - the value to test.
 * @param path - prototypes already visited on this path, to detect a cycle.
 * @returns whether JSON preserves the value exactly.
 */
function jsonSafe(value, path = new Set()) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (type !== 'object') return false
  if (path.has(value)) return false
  path.add(value)
  const safe = Array.isArray(value)
    ? value.every((item, index) => index in value && jsonSafe(item, path))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.values(value).every(item => jsonSafe(item, path))
  path.delete(value)
  return safe
}

/**
 * One session's durable pending input, as the harness projects it.
 *
 * The real inbox is a projection over the session's own log, so it outlives the agent that
 * carried it: a restart reattaches the same pending messages rather than an empty list. The
 * probe keeps it per session for that reason — a fake that dropped it would hide the wake an
 * office recovers after a restart.
 * @returns the fake inbox: pending step input, its insertion, and the office's removal.
 */
function makeInbox() {
  const nextStep = []
  return {
    nextStep,
    /**
     * Remove one pending message, as `Agent.inbox.remove` does.
     * @param messageId - the identity of the pending message.
     * @returns whether it was still pending.
     */
    remove(messageId) {
      const index = nextStep.findIndex(message => message.id === messageId)
      if (index < 0) return false
      nextStep.splice(index, 1)
      return true
    },
    /**
     * Insert one message the way `steer` does: the inbox commits it as pending step input.
     * @param message - the message being spliced in.
     */
    insert(message) {
      nextStep.push(message)
    },
  }
}

/** One fake Agent carrying its own tool scope, exactly as `agent.ctx.tools` does. */
function makeAgent(sessionId, status, cwd, preset, inbox = makeInbox()) {
  const tools = new Map()
  const sent = []
  /** Cancellations this agent received, so a check can tell an interrupt from a no-op. */
  const cancels = []
  /**
   * Accept one injected message the way the real loop does: the inbox commits an
   * `agent/inbox/spliced` event carrying it, and the session log rejects data it cannot
   * store. A fake that accepts anything hides a delivery that never reaches a colleague.
   * @param message - the message the office injected.
   */
  const accept = (message) => {
    assert.ok(
      jsonSafe(message),
      `a delivered message must be losslessly JSON-serializable, got ${JSON.stringify(message)}`,
    )
    return message
  }
  return {
    sent,
    cancels,
    tools,
    inbox,
    session: { header: { id: sessionId, cwd, ...(preset === undefined ? {} : { agentPreset: preset }) } },
    status,
    // The route a live colleague runs on. `rosterStatus` reports it, and the real Agent carries
    // it the same way, so a fake without it would hide a status read that fails live.
    options: { provider: 'probe-provider', model: 'probe-model' },
    ctx: {
      tools: {
        register: (definition) => {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    },
    followup: message => sent.push({ via: 'followup', message: accept(message) }),
    /**
     * Splice one message into the running turn's next step boundary, as `Agent.steer` does: the
     * driver claims it there, which is the moment the office stops holding it.
     */
    steer: (message) => {
      sent.push({ via: 'steer', message: accept(message) })
      inbox.insert(message)
    },
    /**
     * Cancel the running turn, as `Agent.cancel` does.
     *
     * The real method clears pending work unless `keepInbox`, and the office relies on the
     * inbox being kept, so the fake records what it was asked to do.
     * @param cause - the cancellation cause.
     * @param options - `keepInbox` preserves pending work.
     */
    cancel: (cause, options) => { cancels.push({ cause, options }) },
  }
}

/**
 * Collect the fake session world.
 *
 * `globalTools` must stay empty: office tools are installed per agent scope, never on
 * `ctx.tools`. `titles` is the fake `session/title` store, and `publish` is the only way
 * an agent enters the live registry, so `agent/created` fires exactly as it does live.
 */
/**
 * `agent/created` and `agent/disposed` listeners, shared by every harness.
 *
 * These are Cordis ROOT events: a listener registered through any context sees every
 * agent the process publishes, whichever context published it. Keeping them per harness
 * would hide an agent from the one host that arms it.
 */
const createdListeners = []
const disposedListeners = []
/**
 * `agent/status` listeners, shared by every harness for the same reason as the two above: the
 * office delivers what it held for a colleague when that colleague's turn ends, and the event
 * it listens for is process-wide.
 */
const statusListeners = []
/**
 * `agent/inbox/claimed` listeners, shared for the same reason again: the office stops holding a
 * step-end wake when the harness takes that message into a step, and the claim is process-wide.
 */
const inboxClaimListeners = []

function makeHarness(rawConfig, loggedRoute, features = {}) {
  const tables = new Map()
  const globalTools = new Map()
  const routes = new Map()
  const liveAgents = new Map()
  /** Pending input per session, which a resumed agent reattaches rather than starting empty. */
  const inboxes = new Map()
  const titles = new Map()
  const resumed = []
  const hires = []
  const selects = []
  /** One-shot failures the harness was asked to inject, so a check can fail an operation once. */
  const failures = {}
  /**
   * Storage units this harness has opened, keyed by unit name.
   *
   * A real backend keeps one medium per unit name, so reopening a unit returns what was
   * stored in it — including the global slot that records which office owns it.
   */
  const units = new Map()
  /**
   * Cleanups the fake context owes its fiber: effect callbacks and `on` listeners. Cordis
   * runs them when the fiber is disposed, so the probe must too — the office keeps both
   * module-level registry state and process-wide tool installation.
   */
  const effects = []
  /**
   * The permission presets this fake deployment defines, and the preset each session runs under.
   *
   * A profile may configure a table without `read-only`, which is the case the office must refuse
   * rather than skip, so the names are a feature a check can narrow. A session that never had a
   * preset set reads as `workspace-write`, the composition default this fake stands in for.
   */
  const permissionNames = features.permissionPresets ?? ['read-only', 'workspace-write', 'danger-full-access']
  const permissions = new Map()
  const loggedEvents = loggedRoute === undefined
    ? []
    : [{ type: 'request/header', data: { header: { config: loggedRoute } } }]

  /**
   * The durable pending input of one session, which belongs to the session rather than to the
   * agent process: resuming a session reattaches what it was carrying.
   * @param sessionId - the session whose inbox to read.
   * @returns its fake inbox.
   */
  function inboxOf(sessionId) {
    if (!inboxes.has(sessionId)) inboxes.set(sessionId, makeInbox())
    return inboxes.get(sessionId)
  }

  function publish(sessionId, options = {}) {
    const agent = makeAgent(sessionId, options.status ?? 'idle', options.cwd, options.preset, inboxOf(sessionId))
    liveAgents.set(sessionId, agent)
    for (const listener of createdListeners) listener({ agent })
    return agent
  }

  const ctx = {
    storageDomain: {
      open: async (spec) => {
        if (!units.has(spec.name)) units.set(spec.name, { value: spec.global?.initial })
        const slot = units.get(spec.name)
        return {
          name: spec.name,
          global: {
            get: () => slot.value,
            set: async (next) => { slot.value = next },
          },
          table: (name) => {
            if (!tables.has(name)) tables.set(name, makeTable())
            return tables.get(name)
          },
          close: async () => {},
        }
      },
    },
    tools: {
      register: (definition) => {
        globalTools.set(definition.name, definition)
        return () => globalTools.delete(definition.name)
      },
    },
    agents: {
      get: sessionId => liveAgents.get(sessionId),
      list: () => [...liveAgents.values()],
      resume: async (options) => {
        if (options?.agentOptions === undefined) {
          throw new Error('resume must carry agentOptions: the provider/model prompt variables read agent.options')
        }
        // A single failed resume models the transient failure a real deployment hits (a
        // session that cannot be brought up right now). The message stays stored and unseen,
        // which is the case a later wake has to carry.
        if (features.failResumeOnce === true && !failures.resume) {
          failures.resume = options.resumeSessionId
          throw new Error(`resume failed for ${options.resumeSessionId}`)
        }
        resumed.push({ sessionId: options.resumeSessionId, agentOptions: options.agentOptions })
        if (features.slowResumeMs !== undefined) {
          // A cold start that takes a moment, which is when the channel can move on between the
          // message being stored and the colleague being handed it.
          await new Promise(resolve => setTimeout(resolve, features.slowResumeMs))
        }
        const agent = publish(options.resumeSessionId)
        return { agent, dispose: async () => {} }
      },
    },
    on: (event, listener) => {
      const listeners = event === 'agent/created'
        ? createdListeners
        : event === 'agent/disposed' ? disposedListeners
          : event === 'agent/status' ? statusListeners
            : event === 'agent/inbox/claimed' ? inboxClaimListeners : undefined
      if (listeners === undefined) return () => {}
      listeners.push(listener)
      const dispose = () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
      // Cordis scopes a listener to the fiber that registered it, so a disposed office
      // stops observing agents. The fake must do the same or a closed harness keeps
      // arming agents for offices that are no longer mounted.
      effects.push(dispose)
      return dispose
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      requestRejection: (request) => (request.headers['x-test-refuse'] === 'yes' ? 403 : undefined),
    },
    effect: (callback) => {
      const disposer = callback()
      const dispose = () => { if (typeof disposer === 'function') disposer() }
      effects.push(dispose)
      return dispose
    },
    // Cordis runs the callback once every named service is available; the fakes are
    // plain properties, so availability is immediate here.
    inject: (deps, callback) => callback(ctx),
    get: (name) => {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
      }
      if (name === 'sessionQuery') {
        return {
          readSession: async () => ({ events: loggedEvents }),
          readTitle: async (sessionId) => {
            const title = titles.get(sessionId)
            return title === undefined
              ? undefined
              : { title, source: { kind: 'user' }, messageSeqs: [], eventSeq: 0, updatedAt: 0 }
          },
          // The recent-session listing the unadopted report reads. A session that was never
          // published or was disposed keeps its record, because a session can be adopted
          // without being live; the features' cold rows model exactly that case.
          listSessions: async () => [
            ...[...liveAgents.values()].map(agent => ({
              header: { id: agent.session.header.id, createdAt: 0 },
              title: titles.get(agent.session.header.id) ?? undefined,
            })),
            ...(features.coldSessions ?? []).map(header => ({ header, live: false, persisted: true })),
          ],
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          // Workspace accounts carry the header-validated sessions the Web sidebar shows under
          // them. The fake derives the account from the live headers' cwd, which is the same
          // rule the real registry indexes on. The archive set is the registry's own: sessions
          // in it are out of every listing.
          archivedSessionIds: features.archivedSessionIds ?? [],
          list: () => [
            { id: 'workspace-first', title: 'First', sessionIds: [] },
            {
              id: 'workspace-own',
              title: 'Own',
              sessionIds: [
                ...[...liveAgents.values()]
                  .filter(agent => agent.session.header.cwd === '/work/mine')
                  .map(agent => agent.session.header.id),
                // The features' accounted cold rows, which the real registry accounts the same
                // way it accounts any persisted header.
                ...(features.accountedIds ?? []),
              ],
            },
          ],
          resolveByPath: async (path) => (path === '/work/mine' ? { id: 'workspace-own', title: 'Own' } : undefined),
        }
      }
      if (name === 'profileContext') {
        return features.profileContext === false ? undefined : { patchPath: PATCH_PATH }
      }
      if (name === 'agentPresets') {
        return { list: async () => [{ id: 'standard', name: 'Standard' }, { id: 'broken', broken: 'nope' }] }
      }
      if (name === 'permissionPresets') {
        if (features.permissionPresets === null) return undefined
        return {
          names: permissionNames,
          current: (session) => permissions.get(session.header.id) ?? 'workspace-write',
          set: (session, preset) => {
            if (!permissionNames.includes(preset)) throw new Error(`permission: unknown preset "${preset}"`)
            permissions.set(session.header.id, preset)
          },
        }
      }
      if (name === 'sessionProjections') {
        // Only the harnesses that declare one model selection per session expose the registry, so
        // the checks below can tell a read of the projection from a read of `agent.options`. The
        // `title` unit is what the Web session list displays: the latest title event a session's
        // log carries, which the `titles` rename store is the fake of, before any feature-provided
        // static titles. A registry without the unit carries no title at all.
        if (features.modelSelection === undefined && features.titles === undefined) return undefined
        return {
          stateOf: (session, key) => {
            if (key === 'modelSelection') return features.modelSelection?.[session.header.id]
            if (key === 'title') return titles.get(session.header.id) ?? features.titles?.[session.header.id] ?? null
            return undefined
          },
        }
      }
      if (name === 'sessionProjectionCache') {
        if (features.coldTitles === undefined) return undefined
        return {
          cachedSnapshot: (header) => ({ asOfSeq: 0, values: { title: features.coldTitles[header.id] ?? null } }),
        }
      }
      if (name === 'sessionController') {
        return {
          create: async (request) => {
            hires.push({ workspaceId: request.workspaceId, agentPreset: request.agentPreset })
            const sessionId = `session-hired-${hires.length}`
            publish(sessionId)
            return {
              sessionId,
              workspaceId: request.workspaceId,
              ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
            }
          },
          rename: async ({ sessionId, title }) => {
            titles.set(sessionId, title)
            return { title, seq: 0 }
          },
          selectModel: async (request) => {
            selects.push(request)
            return { selection: { provider: request.provider, model: request.model } }
          },
          modelCatalog: async () => ({
            default: { provider: 'default-provider', model: 'default-model' },
            routableProviders: ['probe'],
            groups: [{ id: 'probe', name: 'Probe', models: [{ id: 'probe-model', name: 'Probe Model' }] }],
            failures: [],
          }),
        }
      }
      // Cordis reads a service either as `ctx.<name>` or through `ctx.get(name)`; the
      // remaining fakes are plain properties, so fall back to them.
      return ctx[name]
    },
    // One row per apply call, so this harness rewrites the id before mounting each row.
    // The kind of a row is its id, exactly as it is for a Loader entry.
    fiber: { entry: { options: { id: '' } } },
    logger: { error: (message) => { throw new Error(message) } },
  }
  /**
   * Disposing a fiber runs its effects' cleanups, and the office keeps module-level state:
   * which offices are mounted and which agents hold the shared tool set. A check that
   * leaves a harness mounted would leak both into every later check.
   */
  const close = async () => {
    for (const dispose of effects.reverse()) dispose()
    effects.length = 0
  }
  openedHarnesses.push(close)
  return {
    ctx,
    globalTools,
    tables,
    routes,
    liveAgents,
    titles,
    resumed,
    hires,
    selects,
    permissions,
    publish,
    close,
    /**
     * End or start one live agent's turn, firing `agent/status` exactly as the loop's phase
     * change does, and let the office finish what that releases.
     *
     * The delivery a status change triggers is asynchronous, so this waits for a task boundary
     * rather than a microtask: the office awaits storage writes, which are promises of their own.
     * @param sessionId - the live agent whose status changes.
     * @param status - the status it enters.
     */
    setStatus: async (sessionId, status) => {
      const agent = liveAgents.get(sessionId)
      assert.ok(agent, `${sessionId} must be live to change its status`)
      agent.status = status
      for (const listener of statusListeners) listener({ agent, status })
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    /** Enter one already-built agent into this harness, firing `agent/created`. */
    adoptAgent: (agent) => {
      liveAgents.set(agent.session.header.id, agent)
      for (const listener of createdListeners) listener({ agent })
      return agent
    },
    /**
     * Claim one agent's pending input at a step boundary, exactly as the loop's `preStep` does.
     *
     * This is where a step-end wake stops being pending and starts being part of the turn that
     * is running, which is the moment the office must stop holding it.
     * @param sessionId - the live agent whose step boundary arrives.
     * @returns the messages that step claimed.
     */
    claim: (sessionId) => {
      const agent = liveAgents.get(sessionId)
      assert.ok(agent, `${sessionId} must be live to claim its input`)
      const claimed = agent.inbox.nextStep.splice(0, agent.inbox.nextStep.length)
      for (const message of claimed) {
        for (const listener of inboxClaimListeners) listener({ agent, message, turn: 1 })
      }
      return claimed
    },
    /**
     * Drop one agent's pending input without a claim, as a cancellation that does not keep the
     * inbox does. Nothing the office holds is acknowledged by this, which is the case its
     * recovery exists for.
     * @param sessionId - the live agent whose pending input is discarded.
     */
    discardInbox: (sessionId) => {
      const agent = liveAgents.get(sessionId)
      assert.ok(agent, `${sessionId} must be live to discard its input`)
      agent.inbox.nextStep.length = 0
    },
    dispose: (agent) => {
      liveAgents.delete(agent.session.header.id)
      for (const listener of disposedListeners) listener({ agent })
    },
    /**
     * Mount this harness's rows. An office row is the normal case; the host is a process
     * singleton, so only the harness that owns it passes `features.host`, and every other
     * harness mounts offices into that one host's registry.
     *
     * The row id is the office's default storage key, so each harness takes the id its office
     * name would produce: two harnesses sharing an id would share one registry entry. The
     * shipped office keeps the bare `office` id its own patch uses.
     */
    ready: (async () => {
      if (features.host === true) {
        ctx.fiber.entry.options.id = 'office-host'
        await apply(ctx, features.hostConfig ?? {})
      }
      if (features.office !== false) {
        const officeName = rawConfig?.officeName ?? 'office'
        ctx.fiber.entry.options.id = features.rowId ?? (officeName === 'office' ? 'office' : `office_${officeName}`)
        await apply(ctx, { officeName: 'office', ...(rawConfig ?? {}) })
      }
    })(),
  }
}

/** Execute one agent-scoped tool and assert its value matches the declared schema. */
async function call(agent, name, args) {
  const tool = agent.tools.get(name)
  assert.ok(tool, `tool ${name} must be installed for ${agent.session.header.id}`)
  const value = await tool.execute(args, { agent })
  const errors = validate(value, tool.output.schema)
  assert.deepEqual(errors, [], `${name} output violates its declared schema`)
  assert.ok(Array.isArray(tool.output.render(args, value)), `${name} render must return content blocks`)
  return value
}

/**
 * Call one boss tool. A boss names the office it acts on, so every boss call carries it;
 * `call` stays the raw form for the checks that exercise the office argument itself.
 * @param agent - the boss agent.
 * @param officeName - the office the call acts on.
 * @param name - the registered tool name.
 * @param args - the remaining tool arguments.
 * @returns the validated tool value.
 */
const callBoss = (agent, officeName, name, args = {}) => call(agent, name, { office: officeName, ...args })

/**
 * The stored record of one message, found by the identity an office tool reported.
 * @param harness - the harness whose office domain holds it.
 * @param messageId - the `messageId` a post result carried.
 * @returns the stored message record, with its delivery outcomes.
 */
function storedMessage(harness, messageId) {
  for (const [, value] of harness.tables.get('messages').entries()) {
    if (value.messageId === messageId) return value
  }
  throw new Error(`no stored message ${messageId}`)
}

/** Wait for the office's own asynchronous storage writes to settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * Build the path of one office route.
 *
 * An office travels as a query parameter rather than as a path segment, because an office
 * name accepts any script and every office shares one route table.
 * @param verb - `state`, `post`, `hire`, or `dismiss`.
 * @param officeName - the office to act on.
 * @returns the request path.
 */
const officeRoute = (verb, officeName) => `/dsh-office/offices/${verb}?office=${encodeURIComponent(officeName)}`

const toolNames = (agent) => {
  assert.ok(agent, 'the agent must be live')
  return [...agent.tools.keys()].sort()
}

const checks = []
/**
 * Harnesses opened since the running check began. The probe's first harness is created
 * outside any check and stays mounted for the whole run; every harness a check opens is
 * closed when that check ends, so one check's offices never resolve another's roles.
 */
let openedHarnesses = []
const check = async (label, run) => {
  openedHarnesses = []
  try {
    await run()
  } finally {
    for (const close of openedHarnesses.reverse()) await close()
    openedHarnesses = []
  }
  checks.push(label)
}

// The host is a process singleton, so the checks that need a host of their own run before
// the shared one exists: each harness owns the singleton for its check, and the per-check
// disposal hands it back.
await check('office management refuses when the deployment exposes no patch', async () => {
  const bare = makeHarness(undefined, undefined, { host: true, profileContext: false })
  await bare.ready
  const refused = await callRoute(bare.routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'annex' },
  })
  assert.equal(refused.status, 503, 'no patch source means refuse, never guess')
  const refusedDelete = await callRoute(bare.routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'office' },
  })
  assert.equal(refusedDelete.status, 503)
})

await check('the panel answers while no office is mounted', async () => {
  const hostOnly = makeHarness(undefined, undefined, { host: true, office: false })
  await hostOnly.ready
  const discovered = await callRoute(hostOnly.routes, '/dsh-office/offices')
  assert.equal(discovered.status, 200, 'the registry route belongs to the host, not to an office')
  assert.deepEqual(discovered.payload.offices, [], 'and reports an empty registry rather than failing')

  await writeFile(PATCH_PATH, PATCH_SEED)
  const created = await callRoute(hostOnly.routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'first' },
  })
  assert.equal(created.status, 202, 'the first office can be created while none is mounted')

  // The row this package's own patch ships is identified by its bare id even when it carries
  // nothing but a disablement — the shape a user writes to turn the office off. Without
  // that, creating `office` again would mount a second storage unit for the same name.
  await writeFile(PATCH_PATH, '- id: office\n  disabled: true\n')
  const declared = await callRoute(hostOnly.routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'office' },
  })
  assert.equal(declared.status, 409, 'a nameless row still declares the office it names')
  await rm(PATCH_PATH, { force: true })
})

await check('an office alone arms nobody, because the host owns the tool set', async () => {
  const unhosted = makeHarness({ officeName: 'unhosted' })
  await unhosted.ready
  const unhostedBoss = unhosted.publish('session-unhosted-boss', { preset: 'office-boss' })
  assert.deepEqual(toolNames(unhostedBoss), [], 'an office row registers no tool of its own')
})

/**
 * The listing services the unadopted report needs on the shared harness: one live projected
 * title, one cold title the projection cache serves, and one session the workspace holds in its
 * archive set, which no form of the listing may offer.
 */
const harness = makeHarness(undefined, undefined, {
  host: true,
  titles: { 'session-titled': 'Titled session' },
  coldSessions: [{ id: 'session-cold', createdAt: 0 }, { id: 'session-archived', createdAt: 0 }],
  coldTitles: { 'session-cold': 'Cold session', 'session-archived': 'Archived session' },
  accountedIds: ['session-cold'],
  archivedSessionIds: ['session-archived'],
})
const { routes, liveAgents, titles, resumed, hires, selects, globalTools } = harness
await harness.ready

const boss = harness.publish('session-boss', { preset: 'office-boss' })
const outsider = harness.publish('session-outsider')
const alice = harness.publish('session-alice')
const bob = harness.publish('session-bob')
// A live session whose title is projected, for the unadopted report to show.
const titled = harness.publish('session-titled', { cwd: '/work/mine' })
void titled

await check('no office tool is ever registered globally', () => {
  assert.deepEqual([...globalTools.keys()], [], 'the office contributes nothing to the global tool layer')
})

await check('the boss holds the office complete tool set, the colleague only its role', () => {
  assert.deepEqual(toolNames(boss), [
    'office_adopt',
    'office_colleagues',
    'office_compact',
    'office_configure',
    'office_dismiss',
    'office_dm',
    'office_hire',
    'office_interrupt',
    'office_list',
    'office_post',
    'office_read',
    'office_rename',
    'office_roster',
  ])
  assert.deepEqual(toolNames(outsider), [], 'a session with no role holds nothing')
})

await check('a session with no office role gets no office tool', () => {
  assert.deepEqual(toolNames(outsider), [])
  assert.deepEqual(toolNames(alice), [], 'a colleague holds nothing until it is adopted')
})

await check('activation seeds #general and an empty roster', async () => {
  const roster = await callBoss(boss, 'office', 'office_roster', {})
  assert.deepEqual(roster.colleagues, [])
  assert.deepEqual(roster.channels.map(entry => entry.channelId), ['general', 'mailbox'], 'the office seeds the public channel and the user mailbox')
})

await check('adopting a live session installs the tools its role holds', async () => {
  titles.set('session-alice', 'Alice Smith')
  titles.set('session-bob', 'bob')
  await callBoss(boss, 'office', 'office_adopt', { session_id: 'session-alice', role: 'member' })
  await callBoss(boss, 'office', 'office_adopt', { session_id: 'session-bob' })
  assert.deepEqual(toolNames(alice), ['office_colleagues', 'office_dm', 'office_post', 'office_read'])
  assert.deepEqual(toolNames(bob), ['office_colleagues', 'office_dm', 'office_post', 'office_read'])
  assert.deepEqual(toolNames(outsider), [], 'adoption does not spread to other sessions')
  const roster = await callBoss(boss, 'office', 'office_roster', {})
  assert.deepEqual(roster.colleagues.map(entry => entry.name).sort(), ['Alice Smith', 'bob'])
})

await check('every installed tool declares schemas the providers accept', () => {
  for (const agent of [boss, alice, bob]) {
    for (const [name, tool] of agent.tools) {
      assert.deepEqual(parameterSchemaErrors(tool.parameters), [], `${name} parameter schema`)
      // The same malformation invalidates an output schema: it is the same JSON Schema
      // dialect, and the result is validated against it after every call.
      assert.deepEqual(
        parameterSchemaErrors(tool.output.schema, 'output.schema'),
        [],
        `${name} output schema`,
      )
    }
  }
})

await check('office is a required parameter for a boss and optional for a colleague', () => {
  const declaresOffice = (agent, name) => Object.keys(agent.tools.get(name).parameters.properties ?? {}).includes('office')
  const requiresOffice = (agent, name) => (agent.tools.get(name).parameters.required ?? []).includes('office')
  for (const name of toolNames(boss)) {
    if (!declaresOffice(boss, name)) continue
    assert.ok(requiresOffice(boss, name), `${name} must require office for a boss`)
  }
  for (const name of toolNames(alice)) {
    assert.ok(!requiresOffice(alice, name), `${name} must leave office optional for a colleague`)
  }
})

await check('renaming a session renames the colleague, with no office-side rename', async () => {
  titles.set('session-bob', 'Robert')
  const roster = await callBoss(boss, 'office', 'office_roster', {})
  assert.ok(roster.colleagues.some(entry => entry.name === 'Robert' && entry.sessionId === 'session-bob'))
  const addressed = await call(alice, 'office_dm', { to: 'Robert', text: 'addressed by the new title' })
  assert.equal(addressed.message.channelId, 'dm-sessionalice+sessionbob')
  assert.deepEqual(addressed.deliveries, [{ colleague: 'Robert', status: 'delivered' }])
  titles.set('session-bob', 'bob')
})

await check('an ambiguous session title fails loud instead of addressing one colleague', async () => {
  titles.set('session-alice', 'same')
  titles.set('session-bob', 'same')
  await assert.rejects(
    () => call(alice, 'office_post', { text: 'who?', mentions: ['same'] }),
    /matches 2 colleagues/,
  )
  titles.set('session-alice', 'Alice Smith')
  titles.set('session-bob', 'bob')
})

await check('office_post notifies the whole office by default and can be narrowed', async () => {
  const before = resumed.length
  const posted = await call(alice, 'office_post', { text: 'standup in 10' })
  assert.deepEqual(
    posted.deliveries,
    [{ colleague: 'bob', status: 'delivered' }],
    'a public post notifies the office without being asked to',
  )
  assert.equal(posted.message.channelId, 'general')
  assert.equal(resumed.length, before, 'a colleague that is already live is not resumed to be notified')
  const read = await call(alice, 'office_read', { channel: '#general' })
  assert.equal(read.messages.at(-1).text, 'standup in 10')
  assert.equal(read.messages.at(-1).senderName, 'Alice Smith', 'the sender is named by its session title')

  const quiet = await call(alice, 'office_post', { text: 'quiet notice', mention_all: false })
  assert.deepEqual(quiet.deliveries, [], 'mention_all:false posts without waking anyone')
  const unnamed = await call(alice, 'office_post', { text: 'also quiet', mentions: [] })
  assert.deepEqual(unnamed.deliveries, [], 'an explicit empty mentions list also wakes nobody')
  await assert.rejects(
    () => call(alice, 'office_post', { text: 'x', mention_all: 'yes' }),
    /mention_all must be a boolean/,
  )
})

await check('office_post with a mention cold-resumes the colleague and delivers a user turn', async () => {
  const before = bob.sent.length
  const posted = await call(alice, 'office_post', { text: 'please review the diff', mentions: ['bob'] })
  assert.deepEqual(posted.deliveries, [{ colleague: 'bob', status: 'delivered' }])
  assert.equal(bob.sent.length, before + 1)
  const { via, message } = bob.sent.at(-1)
  assert.equal(via, 'followup', 'an idle colleague is woken with a followup turn')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'office-message')
  assert.equal(message.source.messageId, posted.message.messageId)
  assert.match(message.content[0].text, /^\[office #general from Alice Smith/)
})

await check('a mention that matches no session title fails loud', async () => {
  await assert.rejects(
    () => call(alice, 'office_post', { text: 'hello', mentions: ['nobody'] }),
    /does not match any colleague's session title/,
  )
})

await check('a colleague that is mid-turn is handed one merged turn when it is idle again', async () => {
  const before = bob.sent.length
  bob.status = 'running'
  const dm = await call(alice, 'office_dm', { to: 'bob', text: 'private note' })
  assert.equal(dm.message.channelId, 'dm-sessionalice+sessionbob')
  assert.deepEqual(dm.deliveries, [{ colleague: 'bob', status: 'queued' }], 'a busy colleague is not interrupted')
  assert.equal(bob.sent.length, before, 'and nothing is spliced into the turn it is running')

  const second = await call(alice, 'office_post', { text: 'public note, same burst', mentions: ['bob'] })
  assert.deepEqual(second.deliveries, [{ colleague: 'bob', status: 'queued' }])

  await harness.setStatus('session-bob', 'idle')
  assert.equal(bob.sent.length, before + 1, 'everything held is delivered as one turn, not one turn per message')
  const { via, message } = bob.sent.at(-1)
  assert.equal(via, 'followup')
  assert.equal(message.source.batch, 2)
  const text = message.content[0].text
  assert.match(text, /^\[office office \| 2 messages arrived while you were working\]/)
  const frames = text.split('\n').filter(line => line.startsWith('[office ') && line.includes(' from '))
  assert.equal(frames.length, 2, 'each held message keeps its own header inside the one turn')
  assert.match(frames[0], /^\[office DM from Alice Smith \| dm-sessionalice\+sessionbob-\d+\]$/)
  assert.match(frames[1], /^\[office #general from Alice Smith \| general-\d+\]$/)
  assert.match(text, /private note/)
  assert.match(text, /public note, same burst/)
  assert.match(text, /These arrived while your previous turn was running\./)

  const read = await call(alice, 'office_read', { channel: 'bob' })
  assert.equal(read.channelId, 'dm-sessionalice+sessionbob')
  assert.equal(read.messages.at(-1).text, 'private note')
})

await check('office_dm notify:step-end steers into the running turn, and the claim releases the hold', async () => {
  const steering = makeHarness({ officeName: 'steering' })
  await steering.ready
  const chief = steering.publish('session-steering-boss', { preset: 'office-boss' })
  steering.titles.set('session-steering-boss', 'chief')
  steering.titles.set('session-nina', 'nina')
  const nina = steering.publish('session-nina')
  await callBoss(chief, 'steering', 'office_adopt', { session_id: 'session-nina' })

  nina.status = 'running'
  const steered = await callBoss(chief, 'steering', 'office_dm', {
    to: 'nina',
    text: 'stop: wrong branch',
    notify: 'step-end',
  })
  assert.equal(steered.deliveries[0].status, 'steered', 'a step-end wake reports the splice, not a hold')
  assert.equal(nina.sent.length, 1)
  assert.equal(nina.sent[0].via, 'steer', 'the message enters the running turn at its next step boundary')
  assert.match(nina.sent[0].message.content[0].text, /stop: wrong branch/)
  assert.equal(nina.inbox.nextStep.length, 1, 'and the inbox carries it until a step claims it')

  // The claim is where the wake stops being pending, so the office stops holding it there.
  const pendingBefore = await callBoss(chief, 'steering', 'office_colleagues')
  assert.equal(pendingBefore.colleagues[0].pending, 1, 'the office holds it while the turn has not taken it')
  steering.claim('session-nina')
  await settle()
  const pendingAfter = await callBoss(chief, 'steering', 'office_colleagues')
  assert.equal(pendingAfter.colleagues[0].pending, 0, 'a claimed wake is no longer held')
  assert.equal(storedMessage(steering, steered.message.messageId).deliveries['session-nina'].status, 'steered')

  await steering.setStatus('session-nina', 'idle')
  assert.equal(nina.sent.length, 1, 'a wake the running turn took is not handed over a second time')

  // An idle colleague has no turn to steer, so the timing has nothing to choose between.
  const idleDm = await callBoss(chief, 'steering', 'office_dm', {
    to: 'nina',
    text: 'no turn to steer',
    notify: 'step-end',
  })
  assert.equal(idleDm.deliveries[0].status, 'delivered')
  assert.equal(nina.sent.at(-1).via, 'followup', 'an idle colleague is handed the message now either way')

  await assert.rejects(
    () => callBoss(chief, 'steering', 'office_dm', { to: 'nina', text: 'x', notify: 'turn' }),
    /notify must be one of turn-end, step-end/,
  )
})

await check('a step-end wake the running turn never took is recovered as the office\'s own turn', async () => {
  const recovering = makeHarness({ officeName: 'recovering' })
  await recovering.ready
  const chief = recovering.publish('session-recovering-boss', { preset: 'office-boss' })
  recovering.titles.set('session-recovering-boss', 'chief')
  recovering.titles.set('session-otto', 'otto')
  const otto = recovering.publish('session-otto')
  await callBoss(chief, 'recovering', 'office_adopt', { session_id: 'session-otto' })

  // The turn ends before it reaches another step, so the message is still pending input.
  otto.status = 'running'
  const stranded = await callBoss(chief, 'recovering', 'office_dm', {
    to: 'otto',
    text: 'this one waited',
    notify: 'step-end',
  })
  assert.equal(stranded.deliveries[0].status, 'steered')
  await recovering.setStatus('session-otto', 'idle')
  const recovered = otto.sent.at(-1)
  assert.equal(recovered.via, 'followup', 'the office hands the stranded wake over as its own turn')
  assert.equal(recovered.message.source.messageId, stranded.message.messageId)
  assert.equal(otto.inbox.nextStep.length, 0, 'and takes the inbox copy back, so no step delivers it twice')
  const record = storedMessage(recovering, stranded.message.messageId).deliveries['session-otto']
  assert.equal(record.status, 'delivered', 'the outcome is what the colleague actually got')
  assert.match(record.detail, /the running turn ended before it took this step-end wake/)

  // A cancellation that does not keep the inbox throws the pending copy away with no claim, so
  // the message is nowhere but in the office's hold — which is what that hold is for.
  otto.status = 'running'
  const discarded = await callBoss(chief, 'recovering', 'office_dm', {
    to: 'otto',
    text: 'cancelled away',
    notify: 'step-end',
  })
  assert.equal(discarded.deliveries[0].status, 'steered')
  recovering.discardInbox('session-otto')
  await recovering.setStatus('session-otto', 'idle')
  assert.equal(otto.sent.at(-1).via, 'followup')
  assert.match(otto.sent.at(-1).message.content[0].text, /cancelled away/, 'a discarded wake is not lost')
})

await check('a step-end wake held when the process stops is recovered after it restarts', async () => {
  const stopping = makeHarness({ officeName: 'stepping' }, undefined, { rowId: 'office_stepping' })
  await stopping.ready
  const chief = stopping.publish('session-stepping-boss', { preset: 'office-boss' })
  stopping.titles.set('session-stepping-boss', 'chief')
  stopping.titles.set('session-otto', 'otto')
  const otto = stopping.publish('session-otto')
  await callBoss(chief, 'stepping', 'office_adopt', { session_id: 'session-otto' })

  otto.status = 'running'
  const steered = await callBoss(chief, 'stepping', 'office_dm', {
    to: 'otto',
    text: 'before you go',
    notify: 'step-end',
  })
  assert.equal(steered.deliveries[0].status, 'steered')

  // The process stops with the message unclaimed in the colleague's inbox, which the restart
  // reattaches: the wake is the office's again and must arrive exactly once.
  stopping.dispose(otto)
  await stopping.close()
  stopping.ctx.fiber.entry.options.id = 'office_stepping'
  await apply(stopping.ctx, { officeName: 'stepping' })
  await settle()

  const restarted = stopping.liveAgents.get('session-otto')
  assert.equal(restarted.sent.length, 1, 'the unclaimed step-end wake is delivered by the restarted office')
  assert.equal(restarted.sent[0].via, 'followup')
  assert.match(restarted.sent[0].message.content[0].text, /before you go/)
  assert.equal(restarted.inbox.nextStep.length, 0, 'and the inbox copy it carried does not arrive twice')
})

await check('a wake held when the process stops is delivered after it restarts', async () => {
  const stopping = makeHarness({ officeName: 'stopping' }, undefined, { rowId: 'office_stopping' })
  await stopping.ready
  const chief = stopping.publish('session-stopping-boss', { preset: 'office-boss' })
  stopping.titles.set('session-stopping-boss', 'chief')
  stopping.titles.set('session-ivy', 'ivy')
  const ivy = stopping.publish('session-ivy')
  await callBoss(chief, 'stopping', 'office_adopt', { session_id: 'session-ivy' })

  ivy.status = 'running'
  const posted = await callBoss(chief, 'stopping', 'office_post', { text: 'ivy, please take this', mentions: ['ivy'] })
  assert.deepEqual(posted.deliveries, [{ colleague: 'ivy', status: 'queued' }])
  assert.equal(ivy.sent.length, 0)

  // The process stops with the wake held: no agent is live any more, and a wake that was
  // promised must not evaporate because the office happened to be restarting.
  stopping.dispose(ivy)
  await stopping.close()
  stopping.ctx.fiber.entry.options.id = 'office_stopping'
  await apply(stopping.ctx, { officeName: 'stopping' })
  await new Promise(resolve => setTimeout(resolve, 0))

  const restarted = stopping.liveAgents.get('session-ivy')
  assert.equal(restarted.sent.length, 1, 'the held wake is delivered by the restarted office')
  assert.match(restarted.sent[0].message.content[0].text, /ivy, please take this/)
})

await check('a dismissed colleague does not leave the office holding its wake', async () => {
  const leaving = makeHarness({ officeName: 'leaving' }, undefined, { rowId: 'office_leaving' })
  await leaving.ready
  const chief = leaving.publish('session-leaving-boss', { preset: 'office-boss' })
  leaving.titles.set('session-leaving-boss', 'chief')
  leaving.titles.set('session-dana', 'dana')
  const dana = leaving.publish('session-dana')
  await callBoss(chief, 'leaving', 'office_adopt', { session_id: 'session-dana' })

  dana.status = 'running'
  const posted = await callBoss(chief, 'leaving', 'office_post', { text: 'dana, before you go', mentions: ['dana'] })
  assert.deepEqual(posted.deliveries, [{ colleague: 'dana', status: 'queued' }])
  await callBoss(chief, 'leaving', 'office_dismiss', { name: 'dana' })

  await leaving.setStatus('session-dana', 'idle')
  assert.equal(dana.sent.length, 0, 'a dismissed colleague is not woken for what was held for it')

  // And nothing is left behind for a later process to deliver either.
  await leaving.close()
  leaving.ctx.fiber.entry.options.id = 'office_leaving'
  await apply(leaving.ctx, { officeName: 'leaving' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(dana.sent.length, 0, 'the held wake went with the roster entry')
})

await check('a cold resume runs on the route the session itself last logged', async () => {
  const withLog = makeHarness({ officeName: 'resume' }, { provider: 'logged-provider', model: 'logged-model', reasoningEffort: 'high' })
  await withLog.ready
  const withBoss = withLog.publish('session-boss', { preset: 'office-boss' })
  withLog.titles.set('session-gina', 'gina')
  await callBoss(withBoss, 'resume', 'office_adopt', { session_id: 'session-gina' })
  const poster = withLog.publish('session-poster')
  withLog.titles.set('session-poster', 'poster')
  await callBoss(withBoss, 'resume', 'office_adopt', { session_id: 'session-poster' })
  const posted = await call(poster, 'office_dm', { to: 'gina', text: 'resume on your own route' })
  assert.deepEqual(posted.deliveries, [{ colleague: 'gina', status: 'delivered' }])
  assert.deepEqual(withLog.resumed[0].agentOptions, {
    provider: 'logged-provider',
    model: 'logged-model',
    reasoningEffort: 'high',
  })
})

await check('no burst is ever refused: every message that names a colleague wakes it', async () => {
  const burst = makeHarness({ officeName: 'burst' })
  await burst.ready
  const burstBoss = burst.publish('session-boss', { preset: 'office-boss' })
  burst.titles.set('session-poster', 'poster')
  burst.titles.set('session-dave', 'dave')
  const poster = burst.publish('session-poster')
  const dave = burst.publish('session-dave')
  await callBoss(burstBoss, 'burst', 'office_adopt', { session_id: 'session-poster' })
  await callBoss(burstBoss, 'burst', 'office_adopt', { session_id: 'session-dave' })
  const statuses = []
  for (let round = 0; round < 6; round++) {
    const posted = await call(poster, 'office_post', { text: `ping ${round}`, mentions: ['dave'] })
    statuses.push(posted.deliveries[0].status)
  }
  assert.deepEqual(statuses, Array.from({ length: 6 }, () => 'delivered'), 'a burst is delivered, not throttled')
  assert.equal(dave.sent.length, 6, 'each wake is its own queued turn')
})

await check('a colleague cascade is not truncated', async () => {
  const chained = makeHarness({ officeName: 'chained' })
  await chained.ready
  const chainedBoss = chained.publish('session-boss', { preset: 'office-boss' })
  chained.titles.set('session-user', 'user')
  chained.titles.set('session-eve', 'eve')
  chained.titles.set('session-frank', 'frank')
  const user = chained.publish('session-user')
  for (const sessionId of ['session-user', 'session-eve', 'session-frank']) {
    await callBoss(chainedBoss, 'chained', 'office_adopt', { session_id: sessionId })
  }
  const first = await call(user, 'office_post', { text: 'kick off', mentions: ['eve'] })
  assert.deepEqual(first.deliveries, [{ colleague: 'eve', status: 'delivered' }])
  const eve = chained.liveAgents.get('session-eve')
  const second = await call(eve, 'office_post', { text: 'your turn', mentions: ['frank'] })
  assert.deepEqual(second.deliveries, [{ colleague: 'frank', status: 'delivered' }])
  const frank = chained.liveAgents.get('session-frank')
  const third = await call(frank, 'office_post', { text: 'back to you', mentions: ['eve'] })
  assert.deepEqual(
    third.deliveries,
    [{ colleague: 'eve', status: 'delivered' }],
    'a colleague-to-colleague hand-off keeps working however long the exchange runs',
  )
  assert.equal(eve.sent.length, 2, 'and every hand-off reached its recipient')
})

await check('wakesEnabled:false records the message without any delivery', async () => {
  const muted = makeHarness({ officeName: 'muted', wakesEnabled: false })
  await muted.ready
  const mutedBoss = muted.publish('session-boss', { preset: 'office-boss' })
  muted.titles.set('session-poster', 'poster')
  muted.titles.set('session-carol', 'carol')
  const poster = muted.publish('session-poster')
  await callBoss(mutedBoss, 'muted', 'office_adopt', { session_id: 'session-poster' })
  await callBoss(mutedBoss, 'muted', 'office_adopt', { session_id: 'session-carol' })
  const posted = await call(poster, 'office_post', { text: 'quiet', mentions: ['carol'] })
  assert.deepEqual(posted.deliveries, [{ colleague: 'carol', status: 'wakes-disabled' }])
  assert.equal(muted.resumed.length, 0)
})

await check('office_hire creates a session, titles it, adopts it, and arms it', async () => {
  const hired = await callBoss(boss, 'office', 'office_hire', { name: 'New Hire', role: 'leader' })
  assert.deepEqual(hired.colleague, {
    name: 'New Hire',
    sessionId: 'session-hired-1',
    role: 'leader',
  })
  assert.equal(hired.workspaceId, 'workspace-first', 'a caller without a cwd falls back to the first workspace')
  assert.equal(titles.get('session-hired-1'), 'New Hire', 'the colleague name IS the session title')
  assert.deepEqual(
    toolNames(liveAgents.get('session-hired-1')),
    ['office_colleagues', 'office_compact', 'office_configure', 'office_dm', 'office_interrupt', 'office_post', 'office_read'],
    'the new colleague is armed with exactly the tools its role holds, in the same activation',
  )
  await assert.rejects(
    () => callBoss(boss, 'office', 'office_hire', { name: 'Unnamed Role', role: 'engineer' }),
    /role must be one of member, leader, consultant/,
    'a role nobody predefined is refused before a session is created for it',
  )
  assert.equal(hires.length, 1, 'and no session was created for it')
})

await check('hiring greets the new colleague privately, and that greeting makes it visible', async () => {
  // The Web workspace tree hides a session that has taken no turn, so a hire that only
  // created a session would leave the colleague invisible in the workspace until someone
  // happened to message it. The greeting is the turn that clears that state, and it is a
  // private turn: the office's public history stays a record of work, not of arrivals.
  const hired = await callBoss(boss, 'office', 'office_hire', { name: 'Greeted', role: 'member' })
  assert.equal(hired.greeting, 'delivered', 'the hire reports the greeting outcome rather than hiding it')
  const greeted = liveAgents.get(hired.colleague.sessionId)
  assert.equal(greeted.sent.length, 1, 'the greeting is the new colleague first turn')
  const text = greeted.sent[0].message.content[0].text
  assert.match(text, /^\[office office \| you were hired\]/, 'it is framed as an onboarding note, not as a channel post')
  assert.match(text, /You are "Greeted", a colleague of the office "office"/, 'the greeting states who it is')
  assert.match(text, /Your role: member\./)
  assert.match(text, /office_post posts important information to #general/, 'and what it can do')
  assert.match(text, /nothing here was posted to a channel/)
  assert.equal(greeted.sent[0].message.source.channelId, 'office-onboarding')
  const feed = await callBoss(boss, 'office', 'office_read', { channel: '#general' })
  assert.ok(
    !feed.messages.some(entry => entry.text.includes('You are "Greeted"')),
    'the greeting never reaches the public channel',
  )

  const muted = makeHarness({ officeName: 'mutedhire', wakesEnabled: false })
  await muted.ready
  const mutedBoss = muted.publish('session-muted-boss', { preset: 'office-boss' })
  const quiet = await callBoss(mutedBoss, 'mutedhire', 'office_hire', { name: 'Unwoken' })
  assert.equal(quiet.greeting, 'wakes-disabled', 'with wakes off the greeting is not delivered, and the report says why')
})

await check('a colleague whose title has no ASCII form is still addressable by name', async () => {
  const named = makeHarness({ officeName: 'namedcn' }, undefined, { rowId: 'office_namedcn' })
  await named.ready
  const namedBoss = named.publish('session-named-cn-boss', { preset: 'office-boss' })
  named.titles.set('session-zhang', '张三')
  const member = named.publish('session-zhang')
  await callBoss(namedBoss, 'namedcn', 'office_adopt', { session_id: 'session-zhang' })
  assert.equal(
    (await call(member, 'office_dm', { to: '张三', text: '到' })).deliveries[0].colleague,
    '张三',
    'a title that is entirely non-ASCII still resolves, which a slug normalization would erase',
  )
  const mentioned = await callBoss(namedBoss, 'namedcn', 'office_post', { text: '@张三 请报到', mentions: ['张三'] })
  assert.deepEqual(mentioned.deliveries, [{ colleague: '张三', status: 'delivered' }])
  await assert.rejects(
    () => callBoss(namedBoss, 'namedcn', 'office_post', { text: 'x', mentions: ['张'] }),
    /"张" does not match any colleague/,
  )
})

await check('office_hire prefers the caller workspace over the registry order', async () => {
  const roaming = harness.publish('session-roaming-boss', { preset: 'office-boss', cwd: '/work/mine' })
  const hired = await callBoss(roaming, 'office', 'office_hire', { name: 'Second Hire' })
  assert.equal(hired.workspaceId, 'workspace-own', "the caller's own workspace wins")
  const pinned = await callBoss(roaming, 'office', 'office_hire', { name: 'Third Hire', workspace_id: 'workspace-first' })
  assert.equal(pinned.workspaceId, 'workspace-first', 'an explicit workspace_id still wins')
  assert.deepEqual(
    hires.slice(-3).map(entry => entry.workspaceId),
    ['workspace-first', 'workspace-own', 'workspace-first'],
  )
})

await check('office_hire passes the agent preset and model route through', async () => {
  const fresh = makeHarness({ officeName: 'fresh' })
  await fresh.ready
  const freshBoss = fresh.publish('session-boss', { preset: 'office-boss' })
  const hired = await callBoss(freshBoss, 'fresh', 'office_hire', {
    name: 'Specialist',
    agent_preset: 'standard',
    provider: 'probe',
    model: 'probe-model',
    reasoning_effort: 'high',
  })
  assert.equal(hired.agentPreset, 'standard')
  assert.deepEqual(fresh.hires, [{ workspaceId: 'workspace-first', agentPreset: 'standard' }])
  assert.deepEqual(fresh.selects, [{
    sessionId: 'session-hired-1',
    provider: 'probe',
    model: 'probe-model',
    reasoningEffort: 'high',
  }])
  await assert.rejects(
    () => callBoss(freshBoss, 'fresh', 'office_hire', { name: 'Incomplete', provider: 'probe' }),
    /needs both provider and model/,
  )
  // Hiring creates the session before it titles it, so a name that cannot be a title has to be
  // refused before that: otherwise the call fails leaving a session nobody asked for.
  const before = fresh.hires.length
  await assert.rejects(
    () => callBoss(freshBoss, 'fresh', 'office_hire', {}),
    /office_hire: name must be a non-empty session title/,
  )
  assert.equal(fresh.hires.length, before, 'and no session was created on the way to that failure')
})

await check('a broadcast wakes every colleague except the sender', async () => {
  const roster = (await callBoss(boss, 'office', 'office_roster', {})).colleagues
  const all = await call(alice, 'office_post', { text: 'all hands', mention_all: true })
  assert.deepEqual(
    all.deliveries.map(entry => entry.colleague).sort(),
    roster.map(entry => entry.name).filter(name => name !== 'Alice Smith').sort(),
    'every colleague except the sender is addressed',
  )
  assert.ok(all.deliveries.every(entry => entry.status === 'delivered'))
})

await check('the delivery frame states where a reply does and does not surface', async () => {
  await call(alice, 'office_dm', { to: 'bob', text: 'private note' })
  const dmText = bob.sent.at(-1).message.content[0].text
  assert.match(dmText, /Your reply stays in this session and reaches nobody/)
  assert.match(dmText, /Most messages need no answer, and silence is a normal one/)
  assert.ok(!dmText.includes('a public post wakes every colleague'), 'a private message must not invite a public reply')
  await call(alice, 'office_post', { text: 'public note', mentions: ['bob'] })
  const publicText = bob.sent.at(-1).message.content[0].text
  assert.match(publicText, /Post important information to #general so everyone can learn from it/)
  assert.match(
    publicText,
    /Never post to acknowledge a message, to agree with it, or to say that you are working on it/,
    'a wake states the rule that keeps one post from waking the office again',
  )
})

await check('the panel routes read state and post to the public channel', async () => {
  const state = await callRoute(routes, officeRoute('state', 'office'))
  assert.equal(state.status, 200)
  assert.ok(state.payload.colleagues.some(entry => entry.name === 'New Hire'))
  assert.deepEqual(state.payload.workspaces, [
    { id: 'workspace-first', title: 'First' },
    { id: 'workspace-own', title: 'Own' },
  ])
  assert.deepEqual(state.payload.presets, [{ id: 'standard', name: 'Standard' }], 'a broken preset is not offered')
  assert.deepEqual(state.payload.models, [{ provider: 'probe', model: 'probe-model', name: 'Probe / Probe Model' }])

  const posted = await callRoute(routes, officeRoute('post', 'office'), {
    method: 'POST',
    body: { text: 'from the panel' },
  })
  assert.equal(posted.status, 200)
  assert.ok(posted.payload.deliveries.length > 0, 'a panel post notifies the office by default')
  assert.deepEqual(
    posted.payload.deliveries.filter(entry => entry.status !== 'delivered'),
    [],
    'and every notified colleague received it',
  )
  const after = await callRoute(routes, officeRoute('state', 'office'))
  assert.equal(after.payload.messages.at(-1).senderName, 'user')
})

await check('the panel can hire, and can post without waking anyone', async () => {
  const hired = await callRoute(routes, officeRoute('hire', 'office'), {
    method: 'POST',
    body: { name: 'Panel Hire', agent_preset: 'standard' },
  })
  assert.equal(hired.status, 200)
  assert.equal(hired.payload.colleague.name, 'Panel Hire')
  assert.equal(hires.at(-1).agentPreset, 'standard')
  assert.deepEqual(
    toolNames(liveAgents.get(hired.payload.colleague.sessionId)),
    ['office_colleagues', 'office_dm', 'office_post', 'office_read'],
  )

  const quiet = await callRoute(routes, officeRoute('post', 'office'), {
    method: 'POST',
    body: { text: 'all hands from the panel', mention_all: false },
  })
  assert.equal(quiet.status, 200)
  assert.deepEqual(
    quiet.payload.deliveries,
    [],
    'unchecking Wake everyone notifies only the colleagues the text names, and this text names none',
  )
})

await check('a panel post with Wake everyone unchecked notifies exactly the colleagues its text names', async () => {
  const hall = makeHarness({ officeName: 'hall' }, undefined, { rowId: 'office_hall' })
  await hall.ready
  const hallBoss = hall.publish('session-hall-boss', { preset: 'office-boss' })
  hall.titles.set('session-long', 'Alice Smith')
  hall.titles.set('session-short', 'Alice')
  hall.publish('session-long')
  hall.publish('session-short')
  await callBoss(hallBoss, 'hall', 'office_adopt', { session_id: 'session-long' })
  await callBoss(hallBoss, 'hall', 'office_adopt', { session_id: 'session-short' })

  const post = (text, extra = {}) => callRoute(routes, officeRoute('post', 'hall'), {
    method: 'POST',
    body: { text, mention_all: false, ...extra },
  })
  assert.deepEqual(
    (await post('@Alice Smith 请报到')).payload.deliveries,
    [{ colleague: 'Alice Smith', status: 'delivered' }],
    'the longest name wins, so a title containing a space matches whole',
  )
  assert.deepEqual((await post('@Alice 你好')).payload.deliveries, [{ colleague: 'Alice', status: 'delivered' }])
  assert.deepEqual((await post('no name here')).payload.deliveries, [], 'a post that names nobody wakes nobody')
  assert.deepEqual(
    (await post('mail me at x@Alice later')).payload.deliveries,
    [],
    'a trigger that is not at a word start is an address, not a mention',
  )
  assert.deepEqual((await post('@Alicex hello')).payload.deliveries, [], 'a longer word is prose, not a mention')
  assert.deepEqual(
    (await post('@Alice Smith and @Alice')).payload.deliveries.map(entry => entry.colleague).sort(),
    ['Alice', 'Alice Smith'],
    'both mentions wake, once each',
  )
  assert.deepEqual(
    (await callRoute(routes, officeRoute('post', 'hall'), { method: 'POST', body: { text: 'everyone?' } }))
      .payload.deliveries.map(entry => entry.colleague).sort(),
    ['Alice', 'Alice Smith'],
    'a request that omits mention_all notifies the whole roster, which is what the panel sends by default',
  )

  // The panel colors what the server resolved rather than its own guess, so the feed cannot
  // show a mention that woke nobody.
  const state = await callRoute(routes, officeRoute('state', 'hall'))
  assert.deepEqual(
    state.payload.messages.find(message => message.text === '@Alice Smith 请报到').mentions,
    ['Alice Smith'],
  )
  assert.deepEqual(state.payload.messages.find(message => message.text === 'no name here').mentions, [])
})

await check('the panel routes refuse an untrusted request before doing any work', async () => {
  const refused = await callRoute(routes, officeRoute('state', 'office'), { headers: { 'x-test-refuse': 'yes' } })
  assert.equal(refused.status, 403)
  const refusedPost = await callRoute(routes, officeRoute('post', 'office'), {
    method: 'POST',
    headers: { 'x-test-refuse': 'yes' },
    body: { text: 'should not land' },
  })
  assert.equal(refusedPost.status, 403)
  const state = await callRoute(routes, officeRoute('state', 'office'))
  assert.ok(!state.payload.messages.some(message => message.text === 'should not land'))
})

await check('a panel route naming an unmounted office is a clean 404', async () => {
  const missing = await callRoute(routes, officeRoute('state', 'nowhere'))
  assert.equal(missing.status, 404)
  assert.match(missing.payload.error, /no office "nowhere" is mounted/)
  const noParameter = await callRoute(routes, '/dsh-office/offices/state')
  assert.equal(noParameter.status, 404, 'a request that names no office resolves to none')
})

await check('a disposed agent loses its office tools', async () => {
  const temp = harness.publish('session-temp')
  harness.titles.set('session-temp', 'temp')
  await callBoss(boss, 'office', 'office_adopt', { session_id: 'session-temp' })
  assert.equal(temp.tools.size, 4)
  harness.dispose(temp)
  assert.equal(temp.tools.size, 0, 'the scoped registrations unwind with the agent')
})

await check('office_dismiss removes a colleague and withdraws its channel tools', async () => {
  const temp = harness.publish('session-temp')
  harness.titles.set('session-temp', 'temp')
  await callBoss(boss, 'office', 'office_adopt', { session_id: 'session-temp' })
  assert.equal(temp.tools.size, 4, 'adoption arms the session')
  const dismissed = await callBoss(boss, 'office', 'office_dismiss', { name: 'temp' })
  assert.deepEqual(dismissed.colleague, { name: 'temp', sessionId: 'session-temp' })
  assert.equal(temp.tools.size, 0, 'the channel tools withdraw from the live session')
  const roster = await callBoss(boss, 'office', 'office_roster', {})
  assert.ok(!roster.colleagues.some(entry => entry.sessionId === 'session-temp'))
  await assert.rejects(() => callBoss(boss, 'office', 'office_dismiss', { name: 'temp' }), /does not match any colleague/)
})

await check('a dismissed session is no longer an addressable colleague', async () => {
  await assert.rejects(
    () => call(alice, 'office_dm', { to: 'temp', text: 'still there?' }),
    /does not match any colleague's session title/,
  )
})

await check('officeName makes a fully independent office behind one shared tool set', async () => {
  const studio = makeHarness({ officeName: 'studio' })
  await studio.ready
  const studioBoss = studio.publish('session-studio-boss', { preset: 'office-boss' })
  assert.deepEqual(
    toolNames(studioBoss),
    toolNames(boss),
    'the tool names are office-independent: the office is an argument, not part of the name',
  )
  const studioState = await callRoute(routes, officeRoute('state', 'studio'))
  assert.equal(studioState.status, 200, 'one route table serves every office')
  assert.equal(studioState.payload.office, 'studio')
  assert.equal(studioState.payload.officeId, 'office_studio', 'the storage key is the office row id')
  studio.titles.set('session-member', 'member')
  const member = studio.publish('session-member')
  await callBoss(studioBoss, 'studio', 'office_adopt', { session_id: 'session-member' })
  assert.deepEqual(
    toolNames(member),
    ['office_colleagues', 'office_dm', 'office_post', 'office_read'],
  )
  const roster = await callBoss(studioBoss, 'studio', 'office_roster', {})
  assert.deepEqual(roster.channels.map(entry => entry.channelId), ['general', 'mailbox'], 'the office seeds the public channel and the user mailbox')
  assert.deepEqual(roster.colleagues.map(entry => entry.name), ['member'])

  const discovered = await callRoute(routes, '/dsh-office/offices')
  assert.equal(discovered.status, 200)
  const names = discovered.payload.offices.map(office => office.name).sort()
  assert.deepEqual(names, ['office', 'studio'], 'both mounted offices appear in one list')
  const refused = await callRoute(routes, '/dsh-office/offices', { headers: { 'x-test-refuse': 'yes' } })
  assert.equal(refused.status, 403, 'discovery is behind the same connection policy')
})

await check('one shared boss preset gives a boss every office it supervises', async () => {
  const alpha = makeHarness({ officeName: 'alpha' })
  const beta = makeHarness({ officeName: 'beta' })
  await alpha.ready
  await beta.ready
  const commander = makeAgent('session-commander', 'idle', undefined, 'office-boss')
  alpha.adoptAgent(commander)
  beta.adoptAgent(commander)
  assert.deepEqual(
    toolNames(commander),
    toolNames(boss),
    'a boss running two offices holds one constant set, not one per office',
  )
  const listed = await call(commander, 'office_list', {})
  const listedNames = listed.offices.map(entry => entry.office)
  assert.ok(
    listedNames.includes('alpha') && listedNames.includes('beta'),
    'office_list reports every office the boss runs, including the ones mounted by another instance',
  )

  await callBoss(commander, 'alpha', 'office_post', { text: 'in alpha' })
  await callBoss(commander, 'beta', 'office_post', { text: 'in beta' })
  const alphaFeed = await callBoss(commander, 'alpha', 'office_read', { channel: '#general' })
  const betaFeed = await callBoss(commander, 'beta', 'office_read', { channel: '#general' })
  assert.equal(alphaFeed.messages.at(-1).text, 'in alpha')
  assert.equal(betaFeed.messages.at(-1).text, 'in beta')
  assert.ok(!alphaFeed.messages.some(entry => entry.text === 'in beta'), 'the offices never share a channel')
  assert.match(alphaFeed.office, /^alpha$/, 'each result names the office it came from')

  alpha.titles.set('session-a', 'a')
  await callBoss(commander, 'alpha', 'office_adopt', { session_id: 'session-a' })
  assert.ok((await callBoss(commander, 'alpha', 'office_roster', {})).colleagues.some(entry => entry.name === 'a'))
  assert.ok(!(await callBoss(commander, 'beta', 'office_roster', {})).colleagues.some(entry => entry.name === 'a'))
})

await check('a boss must name an office it runs', async () => {
  const alpha = makeHarness({ officeName: 'alpha' })
  const beta = makeHarness({ officeName: 'beta' })
  await alpha.ready
  await beta.ready
  const commander = makeAgent('session-commander', 'idle', undefined, 'office-boss')
  alpha.adoptAgent(commander)
  beta.adoptAgent(commander)

  await assert.rejects(
    () => call(commander, 'office_roster', {}),
    /office is required; this session runs/,
    'a boss that omits the office is refused, because it may run several',
  )
  await assert.rejects(
    () => call(commander, 'office_roster', { office: 'gamma' }),
    /"gamma" is not an office this session acts on/,
    'a boss may not name an office it does not run',
  )
  assert.equal((await call(commander, 'office_roster', { office: 'alpha' })).office, 'alpha')
  assert.equal((await call(commander, 'office_roster', { office: 'beta' })).office, 'beta')
})

await check('a colleague is routed to the office that adopted it', async () => {
  const alpha = makeHarness({ officeName: 'alpha' })
  const beta = makeHarness({ officeName: 'beta' })
  await alpha.ready
  await beta.ready
  const alphaBoss = alpha.publish('session-alpha-boss', { preset: 'office-boss' })
  alpha.titles.set('session-member', 'member')
  const member = alpha.publish('session-member')
  await callBoss(alphaBoss, 'alpha', 'office_adopt', { session_id: 'session-member' })

  const posted = await call(member, 'office_post', { text: 'hello from the member' })
  assert.equal(posted.office, 'alpha', 'the colleague is routed without naming an office')
  const feed = await callBoss(alphaBoss, 'alpha', 'office_read', { channel: '#general' })
  assert.ok(feed.messages.some(entry => entry.text === 'hello from the member'))

  const explicit = await call(member, 'office_post', { office: 'alpha', text: 'names its own office' })
  assert.equal(explicit.office, 'alpha', 'naming its own office is accepted')
  await assert.rejects(
    () => call(member, 'office_post', { office: 'beta', text: 'leak' }),
    /"beta" is not an office this session acts on/,
    'a colleague may not address an office it does not belong to',
  )
  const betaFeed = await callBoss(alphaBoss, 'beta', 'office_read', { channel: '#general' })
  assert.deepEqual(betaFeed.messages, [], 'nothing the member posted reached beta')
})

await check('a colleague held by two offices chooses with the office argument', async () => {
  const alpha = makeHarness({ officeName: 'alpha' })
  const beta = makeHarness({ officeName: 'beta' })
  await alpha.ready
  await beta.ready
  const alphaBoss = alpha.publish('session-alpha-boss', { preset: 'office-boss' })
  const betaBoss = beta.publish('session-beta-boss', { preset: 'office-boss' })
  alpha.titles.set('session-dual', 'dual')
  beta.titles.set('session-dual', 'dual')
  const dual = alpha.publish('session-dual')
  beta.adoptAgent(dual)
  await callBoss(alphaBoss, 'alpha', 'office_adopt', { session_id: 'session-dual' })
  await callBoss(betaBoss, 'beta', 'office_adopt', { session_id: 'session-dual' })

  await assert.rejects(
    () => call(dual, 'office_post', { text: 'ambiguous' }),
    /belongs to 2 offices — pass office to choose one of/,
    'an ambiguous colleague is refused rather than routed to an arbitrary office',
  )
  assert.equal((await call(dual, 'office_post', { office: 'beta', text: 'to beta' })).office, 'beta')
  const betaFeed = await callBoss(betaBoss, 'beta', 'office_read', { channel: '#general' })
  assert.ok(betaFeed.messages.some(entry => entry.text === 'to beta'))
  const alphaFeed = await callBoss(alphaBoss, 'alpha', 'office_read', { channel: '#general' })
  assert.ok(!alphaFeed.messages.some(entry => entry.text === 'to beta'), 'the chosen office is the only one written to')
})

await check('unmounting one office leaves the other office tools intact', async () => {
  const alpha = makeHarness({ officeName: 'alpha' })
  const beta = makeHarness({ officeName: 'beta' })
  await alpha.ready
  await beta.ready
  const commander = makeAgent('session-commander', 'idle', undefined, 'office-boss')
  alpha.adoptAgent(commander)
  beta.adoptAgent(commander)
  assert.ok(commander.tools.has('office_post'))

  await alpha.close()
  assert.deepEqual(
    toolNames(commander),
    toolNames(boss),
    'the set is released only when the last office unmounts, not when any one does',
  )
  assert.equal(
    (await call(commander, 'office_post', { office: 'beta', text: 'still here' })).office,
    'beta',
    'the surviving office is still reachable',
  )
})

await check('renaming an office renames what every surface addresses', async () => {
  // A dedicated office name: the module-level registry keeps one entry per storage key, so
  // reusing another harness's row id would overwrite that entry.
  const solo = makeHarness({ officeName: 'solo' })
  await solo.ready
  const soloBoss = solo.publish('session-solo-boss', { preset: 'office-boss' })
  const before = await callBoss(soloBoss, 'solo', 'office_roster', {})
  assert.equal(before.office, 'solo')
  const renamed = await callBoss(soloBoss, 'solo', 'office_rename', { name: 'HeadOffice' })
  assert.deepEqual(renamed, { office: 'solo', renamedTo: 'HeadOffice' })

  const state = await callRoute(routes, officeRoute('state', 'HeadOffice'))
  assert.equal(state.status, 200, 'the panel addresses the office by its new name')
  assert.equal(state.payload.office, 'HeadOffice')
  assert.equal(state.payload.officeId, 'office_solo', 'the storage key behind the name is unchanged')

  const discovered = await callRoute(routes, '/dsh-office/offices')
  const entry = discovered.payload.offices.find(office => office.id === 'office_solo')
  assert.equal(entry.name, 'HeadOffice', 'the switcher lists the new name')

  const after = await callBoss(soloBoss, 'HeadOffice', 'office_roster', {})
  assert.deepEqual(after.colleagues, before.colleagues, 'the roster survives the rename')
  assert.deepEqual(after.channels, before.channels, 'the channels survive the rename')
  await assert.rejects(
    () => callBoss(soloBoss, 'solo', 'office_roster', {}),
    /is not an office this session acts on/,
    'the old name stops resolving, exactly as renaming a session retitles its colleague',
  )
  await assert.rejects(() => callBoss(soloBoss, 'HeadOffice', 'office_rename', { name: '   ' }), /an office name must be letters/)
  await assert.rejects(() => callBoss(soloBoss, 'HeadOffice', 'office_rename', { name: 'no spaces' }), /an office name must be letters/)
})

await check('every tool result names the office it acted on', async () => {
  const named = makeHarness({ officeName: 'named' })
  await named.ready
  const namedBoss = named.publish('session-named-boss', { preset: 'office-boss' })
  await callBoss(namedBoss, 'named', 'office_rename', { name: '总部' })
  const roster = await callBoss(namedBoss, '总部', 'office_roster', {})
  assert.equal(roster.office, '总部', 'a result carries the office name, in whatever script it is written')
  assert.match(namedBoss.tools.get('office_roster').output.render({}, roster)[0].text, /^Office "总部"/)

  const posted = await callBoss(namedBoss, '总部', 'office_post', { text: 'hello' })
  assert.match(posted.message.text, /hello/)

  // A presenter is a pure function of the result it is handed, so it can be rendered
  // without the call's arguments and still name the office.
  assert.match(namedBoss.tools.get('office_post').output.render({}, {
    office: '总部',
    message: { messageId: 'named-1', channelId: 'general', text: 'hello' },
    deliveries: [],
  })[0].text, /^\[总部\]/)
  assert.match(
    namedBoss.tools.get('office_read').output.render({}, { office: '总部', channelId: 'general', messages: [] })[0].text,
    /^\[总部\]/,
  )

  assert.match(
    namedBoss.tools.get('office_post').output.render({}, {
      office: 'gone',
      message: { messageId: 'named-2', channelId: 'general', text: 'bye' },
      deliveries: [],
    })[0].text,
    /^\[gone\]/,
    'a result still names the office after that office unmounts',
  )
})

await check('the panel creates and deletes office rows without disturbing comments', async () => {
  await writeFile(PATCH_PATH, PATCH_SEED)

  const created = await callRoute(routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'studio' },
  })
  assert.equal(created.status, 202)
  let text = await readFile(PATCH_PATH, 'utf8')
  assert.ok(text.includes('user comment that must survive every edit'), 'the comment survives the edit')
  assert.ok(
    mountedOfficeRows(text).some(row => row.config?.officeName === 'studio'),
    'the new row sits inside an insert list, the only form the Loader mounts',
  )
  assert.ok(
    !overrideOfficeRows(text).some(row => row.config?.officeName === 'studio'),
    'the new row is not a top-level entry, which the Loader skips as an unmatched override',
  )
  assert.ok(text.includes('bossPreset: office-boss'), "the new office inherits the creator's boss preset")

  const duplicate = await callRoute(routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'studio' },
  })
  assert.equal(duplicate.status, 409, 'an office already in the profile is refused')
  const invalid = await callRoute(routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'Not Valid' },
  })
  assert.equal(invalid.status, 400, 'an invalid office name is refused')

  const removed = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'studio' },
  })
  assert.equal(removed.status, 200)
  text = await readFile(PATCH_PATH, 'utf8')
  assert.ok(!text.includes('officeName: studio'), 'the row is gone')
  assert.ok(text.includes('user comment that must survive every edit'), 'the comment still survives')
  assert.ok(text.includes('- id: office\n'), 'the original row is untouched')
  assert.deepEqual(parse(text), parse(PATCH_SEED), 'create then delete restores the document exactly')

  const missing = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'nope' },
  })
  assert.equal(missing.status, 404)
})

await check('a nameless override row still identifies its office', async () => {
  // The user's own profile patch overrides the package's `office` row with an entry
  // that carries only an id, `disabled`, and `config` — no `name`. Matching on `name`
  // alone reported "the profile declares no office" for the office it was looking at.
  await writeFile(PATCH_PATH, `# user comment that must survive every edit
- id: office
  disabled: false
  config:
    bossPreset: standard

- id: browser
  disabled: true
`)

  const duplicate = await callRoute(routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'office' },
  })
  assert.equal(duplicate.status, 409, 'an override carrying only an id still names its office')

  const unrelated = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'browser' },
  })
  assert.equal(unrelated.status, 404, 'an unrelated override is never mistaken for an office row')
  const text = await readFile(PATCH_PATH, 'utf8')
  assert.ok(text.includes('- id: browser\n'), 'and it is left untouched')
  assert.ok(text.includes('disabled: true'), 'including its own disablement')
  await rm(PATCH_PATH, { force: true })
})

await check('deleting an office an earlier layer declares disables its override', async () => {
  await writeFile(PATCH_PATH, `# user comment that must survive every edit
- id: office-tenant
  config:
    officeName: tenant
`)
  const tenant = makeHarness({ officeName: 'tenant' })
  await tenant.ready
  const tenantBoss = tenant.publish('session-tenant-boss', { preset: 'office-boss' })
  tenant.titles.set('session-t', 't')
  await callBoss(tenantBoss, 'tenant', 'office_adopt', { session_id: 'session-t' })

  const deleted = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'tenant' },
  })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.payload.disabledRow, true, 'a top-level override is disabled, not removed')
  const text = await readFile(PATCH_PATH, 'utf8')
  assert.ok(text.includes('officeName: tenant'), 'the row survives so the user can re-enable it')
  assert.match(text, /disabled: true/, 'and it carries the disablement')
  assert.equal(
    (await callBoss(tenantBoss, 'tenant', 'office_roster', {})).colleagues.length,
    0,
    'the data is erased before the row is disabled',
  )
  await rm(PATCH_PATH, { force: true })
})

await check('a top-level office row another tool left is still found, refused, and removable', async () => {
  await writeFile(PATCH_PATH, `${PATCH_SEED}- id: office-legacy
  name: 'dsh-office'
  config:
    officeName: legacy
`)

  const duplicate = await callRoute(routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'legacy' },
  })
  assert.equal(duplicate.status, 409, 'a row the Loader ignores still declares the office it names')

  const removed = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'legacy' },
  })
  assert.equal(removed.status, 200, 'a row outside an insert list is still removable')
  const text = await readFile(PATCH_PATH, 'utf8')
  assert.ok(!text.includes('officeName: legacy'), 'the dead row is gone')
  assert.ok(text.includes('- id: office\n'), 'the live row is untouched')
  await rm(PATCH_PATH, { force: true })
})

await check('a delete naming an undeclared office never erases that office data', async () => {
  await writeFile(PATCH_PATH, PATCH_SEED)
  const live = makeHarness({ officeName: 'orphan' })
  await live.ready
  const orphanBoss = live.publish('session-orphan-boss', { preset: 'office-boss' })
  live.titles.set('session-o', 'o')
  await callBoss(orphanBoss, 'orphan', 'office_adopt', { session_id: 'session-o' })
  assert.equal((await callBoss(orphanBoss, 'orphan', 'office_roster', {})).colleagues.length, 1)

  const missing = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'orphan' },
  })
  assert.equal(missing.status, 404, 'the profile declares no row for this office')
  assert.equal(
    (await callBoss(orphanBoss, 'orphan', 'office_roster', {})).colleagues.length,
    1,
    'a refused delete leaves the running office untouched',
  )
  await rm(PATCH_PATH, { force: true })
})

await check('deleting a mounted office erases its data before dropping its row', async () => {
  await writeFile(PATCH_PATH, PATCH_SEED)
  // The row comes first, because a create is refused for a name an office already answers to:
  // two offices of one name would be unaddressable, since the name is how both are reached.
  assert.equal(
    (await callRoute(routes, '/dsh-office/offices/create', { method: 'POST', body: { name: 'tenant' } })).status,
    202,
  )
  const tenant = makeHarness({ officeName: 'tenant' })
  await tenant.ready
  const tenantBoss = tenant.publish('session-tenant-boss', { preset: 'office-boss' })
  tenant.titles.set('session-t', 't')
  await callBoss(tenantBoss, 'tenant', 'office_adopt', { session_id: 'session-t' })
  assert.equal((await callBoss(tenantBoss, 'tenant', 'office_roster', {})).colleagues.length, 1)

  const deleted = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: 'tenant' },
  })
  assert.equal(deleted.status, 200)
  assert.deepEqual((await callBoss(tenantBoss, 'tenant', 'office_roster', {})).colleagues, [], 'the live office is erased')
  assert.ok(!(await readFile(PATCH_PATH, 'utf8')).includes('officeName: tenant'))
  await rm(PATCH_PATH, { force: true })
})

await check('the launcher profile context supplies the patch path when config omits it', async () => {
  await writeFile(PATCH_PATH, PATCH_SEED)
  const created = await callRoute(routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: 'annex' },
  })
  assert.equal(created.status, 202, 'the launcher patch path is used, not the process environment')
  assert.ok((await readFile(PATCH_PATH, 'utf8')).includes('officeName: annex'))
  await rm(PATCH_PATH, { force: true })
})


await check('an override that drops the office name reports the real reason', async () => {
  // A patch override REPLACES the whole config, so a user tweaking one value on the
  // office row drops its officeName. The row must still be read as an office — its id is
  // the patch's match key, so no override can remove it — and the failure must name the
  // missing field rather than reporting a second host.
  await assert.rejects(
    () => makeHarness({ officeName: undefined }).ready,
    /config\.officeName must be a name of letters.*must restate its officeName/s,
  )
})

await check('a bad deployment value fails activation loudly', async () => {
  await assert.rejects(
    () => makeHarness(undefined, undefined, { host: true, hostConfig: { readLimit: 500, readLimitMax: 100 } }).ready,
    /must not exceed/,
  )
  await assert.rejects(() => makeHarness({ maxMessageChars: 0 }).ready, /positive safe integer/)
  await assert.rejects(() => makeHarness({ wakesEnabled: 'yes' }).ready, /must be a boolean/)
  await assert.rejects(() => makeHarness({ userName: '  ' }).ready, /userName/)
  await assert.rejects(() => makeHarness({ bossPreset: '  ' }).ready, /bossPreset/)
  await assert.rejects(() => makeHarness({ officeName: 'Not Valid' }).ready, /officeName/)
})

await check('each row kind refuses the other kind\'s fields', async () => {
  await assert.rejects(
    () => makeHarness({ readLimit: 20 }).ready,
    /config\.readLimit has no meaning on an office row/,
    "an office row cannot take the host's tool bounds",
  )
  await assert.rejects(
    () => makeHarness(undefined, undefined, { host: true, hostConfig: { maxMessageChars: 10 } }).ready,
    /config\.maxMessageChars has no meaning on an office host row/,
    'the host cannot take an office delivery limit',
  )
  await assert.rejects(
    () => makeHarness({ readLimitMax: 100, officeName: 'office' }).ready,
    /config\.readLimitMax has no meaning on an office row/,
    'a row that names an office is an office row, so a host field on it is refused there',
  )
})

await check('an office name in any script mounts, is addressed by name, and stores under an ASCII key', async () => {
  const cn = makeHarness({ officeName: '产品部' }, undefined, { rowId: 'office_cn' })
  await cn.ready
  const cnBoss = cn.publish('session-cn-boss', { preset: 'office-boss' })

  const state = await callRoute(routes, officeRoute('state', '产品部'))
  assert.equal(state.status, 200, 'the panel addresses the office by a name in another script')
  assert.equal(state.payload.office, '产品部')
  assert.equal(state.payload.officeId, 'office_cn', 'the storage key stays ASCII, because it names a storage unit')

  cn.titles.set('session-zhang', '张三')
  await callBoss(cnBoss, '产品部', 'office_adopt', { session_id: 'session-zhang' })
  const roster = await callBoss(cnBoss, '产品部', 'office_roster', {})
  assert.deepEqual(roster.colleagues.map(entry => entry.name), ['张三'])
  assert.ok(
    (await call(cnBoss, 'office_list', {})).offices.some(entry => entry.office === '产品部'),
    'office_list reports the name the caller addresses',
  )
  assert.equal((await callBoss(cnBoss, '  产品部  ', 'office_roster', {})).office, '产品部', 'a padded name still resolves')
})

await check('an office name is canonical: case and Unicode spelling do not split one office', async () => {
  const canon = makeHarness({ officeName: 'Café' }, undefined, { rowId: 'office_cafe' })
  await canon.ready
  const canonBoss = canon.publish('session-canon-boss', { preset: 'office-boss' })
  assert.equal((await callBoss(canonBoss, 'café', 'office_roster', {})).office, 'Café', 'the stored spelling is what results carry')
  assert.equal(
    (await callBoss(canonBoss, 'Cafe\u0301', 'office_roster', {})).office,
    'Café',
    'a decomposed spelling resolves to the same office, because names are NFC-canonical',
  )
  assert.equal((await callRoute(routes, officeRoute('state', 'CAFÉ'))).status, 200, 'the panel resolves the same forms')
})

await check('a row id that cannot name a storage unit is refused unless officeId is set', async () => {
  await assert.rejects(
    () => makeHarness({ officeName: '工作室' }, undefined, { rowId: 'office-工作室' }).ready,
    /config\.officeId must match .*must set it/s,
  )
  const explicit = makeHarness({ officeName: '工作室', officeId: 'office_workshop' }, undefined, { rowId: 'office-工作室' })
  await explicit.ready
  assert.equal(
    (await callRoute(routes, officeRoute('state', '工作室'))).payload.officeId,
    'office_workshop',
    'an explicit officeId carries a row whose own id cannot name a storage unit',
  )
})

await check('two rows cannot mount one office name', async () => {
  const first = makeHarness({ officeName: 'twin' }, undefined, { rowId: 'office_twin_a' })
  await first.ready
  await assert.rejects(
    () => makeHarness({ officeName: 'twin' }, undefined, { rowId: 'office_twin_b' }).ready,
    /an office named "twin" is already mounted/,
    'the name is how the panel and the tools reach one office, so it must not be ambiguous',
  )
})

await check('a storage unit refuses to open for an office it does not belong to', async () => {
  const clash = makeHarness(undefined, undefined, { office: false })
  await clash.ready
  const unit = await clash.ctx.storageDomain.open({
    name: 'office_taken',
    global: { initial: { officeId: 'office_owner', name: 'Owner' } },
  })
  await unit.global.set({ officeId: 'office_owner', name: 'Owner' })
  clash.ctx.fiber.entry.options.id = 'office_taken'
  await assert.rejects(
    () => apply(clash.ctx, { officeName: 'Thief' }),
    /storage unit "office_taken" belongs to office "office_owner"/,
    'a row pointed at another office storage fails loud instead of adopting its data',
  )
})

await check('a renamed office keeps its stored name across a remount', async () => {
  const keeper = makeHarness({ officeName: 'keeper' }, undefined, { rowId: 'office_keeper' })
  await keeper.ready
  const keeperBoss = keeper.publish('session-keeper-boss', { preset: 'office-boss' })
  await callBoss(keeperBoss, 'keeper', 'office_rename', { name: '总务处' })
  await keeper.close()

  // The row still seeds `keeper`; the unit records the renamed office, so a restart must
  // keep the new name rather than restoring what the patch says.
  keeper.ctx.fiber.entry.options.id = 'office_keeper'
  await apply(keeper.ctx, { officeName: 'keeper' })
  const state = await callRoute(routes, officeRoute('state', '总务处'))
  assert.equal(state.status, 200, 'the stored name outlives the process that renamed it')
  assert.equal(state.payload.office, '总务处')
  assert.equal((await callRoute(routes, officeRoute('state', 'keeper'))).status, 404, 'the configured seed is not consulted again')
})

await check('the panel creates an office whose name is in another script', async () => {
  await writeFile(PATCH_PATH, PATCH_SEED)
  const created = await callRoute(routes, '/dsh-office/offices/create', {
    method: 'POST',
    body: { name: '研发部' },
  })
  assert.equal(created.status, 202)
  const text = await readFile(PATCH_PATH, 'utf8')
  const row = mountedOfficeRows(text).find(entry => entry.config?.officeName === '研发部')
  assert.ok(row, 'the name is stored as written, inside the insert list the Loader mounts')
  assert.match(row.id, /^office_[0-9a-f]{12}$/, 'a name with no ASCII part still yields a usable row id')
  assert.equal(row.config.officeId, row.id, 'the storage key is written down rather than left to the row id default')

  const removed = await callRoute(routes, '/dsh-office/offices/delete', {
    method: 'POST',
    body: { office: '研发部' },
  })
  assert.equal(removed.status, 200, 'the created office is addressed by its name alone')
  assert.ok(!(await readFile(PATCH_PATH, 'utf8')).includes('研发部'))
  await rm(PATCH_PATH, { force: true })
})

await check('the user name accepts any script', async () => {
  const front = makeHarness({ officeName: 'front', userName: '前台' }, undefined, { rowId: 'office_front' })
  await front.ready
  const posted = await callRoute(routes, officeRoute('post', 'front'), { method: 'POST', body: { text: '公告' } })
  assert.equal(posted.status, 200)
  const state = await callRoute(routes, officeRoute('state', 'front'))
  assert.equal(state.payload.messages.at(-1).senderName, '前台', 'a sender name in another script reaches the panel')
})

await check('a wake that cannot be delivered is reported on the message', async () => {
  const failing = makeHarness({ officeName: 'failing' }, undefined, { rowId: 'office_failing', failResumeOnce: true })
  await failing.ready
  const chief = failing.publish('session-failing-boss', { preset: 'office-boss' })
  failing.titles.set('session-failing-boss', 'chief')
  failing.titles.set('session-gil', 'gil')
  await callBoss(chief, 'failing', 'office_adopt', { session_id: 'session-gil' })

  const first = await callBoss(chief, 'failing', 'office_post', { text: 'gil, are you there?', mentions: ['gil'] })
  assert.equal(first.deliveries[0].status, 'failed', 'a wake that could not happen is reported, not hidden')
  assert.match(first.deliveries[0].detail, /resume failed for session-gil/)
  const again = await callBoss(chief, 'failing', 'office_post', { text: 'gil, again', mentions: ['gil'] })
  assert.deepEqual(again.deliveries, [{ colleague: 'gil', status: 'delivered' }], 'the next wake is unaffected')
  assert.equal(failing.liveAgents.get('session-gil').sent.length, 1, 'only the delivered wake became a turn')
})

await check('a hired colleague is greeted without the office history being replayed', async () => {
  const joining = makeHarness({ officeName: 'joining' }, undefined, { rowId: 'office_joining' })
  await joining.ready
  const chief = joining.publish('session-joining-boss', { preset: 'office-boss' })
  joining.titles.set('session-joining-boss', 'chief')
  await callBoss(chief, 'joining', 'office_post', { text: 'old decision one', mention_all: false })
  const hired = await callBoss(chief, 'joining', 'office_hire', { name: 'Newcomer' })
  assert.equal(hired.greeting, 'delivered')
  const newcomer = joining.liveAgents.get(hired.colleague.sessionId)
  assert.equal(newcomer.sent.length, 1, 'the greeting is the new colleague only turn')
  const body = newcomer.sent[0].message.content[0].text
  assert.match(body, /You are "Newcomer", a colleague of the office "joining"/)
  assert.match(body, /nothing replays it/, 'and it is told the history is read on demand')
  assert.ok(!body.includes('old decision one'), 'nothing posted before it joined is pushed into its context')
  const archive = await callBoss(chief, 'joining', 'office_read', { channel: '#general' })
  assert.ok(archive.messages.some(message => message.text === 'old decision one'), 'the history is still in the channel')
})
await check('a wake says how far the channel had moved when the turn was queued', async () => {
  const lagging = makeHarness({ officeName: 'lagging' }, undefined, { rowId: 'office_lagging', slowResumeMs: 25 })
  await lagging.ready
  const chief = lagging.publish('session-lagging-boss', { preset: 'office-boss' })
  lagging.titles.set('session-lagging-boss', 'chief')
  lagging.titles.set('session-zed', 'zed')
  await callBoss(chief, 'lagging', 'office_adopt', { session_id: 'session-zed' })

  // zed is cold and its resume takes a moment, so the office posts again while that is in
  // flight: the message zed is finally woken for is no longer the newest one in the channel.
  const first = callBoss(chief, 'lagging', 'office_post', { text: 'zed, first', mentions: ['zed'] })
  await new Promise(resolve => setTimeout(resolve, 5))
  await callBoss(chief, 'lagging', 'office_post', { text: 'a second message', mentions: [] })
  const posted = await first
  assert.deepEqual(posted.deliveries, [{ colleague: 'zed', status: 'delivered' }])

  const body = lagging.liveAgents.get('session-zed').sent.at(-1).message.content[0].text
  assert.match(body, /^\[office #general from chief \| general-1\]/)
  assert.match(body, /#general had already reached general-2 when this turn was queued/)
  assert.match(body, /Newer messages are not part of it; office_read reads them\./)

  // A wake that was never overtaken carries no such line: a live message and a stale one must
  // not look the same in the opposite direction either.
  const live = await callBoss(chief, 'lagging', 'office_post', { text: 'zed, live', mentions: ['zed'] })
  assert.equal(live.deliveries[0].status, 'delivered')
  assert.ok(
    !lagging.liveAgents.get('session-zed').sent.at(-1).message.content[0].text.includes('when this turn was queued'),
    'the newest message needs no freshness line',
  )
})

await check('office_read answers a sequence range and every filter', async () => {
  const library = makeHarness(
    { officeName: 'library' },
    undefined,
    { rowId: 'office_library' },
  )
  await library.ready
  const chief = library.publish('session-library-boss', { preset: 'office-boss' })
  library.titles.set('session-library-boss', 'chief')
  library.titles.set('session-ann', 'ann')
  library.titles.set('session-ben', 'ben')
  const ann = library.publish('session-ann')
  const ben = library.publish('session-ben')
  await callBoss(chief, 'library', 'office_adopt', { session_id: 'session-ann' })
  await callBoss(chief, 'library', 'office_adopt', { session_id: 'session-ben' })
  await callBoss(chief, 'library', 'office_post', { text: 'kickoff at nine', mentions: [] })
  await call(ann, 'office_post', { text: 'I am on the DOCS' })
  await callBoss(chief, 'library', 'office_post', { text: '@ann please review', mentions: ['ann'] })
  await call(ben, 'office_post', { text: 'unrelated' })
  const fromPanel = await callRoute(routes, officeRoute('post', 'library'), {
    method: 'POST',
    body: { text: 'from the panel' },
  })
  assert.equal(fromPanel.status, 200)

  const all = await call(ben, 'office_read', { channel: '#general' })
  assert.deepEqual(all.messages.map(message => message.seq), [1, 2, 3, 4, 5], 'the read reports the sequences it ranges over')
  assert.equal(all.messages[0].kind, 'public')
  assert.equal(all.total, 5, 'a complete read reports how many matched')
  assert.equal(all.truncated, false, 'and says it is complete')

  const windowed = await call(ben, 'office_read', { channel: '#general', limit: 2 })
  assert.deepEqual(windowed.messages.map(message => message.text), ['unrelated', 'from the panel'])
  assert.equal(windowed.total, 5, 'a window still reports the whole match count')
  assert.equal(windowed.truncated, true, 'and says it is a window')
  assert.match(
    ben.tools.get('office_read').output.render({ limit: 2 }, windowed)[0].text,
    /That is the newest 2 of 5 matching messages/,
    'because a window that does not announce itself reads as the whole history',
  )

  await assert.rejects(
    () => call(ben, 'office_read', {}),
    /channel is required/,
    'an omitted required argument is named as the omission, not as a channel called "undefined"',
  )

  const ranged = await call(ben, 'office_read', { channel: '#general', from: 2, to: 3 })
  assert.deepEqual(ranged.messages.map(message => message.text), ['I am on the DOCS', '@ann please review'])

  assert.deepEqual(
    (await call(ben, 'office_read', { channel: '#general', limit: 1 })).messages.map(message => message.text),
    ['from the panel'],
    'limit keeps the newest',
  )
  assert.deepEqual(
    (await call(ben, 'office_read', { channel: '#general', sender: 'ann' })).messages.map(message => message.text),
    ['I am on the DOCS'],
    'a colleague is matched by session, so a rename cannot split its history',
  )
  assert.deepEqual(
    (await call(ben, 'office_read', { channel: '#general', sender: 'user' })).messages.map(message => message.text),
    ['from the panel'],
    'the panel user has no session and is still addressable',
  )
  await assert.rejects(
    () => call(ben, 'office_read', { channel: '#general', sender: 'nobody' }),
    /neither a colleague's session title nor the user/,
  )
  assert.deepEqual(
    (await call(ben, 'office_read', { channel: '#general', contains: 'docs' })).messages.map(message => message.text),
    ['I am on the DOCS'],
    'contains ignores case',
  )
  assert.deepEqual(
    (await call(ben, 'office_read', { channel: '#general', mentions: 'ann' })).messages.map(message => message.text),
    ['@ann please review'],
  )
  assert.deepEqual(
    (await call(ann, 'office_read', { channel: '#general', mentions: 'me' })).messages.map(message => message.text),
    ['@ann please review'],
    'me resolves to the reading session',
  )
  assert.deepEqual((await call(ben, 'office_read', { channel: '#general', since: Date.now() + 60_000 })).messages, [])
  assert.deepEqual((await call(ben, 'office_read', { channel: '#general', until: 1 })).messages, [])
  const recent = await call(ben, 'office_read', { channel: '#general', since: all.messages.at(-1).createdAt })
  assert.equal(recent.messages.at(-1).text, 'from the panel', 'since keeps what is at or after the instant')

  const brief = await call(ben, 'office_read', { channel: '#general', brief: true, from: 2, to: 2 })
  assert.deepEqual(brief.messages, [{
    messageId: 'general-2',
    channelId: 'general',
    seq: 2,
    kind: 'public',
    senderName: 'ann',
    createdAt: brief.messages[0].createdAt,
  }])
  const everywhere = await call(ann, 'office_read', { channel: '*' })
  assert.equal(everywhere.channelId, '*')
  assert.deepEqual(
    everywhere.messages.map(message => message.channelId),
    ['general', 'general', 'general', 'general', 'general'],
    'a colleague with no direct channel sees the public one alone',
  )
  await assert.rejects(
    () => call(ben, 'office_read', { channel: '#general', from: 3, to: 2 }),
    /from \(3\) must not exceed to \(2\)/,
  )
})

await check('office_compact replaces a range in place, and reads back as one summary', async () => {
  const archive = makeHarness(
    { officeName: 'archive' },
    undefined,
    { rowId: 'office_archive' },
  )
  await archive.ready
  const chief = archive.publish('session-archive-boss', { preset: 'office-boss' })
  archive.titles.set('session-archive-boss', 'chief')
  archive.titles.set('session-iris', 'iris')
  const iris = archive.publish('session-iris')
  await callBoss(chief, 'archive', 'office_adopt', { session_id: 'session-iris' })
  for (const text of ['plan a', 'plan b', 'plan c']) {
    await callBoss(chief, 'archive', 'office_post', { text, mentions: [] })
  }

  const compacted = await callBoss(chief, 'archive', 'office_compact', {
    from: 1,
    to: 3,
    summary: 'The team agreed to ship on Friday.',
  })
  assert.deepEqual(compacted.covers, [1, 3])
  assert.equal(compacted.replaced, 3)
  assert.equal(compacted.summaryId, 'general-1', 'the summary takes the lowest sequence of the range')
  const feed = await callBoss(chief, 'archive', 'office_read', { channel: '#general' })
  assert.deepEqual(feed.messages.map(message => message.text), ['The team agreed to ship on Friday.'])
  assert.equal(feed.messages[0].kind, 'summary')
  assert.deepEqual(feed.messages[0].covers, [1, 3])

  // Compacting a range that holds a summary absorbs what that summary already replaced, so
  // `covers` describes what is gone rather than what one call happened to name.
  const nested = await callBoss(chief, 'archive', 'office_compact', {
    from: 1,
    to: 1,
    summary: 'Everything so far is settled.',
  })
  assert.deepEqual(nested.covers, [1, 3], 'a nested summary keeps the coverage it stands for')
  assert.equal(nested.replaced, 1, 'and removes the summary it replaces, never the messages already gone')
  await assert.rejects(
    () => callBoss(chief, 'archive', 'office_compact', { from: 90, to: 99, summary: 'nothing here' }),
    /has no messages in 90\.\.99/,
  )

  const woke = await callBoss(chief, 'archive', 'office_post', { text: 'iris, standup', mentions: ['iris'] })
  assert.deepEqual(woke.deliveries, [{ colleague: 'iris', status: 'delivered' }])
  const body = iris.sent.at(-1).message.content[0].text
  assert.ok(!body.includes('plan a'), 'a wake carries its own message and never replays the channel')
  assert.ok(!body.includes('Everything so far'), 'not even the summary that now stands for it')
  assert.match(body, /^\[office #general from chief \| general-4\]/)
  assert.ok(!toolNames(iris).includes('office_compact'), 'a member holds neither compaction nor interruption')
  // The summary is what a reader meets where the range used to be, so a range query over the
  // covered sequences answers with the summary rather than with nothing.
  const covered = await call(iris, 'office_read', { channel: '#general', from: 1, to: 3 })
  assert.deepEqual(covered.messages.map(message => message.text), ['Everything so far is settled.'])
})

await check('each predefined role holds exactly the office tools it is defined with', async () => {
  const roles = makeHarness({ officeName: 'roles' }, undefined, { rowId: 'office_roles' })
  await roles.ready
  const chief = roles.publish('session-roles-boss', { preset: 'office-boss' })
  const sessions = {}
  for (const role of ['member', 'leader', 'consultant']) {
    roles.titles.set(`session-${role}`, role)
    sessions[role] = roles.publish(`session-${role}`)
    await callBoss(chief, 'roles', 'office_adopt', {
      session_id: `session-${role}`,
      role,
      description: `the office ${role}`,
    })
  }
  assert.deepEqual(toolNames(sessions.member), ['office_colleagues', 'office_dm', 'office_post', 'office_read'])
  assert.deepEqual(toolNames(sessions.leader), [
    'office_colleagues',
    'office_compact',
    'office_configure',
    'office_dm',
    'office_interrupt',
    'office_post',
    'office_read',
  ])
  assert.deepEqual(
    toolNames(sessions.consultant),
    ['office_colleagues', 'office_dm', 'office_post', 'office_read'],
    'a consultant speaks like a member and carries no leader-only tool',
  )
  const roster = await callBoss(chief, 'roles', 'office_roster', {})
  assert.deepEqual(
    roster.colleagues.map(entry => `${entry.name}:${entry.role}:${entry.description}`).sort(),
    ['consultant:consultant:the office consultant', 'leader:leader:the office leader', 'member:member:the office member'],
    'the roster reports the role and the description each colleague was configured with',
  )
})

await check('changing a role moves the live session to the tool set the new role holds', async () => {
  const shifts = makeHarness({ officeName: 'shifts' }, undefined, { rowId: 'office_shifts' })
  await shifts.ready
  const chief = shifts.publish('session-shifts-boss', { preset: 'office-boss' })
  shifts.titles.set('session-dana', 'dana')
  const dana = shifts.publish('session-dana')
  await callBoss(chief, 'shifts', 'office_adopt', { session_id: 'session-dana' })
  assert.ok(dana.tools.has('office_post'), 'a colleague with no role given starts as a member')

  const promoted = await callBoss(chief, 'shifts', 'office_configure', { name: 'dana', role: 'leader' })
  assert.equal(promoted.colleague.role, 'leader')
  assert.ok(dana.tools.has('office_interrupt'), 'the promoted leader is armed in the same call')
  assert.ok(dana.tools.has('office_compact'))

  const demoted = await callBoss(chief, 'shifts', 'office_configure', {
    name: 'dana',
    role: 'consultant',
    description: 'reads the record and writes no files',
  })
  assert.deepEqual(
    toolNames(dana),
    ['office_colleagues', 'office_dm', 'office_post', 'office_read'],
    'a demotion withdraws the leader-only tools rather than leaving them to refuse at call time',
  )
  assert.equal(demoted.colleague.description, 'reads the record and writes no files')

  const cleared = await callBoss(chief, 'shifts', 'office_configure', { name: 'dana', description: '' })
  assert.equal(cleared.colleague.description, undefined, 'an empty description removes it')
  assert.equal(cleared.colleague.role, 'consultant', 'and the omitted role keeps its stored value')
  await assert.rejects(
    () => callBoss(chief, 'shifts', 'office_configure', { name: 'dana' }),
    /pass role, description, or both/,
  )
  await assert.rejects(
    () => callBoss(chief, 'shifts', 'office_configure', { name: 'nobody', role: 'member' }),
    /does not match any colleague's session title/,
  )
})

await check('a stored role that is no longer predefined reads as the default member', async () => {
  const legacy = makeHarness({ officeName: 'legacy' }, undefined, { rowId: 'office_legacy' })
  await legacy.ready
  const chief = legacy.publish('session-legacy-boss', { preset: 'office-boss' })
  legacy.titles.set('session-old', 'old')
  const old = legacy.publish('session-old')
  // A record the way a deployment that predates the predefined roles left it: the label granted
  // nothing then, and must not be read as a permission now.
  await legacy.tables.get('colleagues').put('session-old', { sessionId: 'session-old', role: 'reviewer' })
  const roster = await callBoss(chief, 'legacy', 'office_roster', {})
  assert.deepEqual(roster.colleagues, [{ name: 'old', sessionId: 'session-old', role: 'member' }])

  const readopted = await callBoss(chief, 'legacy', 'office_adopt', { session_id: 'session-old' })
  assert.equal(readopted.colleague.role, 'member')
  await callBoss(chief, 'legacy', 'office_configure', { name: 'old', description: 'kept around' })
  const stored = legacy.tables.get('colleagues').get('session-old')
  assert.equal(stored.role, 'member')
  assert.equal(stored.description, 'kept around')
  assert.ok(
    Number.isSafeInteger(stored.adoptedAt),
    'the next write rewrites the label, so storage stops carrying a role nobody can resolve',
  )
  assert.deepEqual(toolNames(old), ['office_colleagues', 'office_dm', 'office_post', 'office_read'])
})

await check('office_colleagues reports the roster with each colleague live status', async () => {
  const board = makeHarness({ officeName: 'board' }, undefined, { rowId: 'office_board' })
  await board.ready
  const chief = board.publish('session-board-boss', { preset: 'office-boss' })
  board.titles.set('session-ann', 'ann')
  board.titles.set('session-ben', 'ben')
  const ann = board.publish('session-ann')
  const ben = board.publish('session-ben')
  await callBoss(chief, 'board', 'office_adopt', {
    session_id: 'session-ann',
    role: 'leader',
    description: 'runs the standup',
  })
  await callBoss(chief, 'board', 'office_adopt', { session_id: 'session-ben', role: 'consultant' })
  await board.setStatus('session-ann', 'running')

  const listed = await call(ann, 'office_colleagues', {})
  assert.deepEqual(listed.colleagues.map(entry => entry.name), ['ann', 'ben'])
  const [first, second] = listed.colleagues
  assert.equal(first.role, 'leader')
  assert.equal(first.description, 'runs the standup')
  assert.equal(first.status, 'running', 'a colleague that is mid-turn is reported as running')
  assert.equal(first.provider, 'probe-provider')
  assert.equal(first.model, 'probe-model')
  assert.equal(second.status, 'idle')
  assert.equal(second.permission, 'read-only', 'a consultant session runs under the preset its role maps to')
  assert.ok(first.adoptedAt <= Date.now())

  // Reading the roster delivers nothing, and a wake the office holds for a busy colleague is
  // reported as pending rather than delivered behind its back.
  const before = ann.sent.length
  await callBoss(chief, 'board', 'office_post', { text: 'status please', mentions: ['ann'] })
  const after = await call(ann, 'office_colleagues', {})
  assert.equal(ann.sent.length, before, 'office_colleagues is a query and wakes nobody')
  assert.equal(after.colleagues[0].pending, 1, 'the held wake is reported')
  assert.ok(after.colleagues[0].lastMessageAt >= after.colleagues[0].adoptedAt, 'and the last message it took part in is dated')

  board.dispose(ben)
  const unloaded = await call(ann, 'office_colleagues', {})
  const benRow = unloaded.colleagues.find(entry => entry.name === 'ben')
  assert.deepEqual(
    { status: benRow.status, permission: benRow.permission, model: benRow.model },
    { status: 'inactive', permission: undefined, model: undefined },
    'an unloaded colleague reports no permission and no route: the office does not hold them',
  )
})

await check('office_interrupt stops a running colleague and reports what it found', async () => {
  const floor = makeHarness({ officeName: 'floor' }, undefined, { rowId: 'office_floor' })
  await floor.ready
  const chief = floor.publish('session-floor-boss', { preset: 'office-boss' })
  floor.titles.set('session-ivy', 'ivy')
  floor.titles.set('session-joe', 'joe')
  floor.titles.set('session-kim', 'kim')
  const ivy = floor.publish('session-ivy')
  const joe = floor.publish('session-joe')
  const kim = floor.publish('session-kim')
  await callBoss(chief, 'floor', 'office_adopt', { session_id: 'session-ivy' })
  await callBoss(chief, 'floor', 'office_adopt', { session_id: 'session-joe' })
  await callBoss(chief, 'floor', 'office_adopt', { session_id: 'session-kim', role: 'leader' })

  await floor.setStatus('session-ivy', 'running')
  const stopped = await callBoss(chief, 'floor', 'office_interrupt', { name: 'ivy' })
  assert.deepEqual(stopped, { office: 'floor', colleague: 'ivy', status: 'running', interrupted: true })
  assert.deepEqual(
    ivy.cancels,
    [{ cause: { kind: 'user' }, options: { keepInbox: true } }],
    'the cancellation keeps the inbox, so a message sent moments ago is not what gets stopped',
  )

  const idle = await callBoss(chief, 'floor', 'office_interrupt', { name: 'joe' })
  assert.deepEqual(idle, { office: 'floor', colleague: 'joe', status: 'idle', interrupted: false })
  assert.deepEqual(joe.cancels, [], 'an idle colleague is reported rather than cancelled to look busy')

  floor.dispose(joe)
  const unloaded = await callBoss(chief, 'floor', 'office_interrupt', { name: 'joe' })
  assert.deepEqual(unloaded, { office: 'floor', colleague: 'joe', status: 'inactive', interrupted: false })
  await assert.rejects(
    () => callBoss(chief, 'floor', 'office_interrupt', { name: 'nobody' }),
    /does not match any colleague's session title/,
  )
  await assert.rejects(
    () => call(kim, 'office_interrupt', { name: 'kim' }),
    /cannot interrupt itself/,
    'a leader cannot stop its own turn, which is the turn it is calling from',
  )
})

await check('a capability is checked against the office a call resolved, not the union', async () => {
  const alpha = makeHarness({ officeName: 'leadalpha' }, undefined, { rowId: 'office_leadalpha' })
  const beta = makeHarness({ officeName: 'leadbeta' }, undefined, { rowId: 'office_leadbeta' })
  await alpha.ready
  await beta.ready
  const alphaBoss = alpha.publish('session-la-boss', { preset: 'office-boss' })
  const betaBoss = beta.publish('session-lb-boss', { preset: 'office-boss' })
  alpha.titles.set('session-kim', 'kim')
  beta.titles.set('session-kim', 'kim')
  const kim = alpha.publish('session-kim')
  beta.adoptAgent(kim)
  await callBoss(alphaBoss, 'leadalpha', 'office_adopt', { session_id: 'session-kim', role: 'leader' })
  await callBoss(betaBoss, 'leadbeta', 'office_adopt', { session_id: 'session-kim', role: 'member' })

  assert.ok(kim.tools.has('office_interrupt'), 'the union of the roles grants the tool, which is what a scope can hold')
  alpha.titles.set('session-lee', 'lee')
  alpha.publish('session-lee')
  await callBoss(alphaBoss, 'leadalpha', 'office_adopt', { session_id: 'session-lee' })
  assert.equal(
    (await call(kim, 'office_interrupt', { office: 'leadalpha', name: 'lee' })).status,
    'idle',
    'the office whose role grants the capability accepts the call',
  )
  await assert.rejects(
    () => call(kim, 'office_interrupt', { office: 'leadbeta', name: 'kim' }),
    /the "member" role in office "leadbeta" holds no interrupt permission/,
    'and the membership that does not hold it cannot use it there',
  )
})

await check('a role maps to the session permission preset the office row declares', async () => {
  const perm = makeHarness({ officeName: 'perm' }, undefined, { rowId: 'office_perm' })
  await perm.ready
  const chief = perm.publish('session-perm-boss', { preset: 'office-boss' })
  perm.titles.set('session-cons', 'cons')
  const cons = perm.publish('session-cons')
  const adopted = await callBoss(chief, 'perm', 'office_adopt', { session_id: 'session-cons', role: 'consultant' })
  assert.equal(adopted.colleague.permission, 'read-only')
  assert.equal(perm.permissions.get('session-cons'), 'read-only', 'the consultant session itself carries the preset')

  // A description-only change must not revert a preset the user switched by hand: the role
  // decides the permission, and only setting the role writes it.
  perm.permissions.set('session-cons', 'danger-full-access')
  await callBoss(chief, 'perm', 'office_configure', { name: 'cons', description: 'reads the record' })
  assert.equal(perm.permissions.get('session-cons'), 'danger-full-access')

  const promoted = await callBoss(chief, 'perm', 'office_configure', { name: 'cons', role: 'leader' })
  assert.equal(
    promoted.colleague.permission,
    undefined,
    'a role the office row maps to no preset leaves the session permission alone',
  )
  assert.equal(perm.permissions.get('session-cons'), 'danger-full-access')
})

await check('a role whose preset the deployment cannot apply is refused, not stored unenforced', async () => {
  const narrow = makeHarness(
    { officeName: 'narrow' },
    undefined,
    { rowId: 'office_narrow', permissionPresets: ['workspace-write'] },
  )
  await narrow.ready
  const chief = narrow.publish('session-narrow-boss', { preset: 'office-boss' })
  narrow.titles.set('session-pia', 'pia')
  narrow.publish('session-pia')
  await assert.rejects(
    () => callBoss(chief, 'narrow', 'office_adopt', { session_id: 'session-pia', role: 'consultant' }),
    /does not define; available: workspace-write/,
  )
  assert.deepEqual(
    (await callBoss(chief, 'narrow', 'office_roster', {})).colleagues,
    [],
    'the refused consultant left no colleague behind with a restriction nobody enforces',
  )

  const bare = makeHarness(
    { officeName: 'bare' },
    undefined,
    { rowId: 'office_bare', permissionPresets: null },
  )
  await bare.ready
  const bareBoss = bare.publish('session-bare-boss', { preset: 'office-boss' })
  bare.titles.set('session-quinn', 'quinn')
  bare.publish('session-quinn')
  await assert.rejects(
    () => callBoss(bareBoss, 'bare', 'office_hire', { name: 'quinn', role: 'consultant' }),
    /mounts no permission presets/,
  )
})

await check('an office row refuses a rolePermissions map it cannot act on', async () => {
  await assert.rejects(
    () => makeHarness({ officeName: 'badrole', rolePermissions: { chief: 'read-only' } }).ready,
    /config\.rolePermissions\.chief names no predefined role/,
  )
  await assert.rejects(
    () => makeHarness({ officeName: 'badpreset', rolePermissions: { consultant: '  ' } }).ready,
    /config\.rolePermissions\.consultant must name a permission preset/,
  )
  await assert.rejects(
    () => makeHarness(undefined, undefined, {
      host: true,
      hostConfig: { rolePermissions: { consultant: 'read-only' } },
    }).ready,
    /has no meaning on an office host row/,
    'the mapping belongs to an office, and the host refuses the field rather than ignoring it',
  )
})

await check('a consultant speaks into the office while its session runs read-only', async () => {
  const quiet = makeHarness({ officeName: 'quiet' }, undefined, { rowId: 'office_quiet' })
  await quiet.ready
  const chief = quiet.publish('session-quiet-boss', { preset: 'office-boss' })
  quiet.titles.set('session-rose', 'rose')
  const rose = quiet.publish('session-rose')
  const hired = await callBoss(chief, 'quiet', 'office_adopt', {
    session_id: 'session-rose',
    role: 'consultant',
    description: 'reads and advises',
  })
  assert.equal(hired.colleague.permission, 'read-only', 'the preset is the session restriction, not the voice')

  // The frame answers with the tools the role holds, so a consultant is told where a public
  // answer belongs rather than being pointed at its own transcript.
  await callBoss(chief, 'quiet', 'office_post', { text: 'any advice? mention me if so', mentions: ['rose'] })
  const frame = rose.sent.at(-1).message.content[0].text
  assert.match(frame, /Post important information to #general so everyone can learn from it/, 'the frame names what the role holds')
  assert.match(frame, /send short exchanges privately with office_dm/)

  const spoken = await call(rose, 'office_post', { text: 'advice: the summary is settled', mention_all: false })
  assert.equal(spoken.message.channelId, 'general', 'a consultant writes into the office like a member')
  const read = await callBoss(chief, 'quiet', 'office_read', { channel: '#general' })
  assert.equal(read.messages.at(-1).text, 'advice: the summary is settled')

  const greeting = await callBoss(chief, 'quiet', 'office_hire', { name: 'sage', role: 'consultant' })
  const greeted = quiet.liveAgents.get(greeting.colleague.sessionId)
  const text = greeted.sent[0].message.content[0].text
  assert.match(text, /Your role: consultant\./)
  assert.match(text, /office_post posts important information to #general/, 'the greeting lists the tools the role actually holds')
  assert.match(text, /You hold 4 tools/)
  assert.ok(!text.includes('You hold no tool that writes into the office'), 'a consultant holds the messaging tools')
})

await check('the panel snapshot offers the roles, and the configure route edits a colleague', async () => {
  const panel = makeHarness({ officeName: 'paneledit' }, undefined, { rowId: 'office_paneledit' })
  await panel.ready
  const chief = panel.publish('session-paneledit-boss', { preset: 'office-boss' })
  panel.titles.set('session-pia', 'pia')
  const pia = panel.publish('session-pia')
  await callBoss(chief, 'paneledit', 'office_adopt', { session_id: 'session-pia' })

  const state = await callRoute(routes, officeRoute('state', 'paneledit'))
  assert.equal(state.status, 200)
  assert.deepEqual(
    state.payload.roles,
    [{ id: 'member' }, { id: 'leader' }, { id: 'consultant', permission: 'read-only' }],
    'each role travels with the preset the office row maps it to',
  )
  assert.deepEqual(
    state.payload.colleagues.map(entry => `${entry.name}:${entry.role}:${entry.status}`),
    ['pia:member:idle'],
    'the roster the panel draws carries the role and the live status',
  )

  const configured = await callRoute(routes, officeRoute('configure', 'paneledit'), {
    method: 'POST',
    body: { name: 'pia', role: 'consultant', description: 'keeps the record' },
  })
  assert.equal(configured.status, 200, `configure refused: ${JSON.stringify(configured.payload)}`)
  assert.equal(configured.payload.colleague.role, 'consultant')
  assert.equal(configured.payload.colleague.permission, 'read-only')
  assert.deepEqual(
    toolNames(pia),
    ['office_colleagues', 'office_dm', 'office_post', 'office_read'],
    'the panel edit reaches the live session exactly as the tool does',
  )
  assert.ok(pia.tools.has('office_post'), 'and a consultant the panel created holds the messaging tools')
  const refused = await callRoute(routes, officeRoute('configure', 'paneledit'), {
    method: 'POST',
    body: { name: 'pia', role: 'reviewer' },
  })
  assert.equal(refused.status, 400)
  assert.match(refused.payload.error, /role must be one of member, leader, consultant/)
  const missing = await callRoute(routes, officeRoute('configure', 'paneledit'), {
    method: 'POST',
    body: { name: 'nobody', role: 'member' },
  })
  assert.equal(missing.status, 404)
  const nothing = await callRoute(routes, officeRoute('configure', 'paneledit'), {
    method: 'POST',
    body: { name: 'pia' },
  })
  assert.equal(nothing.status, 400)
  assert.match(nothing.payload.error, /pass role, description, or both/)
})

await check('the panel adopts an existing session as a colleague', async () => {
  // A second office mounts into the shared process, so the adopt route, the snapshot listing,
  // and the tool resync all run on the one context the harness already carries.
  harness.ctx.fiber.entry.options.id = 'office_guiadopt'
  await apply(harness.ctx, { officeName: 'guiadopt' })

  titles.set('session-sam', 'sam')
  const sam = harness.publish('session-sam', { cwd: '/work/mine' })

  const state = await callRoute(routes, officeRoute('state', 'guiadopt'))
  const adoptable = state.payload.unadopted.find(entry => entry.sessionId === 'session-sam')
  assert.deepEqual(
    adoptable?.workspace,
    { id: 'workspace-own', title: 'Own' },
    'the picker travels the workspace the session is accounted under',
  )
  assert.ok(adoptable !== undefined, 'the snapshot lists the sessions nobody has adopted')
  assert.ok(
    state.payload.unadopted.every(entry => entry.workspace !== undefined),
    'a session the registry accounts to no workspace is never offered: the picker shows the accounted ones only',
  )

  // The title is the sidebar's own: the live projection for a live session, the projection cache
  // row for a cold one, and the archive set keeps the archived session out of every listing.
  const labeled = state.payload.unadopted.filter(entry =>
    ['session-sam', 'session-titled', 'session-cold', 'session-archived'].includes(entry.sessionId))
  assert.deepEqual(
    labeled.map(entry => `${entry.title} (${entry.workspace.title})`),
    ['Titled session (Own)', 'sam (Own)', 'Cold session (Own)'],
    'a live session shows its projected title, a cold one its cached title, and an archived one is not offered',
  )

  const refused = await callRoute(routes, officeRoute('adopt', 'guiadopt'), {
    method: 'POST',
    body: {},
  })
  assert.equal(refused.status, 400, 'an adopt without a session id is a refusal, not a guess')

  const adopted = await callRoute(routes, officeRoute('adopt', 'guiadopt'), {
    method: 'POST',
    body: { session_id: 'session-sam' },
  })
  assert.equal(adopted.status, 200, `adopt refused: ${JSON.stringify(adopted.payload)}`)
  assert.deepEqual(adopted.payload.colleague, {
    name: 'sam',
    sessionId: 'session-sam',
    role: 'member',
  }, 'the colleague is named by the adopted session title, like every colleague')
  assert.deepEqual(
    toolNames(sam),
    ['office_colleagues', 'office_dm', 'office_post', 'office_read'],
    'adoption from the panel arms the live session exactly as the tool does',
  )
  const after = (await callRoute(routes, officeRoute('state', 'guiadopt'))).payload
  assert.ok(after.colleagues.some(entry => entry.name === 'sam'), 'and the roster carries the adopted session')
  assert.ok(
    !after.unadopted.some(entry => entry.sessionId === 'session-sam'),
    'an adopted session stops being offered',
  )
})

await check('a message addressed to the user lands in the user mailbox', async () => {
  const mail = makeHarness({ officeName: 'mailroom' }, undefined, { rowId: 'office_mailroom' })
  await mail.ready
  const chief = mail.publish('session-mailroom-boss', { preset: 'office-boss' })
  mail.titles.set('session-nia', 'nia')
  const nia = mail.publish('session-nia')
  await callBoss(chief, 'mailroom', 'office_adopt', { session_id: 'session-nia' })

  // A public post that names the user is public mail: it stays in #general, and the user gets a
  // copy in the mailbox, which is the one feed that collects everything addressed to them.
  const posted = await call(nia, 'office_post', {
    text: '@user the release is blocked',
    mentions: ['user'],
    mention_all: false,
  })
  assert.equal(posted.message.channelId, 'general', 'the public record keeps the message')
  assert.deepEqual(
    posted.deliveries.map(entry => entry.status),
    ['mailbox'],
    'the user is not a session, so the outcome is the mailbox rather than a wake',
  )
  assert.equal(posted.deliveries[0].colleague, 'user')

  const state = await callRoute(routes, officeRoute('state', 'mailroom'))
  assert.deepEqual(state.payload.mailbox.map(message => message.text), ['@user the release is blocked'])
  assert.equal(state.payload.mailboxTotal, 1)
  assert.equal(state.payload.user.name, 'user', 'the panel learns which name reaches the user')
  assert.equal(state.payload.mailbox[0].kind, 'mailbox')
  assert.deepEqual(
    state.payload.mailbox[0].origin,
    { channelId: 'general', messageId: 'general-1' },
    'the copy says which channel message it came from',
  )
  assert.deepEqual(state.payload.mailbox[0].mentions, ['user'], 'and the panel can color the mention')

  // A direct message to the user is mail and nothing else: no colleague is woken, and the
  // message does not land in a two-party channel that no user session could ever read.
  const dm = await call(nia, 'office_dm', { to: 'user', text: 'and the build is red' })
  assert.equal(dm.message.channelId, 'mailbox')
  assert.equal(dm.message.messageId, 'mailbox-2')
  assert.deepEqual(dm.deliveries.map(entry => entry.status), ['mailbox'])
  assert.equal(chief.sent.length, 0, 'nothing wakes the office for a message addressed to the user')

  // The mailbox is the user's private mail: no office tool reads it, in any spelling.
  for (const channel of ['mailbox', 'user']) {
    await assert.rejects(
      () => call(nia, 'office_read', { channel }),
      /is the user's mailbox, which no office tool reads/,
    )
  }
  await assert.rejects(
    () => callBoss(chief, 'mailroom', 'office_compact', { channel: 'user', from: 1, to: 1, summary: 'not mine' }),
    /is the user's mailbox, which no office tool reads/,
    'not even compaction reads the mailbox, and it is asked through the boss, which holds the tool',
  )
  const everything = await call(nia, 'office_read', { channel: '*' })
  assert.deepEqual(
    everything.messages.map(message => message.channelId),
    ['general'],
    'a wildcard read reaches the public channel and never the mailbox',
  )
  const searched = await call(nia, 'office_read', { channel: '#general', mentions: 'user' })
  assert.deepEqual(searched.messages.map(message => message.text), ['@user the release is blocked'],
    'the user is a mention target, so filtering by it finds what named the user')

  // The panel's own post path scans the user name out of the body exactly as it scans colleagues.
  const fromPanel = await callRoute(routes, officeRoute('post', 'mailroom'), {
    method: 'POST',
    body: { text: 'please look at @user', mention_all: false },
  })
  assert.equal(fromPanel.status, 200)
  assert.deepEqual(fromPanel.payload.deliveries.map(entry => entry.status), ['mailbox'])
  const after = await callRoute(routes, officeRoute('state', 'mailroom'))
  assert.deepEqual(
    after.payload.mailbox.map(message => message.text),
    ['@user the release is blocked', 'and the build is red', 'please look at @user'],
  )
  assert.equal(after.payload.mailbox[2].senderName, 'user', 'mail the panel wrote is attributed to the user')
})

await check('the history route pages the older messages a feed folds away', async () => {
  const deep = makeHarness({ officeName: 'deepfeed' }, undefined, { rowId: 'office_deepfeed' })
  await deep.ready
  const chief = deep.publish('session-deepfeed-boss', { preset: 'office-boss' })
  for (const text of ['one', 'two', 'three', 'four', 'five']) {
    await callBoss(chief, 'deepfeed', 'office_post', { text, mentions: [] })
  }
  const snapshot = await callRoute(routes, officeRoute('state', 'deepfeed'))
  assert.equal(snapshot.payload.messagesTotal, 5, 'the snapshot reports what the feed is not showing')
  assert.equal(snapshot.payload.messages.length, 5, 'and carries the newest readLimit messages')

  const page = await callRoute(routes, `${officeRoute('history', 'deepfeed')}&channel=general&before=4&limit=2`)
  assert.equal(page.status, 200)
  assert.deepEqual(page.payload.messages.map(message => message.text), ['two', 'three'])
  assert.deepEqual(
    page.payload.messages.map(message => message.seq),
    [2, 3],
    'the panel view carries the sequence number its folded row asks below',
  )
  assert.equal(page.payload.total, 5)
  assert.equal(page.payload.truncated, true, 'one older message remains after this page')

  const oldest = await callRoute(routes, `${officeRoute('history', 'deepfeed')}&channel=general&before=2&limit=2`)
  assert.deepEqual(oldest.payload.messages.map(message => message.text), ['one'])
  assert.equal(oldest.payload.truncated, false, 'the last page says nothing older remains')

  const mailbox = await callRoute(routes, `${officeRoute('history', 'deepfeed')}&channel=mailbox`)
  assert.deepEqual(mailbox.payload.messages, [], 'the mailbox folds the same way, and is simply empty here')
  assert.equal(mailbox.payload.channelId, 'mailbox')

  assert.equal(
    (await callRoute(routes, `${officeRoute('history', 'deepfeed')}&channel=general&limit=0`)).status,
    400,
  )
  assert.equal(
    (await callRoute(routes, `${officeRoute('history', 'deepfeed')}&channel=general&before=0`)).status,
    400,
  )
})

await check('the reported model is the session selection, not the route the agent was built with', async () => {
  // `agent.options` is only the route an agent was constructed or resumed with; a model switch is
  // a `model/selection` session event that never touches it. Reporting `options` showed a live
  // office four colleagues each wearing its neighbour's model, so the projection is what is read.
  const drift = makeHarness({ officeName: 'drift' }, undefined, {
    rowId: 'office_drift',
    modelSelection: {
      'session-moved': {
        lastUsed: { provider: 'opencode-go', model: 'glm-5.3-flash' },
        pending: { provider: 'opencode-go', model: 'space-bunny-free' },
      },
      'session-settled': {
        lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        pending: null,
      },
    },
  })
  await drift.ready
  const chief = drift.publish('session-drift-boss', { preset: 'office-boss' })
  drift.titles.set('session-moved', 'moved')
  drift.titles.set('session-settled', 'settled')
  drift.publish('session-moved')
  drift.publish('session-settled')
  await callBoss(chief, 'drift', 'office_adopt', { session_id: 'session-moved' })
  await callBoss(chief, 'drift', 'office_adopt', { session_id: 'session-settled' })

  const listed = (await callBoss(chief, 'drift', 'office_colleagues', {})).colleagues
  assert.deepEqual(
    listed.map(entry => `${entry.name}=${entry.provider}/${entry.model}`),
    ['moved=opencode-go/space-bunny-free', 'settled=deepseek-official/deepseek-v4-pro'],
    'the pending selection wins, and a settled session reports the route it last used',
  )
  assert.ok(
    listed.every(entry => entry.provider !== 'probe-provider'),
    'and the route the agent was built with is never mistaken for the session current model',
  )
})

for (const label of checks) console.log(`  ok  ${label}`)
console.log(`\ndsh-office probe: ${checks.length} checks passed`)