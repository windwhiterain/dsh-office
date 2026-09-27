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

/**
 * The notes a hired leader is pointed at, resolved the way the plugin resolves them: against the
 * package the module lives in, not against the colleague's cwd.
 */
const LEADER_GUIDE = fileURLToPath(new URL('../experience/README.md', import.meta.url))
  .replaceAll('\\', '/')

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
function makeAgent(sessionId, status, cwd, preset, inbox = makeInbox(), plane = () => new Map()) {
  const tools = new Map()
  /** This agent's scope, assigned as soon as the literal below is built. */
  let self
  /**
   * The tools this agent's scope INHERITS, read at call time.
   *
   * A preset is what contributes an inherited plane, so an agent composed without one inherits
   * nothing — the state every colleague the office woke without a `setup` is in. A fake that
   * always answered the deployment's tool catalog would hide exactly that.
   */
  const inheritedNow = () => plane(self.ctx)
  /** Prompt sections registered into this agent's own scope, as `agent.ctx.systemPrompt` holds them. */
  const promptSections = new Map()
  /**
   * Restrictions this agent's scope carries, in the order they were installed.
   *
   * They intersect, exactly as the real registry's do, and they filter what this scope INHERITS:
   * the deployment's tools and never the scope's own registrations. That exemption is what the
   * office relies on when it withdraws a harness tool from a colleague it has just armed.
   */
  const restrictions = []
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
  return (self = {
    sent,
    cancels,
    tools,
    promptSections,
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
        /**
         * Resolve one tool the way this agent's scope sees it: its own registrations shadow an
         * inherited name, and a restricted-away inherited name reads as absent.
         * @param name - the tool name as registered.
         * @returns the definition this scope resolves, or undefined.
         */
        get: (name) => {
          const own = tools.get(name)
          if (own !== undefined) return own
          const admitted = restrictions.every(filter =>
            (filter.allow === undefined || filter.allow.has(name))
            && (filter.deny === undefined || !filter.deny.has(name)))
          return admitted ? inheritedNow().get(name) : undefined
        },
        /**
         * Project the surface this scope is shown, as the real registry does: own registrations
         * shadow an inherited name, and a restricted-away inherited name reads as absent. The
         * office reads this to report how many tools a colleague actually holds, so a fake without
         * it would hide the count that makes a stripped colleague visible.
         * @returns one schema per visible tool.
         */
        schemas: () => {
          const admitted = (name) => restrictions.every(filter =>
            (filter.allow === undefined || filter.allow.has(name))
            && (filter.deny === undefined || !filter.deny.has(name)))
          const visible = new Map([...inheritedNow()].filter(([name]) => admitted(name)))
          for (const [name, definition] of tools) visible.set(name, definition)
          return [...visible.values()].map(definition => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
          }))
        },
        /**
         * Mask inherited tools for this agent's scope, with the real registry's refusals: a
         * filter that names nothing, and a name this scope does not inherit, both throw. A fake
         * that accepted an unknown name would hide the deployment that mounts no question tool.
         * @param filter - the `allow`/`deny` mask.
         * @returns the exact disposer that lifts this restriction.
         */
        restrict: (filter) => {
          assert.ok(
            filter.allow !== undefined || filter.deny !== undefined,
            'restrict() requires allow and/or deny',
          )
          const unknown = [...filter.allow ?? [], ...filter.deny ?? []].filter(name => !inheritedNow().has(name))
          assert.deepEqual(unknown, [], `restrict() names unknown global tool ${unknown.join(', ')}`)
          const compiled = {
            ...filter.allow !== undefined ? { allow: new Set(filter.allow) } : {},
            ...filter.deny !== undefined ? { deny: new Set(filter.deny) } : {},
          }
          restrictions.push(compiled)
          return () => {
            const index = restrictions.indexOf(compiled)
            if (index >= 0) restrictions.splice(index, 1)
          }
        },
      },
      /**
       * The scoped injection the office arms an agent with, as `agent.ctx.inject` does: the
       * callback runs against a context carrying the injected services, and the returned fiber
       * disposes everything that callback registered. The office contributes the delivery
       * contract this way, so a fake without it would hide whether the contract is registered
       * into the agent's own scope rather than globally.
       * @param dependencies - the services the callback requires.
       * @param callback - the scoped registration.
       * @returns the fake fiber.
       */
      inject: (dependencies, callback) => {
        callback({
          systemPrompt: {
            section: (section) => {
              promptSections.set(section.name, section)
              return () => promptSections.delete(section.name)
            },
          },
        })
        return { dispose: async () => { promptSections.clear() } }
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
  })
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
/**
 * The context plane every cold resume went through, collected across every harness.
 *
 * A resume binds the agent's and its session's teardown to the accessing context's fiber, so a
 * resume through an office row makes the colleague a child of one plugin generation, and reloading
 * this plugin disposes it mid-turn. The fakes therefore accept a resume only on the process
 * context (`ctx.root`) and refuse the row plane, and the last check pins that rule.
 */
const resumePlanes = []

function makeHarness(rawConfig, loggedRoute, features = {}) {
  const tables = new Map()
  const globalTools = new Map()
  /**
   * The tools every agent of this deployment already inherits — the preset's contribution stands
   * in for it here. The office never registers into this map; it only reads it, which is how a
   * check tells "the colleague lost the harness tool" from "the office never had one to lose".
   */
  const inheritedTools = new Map()
  if (features.askUserTool === true) {
    inheritedTools.set('ask_user_question', {
      name: 'ask_user_question',
      description: 'Ask the user a concise question before proceeding.',
      parameters: { type: 'object', additionalProperties: true, properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
    })
  }
  const routes = new Map()
  const liveAgents = new Map()
  /** Warnings the office logged, so a check can tell a quiet success from a swallowed failure. */
  const warnings = []
  /** Pending input per session, which a resumed agent reattaches rather than starting empty. */
  const inboxes = new Map()
  const titles = new Map()
  /**
   * How many times a check's work folded a session's log to read one title.
   *
   * A fold is the expensive read — it resolves the session's whole history — so the panel's roster
   * must never reach for it while a title projection is readable. The count is what tells those two
   * paths apart where a name alone cannot: both answer the same string.
   */
  const titleFolds = { count: 0 }
  const resumed = []
  const hires = []
  const selects = []
  /**
   * The preset each agent's scope is bound to, as the real registry binds an agent to the
   * generation its session's preset mounted. A live colleague the office has to repair is one this
   * map has no entry for.
   */
  const presetBindings = new Map()
  /**
   * Every preset mount the office asked for, in the order it asked, with the path it came through:
   * `resume` is the `setup` a cold resume hands the harness, `recompose` is the rebind a live
   * colleague is given back. A resume that mounts nothing leaves a colleague holding no preset
   * tool at all, which is the failure this record exists to catch.
   */
  const presetMounts = []
  /** The preset ids this fake deployment declares; `personal` models a second real declaration. */
  const presetIds = ['standard', 'broken', ...(features.presets ?? [])]
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
   * The wake payloads one session's log carries, per session.
   *
   * A message the harness claims out of an inbox is appended to that session as a
   * `user/message` before the request that reads it, which is the durable answer to "did this
   * colleague receive this?". `loggedEvents` stands in for the route a session last logged and
   * answers for every session; this map is how a check places one wake in one session's log.
   */
  const carriedWakes = new Map()

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

  /**
   * The tools one agent's scope actually inherits: a preset contributes them, and an agent composed
   * without one inherits nothing. That is the whole of the failure this suite pins — a colleague
   * the office woke without a `setup` is a live agent holding the office's tools and no preset tool
   * at all — so the plane is read through the binding rather than handed to every agent.
   * @param agentCtx - the agent's own scope context.
   * @returns the inherited tool map this scope sees.
   */
  const planeOf = (agentCtx) => (presetBindings.has(agentCtx) ? inheritedTools : new Map())

  function publish(sessionId, options = {}) {
    const agent = makeAgent(
      sessionId,
      options.status ?? 'idle',
      options.cwd,
      options.preset,
      inboxOf(sessionId),
      planeOf,
    )
    // An agent the Web surface composed carries the preset its session named, and one composed
    // without a name carries the deployment default — which is what `mount` resolves an undefined
    // id to. `bound: false` models the colleague that came up without one, the state the office
    // must notice and repair.
    if (options.bound !== false) presetBindings.set(agent.ctx, options.preset ?? 'standard')
    liveAgents.set(sessionId, agent)
    for (const listener of createdListeners) listener({ agent })
    return agent
  }

  /**
   * Bring one cold session up, on whichever plane the caller reached the service through.
   *
   * The real loop builds the agent around the persisted session and runs the caller's `setup`
   * **before** publishing it, so a setup that throws publishes nothing. The session it opens is
   * the logged one, whose own preset is what a correct `setup` mounts.
   * @param options - the resume request the office sent.
   * @returns the published handle.
   */
  async function resumeAgent(options) {
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
    const agent = makeAgent(
      options.resumeSessionId,
      'idle',
      undefined,
      features.sessionPresets?.[options.resumeSessionId],
      inboxOf(options.resumeSessionId),
      planeOf,
    )
    await options.setup?.(agent.ctx, agent)
    liveAgents.set(options.resumeSessionId, agent)
    for (const listener of createdListeners) listener({ agent })
    return { agent, dispose: async () => {} }
  }

  /**
   * The agent service an office row reaches, which owns nothing.
   *
   * Reads are shared with the process plane because the real registry is one store; only a resume
   * differs, and a row-plane resume is refused rather than modelled.
   */
  const rowAgents = {
    get: sessionId => liveAgents.get(sessionId),
    list: () => [...liveAgents.values()],
    resume: () => {
      resumePlanes.push('row')
      throw new Error(
        'the office resumed a colleague through its own row context; a source reload would dispose that colleague mid-turn',
      )
    },
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
    agents: rowAgents,
    // Cordis hands every context the application root, and the office resumes a colleague
    // through it so the colleague outlives this plugin generation.
    root: {
      agents: {
        get: sessionId => liveAgents.get(sessionId),
        list: () => [...liveAgents.values()],
        resume: (options) => {
          resumePlanes.push('process')
          return resumeAgent(options)
        },
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
          readSession: async (sessionId) => ({
            events: [...(carriedWakes.get(sessionId) ?? []), ...loggedEvents],
          }),
          readTitle: async (sessionId) => {
            titleFolds.count += 1
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
        if (features.agentPresets === null) return undefined
        /**
         * Mount one preset on one agent's scope, with the real registry's two refusals: an id no
         * declaration carries, and a declaration whose rows cannot activate. A fake that mounted
         * anything would let the office strip a colleague in silence.
         * @param agentCtx - the agent's own scope context.
         * @param id - the requested preset, or undefined for the deployment default.
         */
        const mountPreset = (agentCtx, id, via) => {
          const wanted = id ?? 'standard'
          presetMounts.push({ id: wanted, via })
          if (wanted === 'broken') throw new Error(`agent preset ${wanted}: a row is waiting for a service`)
          if (!presetIds.includes(wanted)) throw new Error(`Unknown agent preset: ${wanted}`)
          presetBindings.set(agentCtx, wanted)
          return { id: wanted }
        }
        return {
          list: async () => [{ id: 'standard', name: 'Standard' }, { id: 'broken', broken: 'nope' }],
          mount: (agentCtx, id) => mountPreset(agentCtx, id, 'resume'),
          recompose: async (agentCtx, id) => mountPreset(agentCtx, id, 'recompose'),
          composedPreset: (agentCtx) => presetBindings.get(agentCtx),
        }
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
        // Only the harnesses that declare one projection per session expose the registry, so the
        // checks below can tell a read of the projection from a read of `agent.options`. The
        // `title` unit is what the Web session list displays: the latest title event a session's
        // log carries, which the `titles` rename store is the fake of, before any feature-provided
        // static titles. A registry without the unit carries no title at all. The `agentPreset`
        // unit is the real one's contract: initialized from the creation header and advanced by a
        // selection event, which is the value a resume must compose rather than the header alone.
        if (features.modelSelection === undefined && features.titles === undefined
          && features.agentPresetProjection === undefined) return undefined
        return {
          stateOf: (session, key) => {
            if (key === 'modelSelection') return features.modelSelection?.[session.header.id]
            if (key === 'title') return titles.get(session.header.id) ?? features.titles?.[session.header.id] ?? null
            if (key === 'agentPreset') {
              if (features.agentPresetProjection !== undefined) {
                return features.agentPresetProjection[session.header.id] ?? null
              }
              return session.header.agentPreset ?? null
            }
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
      if (name === 'llmQuotaRetry') {
        // The optional row the office reads a colleague's quota wait from. It answers only for the
        // harnesses that compose it, which is the deployment the office must keep working in
        // unchanged: `features.quotaRetry` maps a session id to the entry a ledger would hold for
        // it, and a check rewrites that map to move a session in and out of the wait.
        if (features.quotaRetry === undefined) return undefined
        return {
          isRetrying: session => features.quotaRetry[session.header.id] !== undefined,
          stateOf: (session) => {
            const entry = features.quotaRetry[session.header.id]
            return entry === undefined ? undefined : Object.freeze({ retrying: true, ...entry })
          },
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
    // `error` throws, because a logged error is a failure the probe must not swallow. `warn` is
    // the office's own report of a path it survived without doing its job, which a check reads
    // back rather than losing: a notice that could not be sent is exactly that.
    logger: {
      error: (message) => { throw new Error(message) },
      warn: (message) => { warnings.push(message) },
    },
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
    titleFolds,
    resumed,
    hires,
    selects,
    permissions,
    warnings,
    presetMounts,
    presetBindings,
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
    /**
     * Record one office message as already carried by a session's own log.
     *
     * This is the state the office's hold deletion has not caught up with: the step boundary
     * took the inbox copy and the session carries the message, so the hold is the only thing
     * left that says otherwise. The real loop reaches it whenever a claim and the read that
     * follows it race the office's own acknowledgement.
     * @param sessionId - the session whose log carries the wake.
     * @param messageId - the office message the wake payload belongs to.
     */
    carryInLog: (sessionId, messageId) => {
      const events = carriedWakes.get(sessionId) ?? []
      events.push({ type: 'user/message', data: { id: `office-${messageId}` } })
      carriedWakes.set(sessionId, events)
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

/**
 * Whether one live agent still resolves the harness's blocking question tool.
 * @param agent - the agent whose scope is read, exactly as the tool registry reads it.
 * @returns whether that scope sees `ask_user_question`.
 */
const seesAskUser = (agent) => {
  assert.ok(agent, 'the agent must be live')
  return agent.ctx.tools.get('ask_user_question', agent) !== undefined
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
    'office_channel_create',
    'office_channel_delete',
    'office_channel_members',
    'office_channels',
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
    'office_read_notifications',
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
  assert.deepEqual(toolNames(alice), ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'])
  assert.deepEqual(toolNames(bob), ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'])
  assert.deepEqual(toolNames(outsider), [], 'adoption does not spread to other sessions')
  const roster = await callBoss(boss, 'office', 'office_roster', {})
  assert.deepEqual(roster.colleagues.map(entry => entry.name).sort(), ['Alice Smith', 'bob'])
})

await check('an armed agent reads the delivery contract as standing prompt text', () => {
  const contractOf = agent => agent.promptSections.get('office:delivery')?.text
  // The rule a frame states one message at a time is the only office text a colleague's own
  // system prompt would otherwise never carry: its preset knows nothing about the office.
  assert.match(contractOf(boss), /only an office tool notifies a colleague/, 'the office talks to its boss too')
  assert.match(contractOf(alice), /office_dm sends one colleague a private message/)
  assert.match(contractOf(alice), /seen by the user alone/)
  assert.equal(contractOf(outsider), undefined, 'a session the office never arms carries no office prompt text')
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
  const addressed = await call(alice, 'office_dm', { wake: ['@Robert'], text: 'addressed by the new title' })
  assert.equal(addressed.message.channelId, 'dm-sessionalice+sessionbob')
  assert.deepEqual(addressed.deliveries, [{ colleague: 'Robert', status: 'delivered', colleagueStatus: 'idle' }])
  titles.set('session-bob', 'bob')
})

await check('an ambiguous session title fails loud instead of addressing one colleague', async () => {
  titles.set('session-alice', 'same')
  titles.set('session-bob', 'same')
  await assert.rejects(
    () => call(alice, 'office_post', { text: 'who?', wake: ['@same'] }),
    /matches 2 colleagues/,
  )
  titles.set('session-alice', 'Alice Smith')
  titles.set('session-bob', 'bob')
})

await check('office_post wakes the level it is given, and an empty wake writes without waking', async () => {
  const before = resumed.length
  const posted = await call(alice, 'office_post', { text: 'standup in 10', wake: ['$member'] })
  assert.deepEqual(
    posted.deliveries,
    [{ colleague: 'bob', status: 'delivered' }],
    'the lowest level reaches every colleague, which is the whole office here',
  )
  assert.equal(posted.message.channelId, 'general')
  assert.equal(
    storedMessage(harness, posted.message.messageId).audience,
    '$member',
    'the record keeps the level as the caller spelled it',
  )
  assert.equal(resumed.length, before, 'a colleague that is already live is not resumed to be notified')
  const read = await call(alice, 'office_read', { channel: '#general' })
  assert.equal(read.messages.at(-1).text, 'standup in 10')
  assert.equal(read.messages.at(-1).senderName, 'Alice Smith', 'the sender is named by its session title')

  const quiet = await call(alice, 'office_post', { text: 'quiet notice', wake: [] })
  assert.deepEqual(quiet.deliveries, [], 'an empty wake is a post that wakes nobody')
  assert.equal(
    storedMessage(harness, quiet.message.messageId).audience,
    undefined,
    'and no level or channel is recorded for an audience nobody spelled',
  )
  await assert.rejects(
    () => call(alice, 'office_post', { text: 'x' }),
    /wake is required/,
    'a post that names no audience is refused rather than waking the office by default',
  )
})

await check('office_post with a mention cold-resumes the colleague and delivers a user turn', async () => {
  const before = bob.sent.length
  const posted = await call(alice, 'office_post', { text: 'please review the diff', wake: ['@bob'] })
  assert.deepEqual(posted.deliveries, [{ colleague: 'bob', status: 'delivered' }])
  assert.equal(bob.sent.length, before + 1)
  const { via, message } = bob.sent.at(-1)
  assert.equal(via, 'followup', 'an idle colleague is woken with a followup turn')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'office-message')
  assert.equal(message.source.messageId, posted.message.messageId)
  assert.match(message.content[0].text, /^\[office #general from colleague Alice Smith/)
})

await check('a mention that matches no session title fails loud', async () => {
  await assert.rejects(
    () => call(alice, 'office_post', { text: 'hello', wake: ['@nobody'] }),
    /does not match any colleague's session title/,
  )
})

await check('notify:turn-end holds a burst and hands over one merged turn when the colleague is idle', async () => {
  const before = bob.sent.length
  bob.status = 'running'
  const dm = await call(alice, 'office_dm', { wake: ['@bob'], text: 'private note', notify: 'turn-end' })
  assert.equal(dm.message.channelId, 'dm-sessionalice+sessionbob')
  assert.deepEqual(
    dm.deliveries,
    [{ colleague: 'bob', status: 'queued', colleagueStatus: 'running' }],
    'a busy colleague is not interrupted, and the private message says so',
  )
  assert.equal(bob.sent.length, before, 'and nothing is spliced into the turn it is running')

  const second = await call(alice, 'office_post', {
    text: 'public note, same burst',
    wake: ['@bob'],
    notify: 'turn-end',
  })
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
  assert.match(frames[0], /^\[office DM from colleague Alice Smith \| wake @bob \| dm-sessionalice\+sessionbob-\d+\]$/)
  assert.match(frames[1], /^\[office #general from colleague Alice Smith \| wake @bob \| general-\d+\]$/)
  assert.match(text, /private note/)
  assert.match(text, /public note, same burst/)
  assert.ok(
    !text.includes('not because each one asks for an answer'),
    'the batch frame carries the messages, not the answering rules',
  )

  const read = await call(alice, 'office_read', { channel: 'bob' })
  assert.equal(read.channelId, 'dm-sessionalice+sessionbob')
  assert.equal(read.messages.at(-1).text, 'private note')
})

await check('the default timing steers into a running turn, for a post and for a dm alike', async () => {
  const timing = makeHarness({ officeName: 'timing' })
  await timing.ready
  const chief = timing.publish('session-timing-boss', { preset: 'office-boss' })
  timing.titles.set('session-timing-boss', 'chief')
  timing.titles.set('session-rosa', 'rosa')
  timing.titles.set('session-sam', 'sam')
  const rosa = timing.publish('session-rosa')
  const sam = timing.publish('session-sam')
  for (const sessionId of ['session-rosa', 'session-sam']) {
    await callBoss(chief, 'timing', 'office_adopt', { session_id: sessionId })
  }

  rosa.status = 'running'
  const post = await callBoss(chief, 'timing', 'office_post', { text: 'release is cut', wake: ['@rosa'] })
  assert.deepEqual(post.deliveries, [{ colleague: 'rosa', status: 'steered' }], 'a post steers by default')
  assert.equal(rosa.sent[0].via, 'steer')
  assert.equal(rosa.inbox.nextStep.length, 1, 'and the hold is what the office keeps until a step claims it')

  const dm = await callBoss(chief, 'timing', 'office_dm', { wake: ['@rosa'], text: 'and a private one' })
  assert.deepEqual(
    dm.deliveries,
    [{ colleague: 'rosa', status: 'steered', colleagueStatus: 'running' }],
    'so does a dm',
  )

  // A broadcast steers every colleague it reaches, not only a named one.
  sam.status = 'running'
  const broadcast = await callBoss(chief, 'timing', 'office_post', { text: 'standup in five', wake: ['$member'] })
  assert.deepEqual(
    broadcast.deliveries.map(entry => entry.status),
    ['steered', 'steered'],
    'the whole audience of a public post is steered, which is what the timings have to be chosen for',
  )

  // turn-end is what a caller asks for when the message can wait for the merge.
  const held = await callBoss(chief, 'timing', 'office_dm', { wake: ['@rosa'], text: 'this one can wait', notify: 'turn-end' })
  assert.deepEqual(held.deliveries, [{ colleague: 'rosa', status: 'queued', colleagueStatus: 'running' }])
  await assert.rejects(
    () => callBoss(chief, 'timing', 'office_post', { text: 'x', wake: [], notify: 'later' }),
    /office_post: notify must be one of step-end, turn-end/,
    'a timing nobody defined is refused rather than quietly defaulted',
  )

  // The idle case has no timing to choose between, so both spellings reach it now.
  rosa.status = 'idle'
  const idle = await callBoss(chief, 'timing', 'office_dm', { wake: ['@rosa'], text: 'no turn to steer' })
  assert.equal(idle.deliveries[0].status, 'delivered')
  assert.equal(rosa.sent.at(-1).via, 'followup')
})

await check('a colleague that sets do-not-disturb is not woken, and its senders are told why', async () => {
  const away = makeHarness({ officeName: 'away' }, undefined, { rowId: 'office_away' })
  await away.ready
  const chief = away.publish('session-away-boss', { preset: 'office-boss' })
  away.titles.set('session-nia', 'nia')
  away.titles.set('session-omar', 'omar')
  const nia = away.publish('session-nia')
  const omar = away.publish('session-omar')
  for (const sessionId of ['session-nia', 'session-omar']) {
    await callBoss(chief, 'away', 'office_adopt', { session_id: sessionId })
  }
  assert.ok(
    !toolNames(chief).includes('office_do_not_disturb'),
    'a boss is on no roster, so it holds no such state to set',
  )

  nia.status = 'running'
  const set = await call(nia, 'office_do_not_disturb', { enabled: true, note: 'heads down on the release cut' })
  assert.deepEqual(set.offices, ['away'], 'the result names the offices the state was written to')
  assert.equal(set.doNotDisturb, true)
  assert.equal(set.note, 'heads down on the release cut')
  assert.ok(Number.isSafeInteger(set.since), 'and the moment it was set')
  assert.equal(set.held, 0, 'nothing was waiting for the colleague yet')
  const stored = away.tables.get('colleagues').get('session-nia')
  assert.equal(stored.doNotDisturb, true, 'the state is stored on the roster record, so a restart keeps it')
  assert.equal(stored.doNotDisturbNote, 'heads down on the release cut')
  assert.equal(
    away.tables.get('colleagues').get('session-omar').doNotDisturb,
    undefined,
    'and it is the one colleague\'s own',
  )

  const before = nia.sent.length
  const post = await call(omar, 'office_post', { text: 'nia, the diff is ready', wake: ['@nia'] })
  assert.equal(post.deliveries[0].colleague, 'nia')
  assert.equal(post.deliveries[0].status, 'do-not-disturb', 'a post tells its sender that the colleague is away')
  assert.match(
    post.deliveries[0].detail,
    /set itself do-not-disturb at \d{4}-\d\d-\d\dT.* \(its reason: heads down on the release cut\)/,
    'and quotes the state it was given, so the sender can decide whether to wait',
  )
  assert.match(post.deliveries[0].detail, /held rather than delivered/)
  assert.equal(nia.sent.length, before, 'nothing opens a turn in the colleague that asked to be left alone')
  assert.equal(
    storedMessage(away, post.message.messageId).deliveries['session-nia'].status,
    'do-not-disturb',
    'the record keeps the outcome, so a later reader of the channel sees why nothing was answered',
  )

  const dm = await call(omar, 'office_dm', { wake: ['@nia'], text: 'and a private one' })
  assert.equal(dm.deliveries.length, 1)
  assert.equal(dm.deliveries[0].status, 'do-not-disturb', 'a private message reports the same outcome')
  assert.equal(dm.deliveries[0].colleagueStatus, 'running', 'beside the status the office read before the attempt')

  const roster = await call(omar, 'office_colleagues', { office: 'away' })
  const entry = roster.colleagues.find(colleague => colleague.name === 'nia')
  assert.equal(entry.doNotDisturb, true, 'the roster reports the state')
  assert.equal(entry.doNotDisturbNote, 'heads down on the release cut')
  assert.equal(entry.pending, 2, 'and the mail the state is holding')
  // The panel draws the same fact from the same read, so one badge needs no second route.
  const state = await callRoute(routes, officeRoute('state', 'away'))
  const viewed = state.payload.colleagues.find(colleague => colleague.name === 'nia')
  assert.equal(viewed.doNotDisturb, true)
  assert.equal(viewed.doNotDisturbNote, 'heads down on the release cut')

  await assert.rejects(
    () => call(nia, 'office_do_not_disturb', {}),
    /enabled must be true or false/,
    'a call that names no state is refused rather than defaulted',
  )
  await assert.rejects(() => call(nia, 'office_do_not_disturb', { enabled: 'yes' }), /enabled must be true or false/)
  await assert.rejects(
    () => call(nia, 'office_do_not_disturb', { enabled: false, note: 'still busy' }),
    /note belongs to the state being set/,
    'releasing clears the note, so one sent beside it is refused rather than dropped',
  )
  await assert.rejects(
    () => call(nia, 'office_do_not_disturb', { enabled: true, note: 'x'.repeat(501) }),
    /the limit is 500/,
  )

  // The state is a stored roster fact, so the panel's poll token moves with it and the badge appears
  // without a manual reload.
  await call(nia, 'office_do_not_disturb', { enabled: false })
  const moved = await callRoute(routes, officeRoute('state', 'away') + `&since=${state.payload.revision}`)
  assert.notEqual(moved.payload.unchanged, true, 'releasing the state moves the token the panel holds')
})

await check('a release hands over everything the state held, and the state never resumes the colleague', async () => {
  const held = makeHarness({ officeName: 'held' }, undefined, { rowId: 'office_held' })
  await held.ready
  const chief = held.publish('session-held-boss', { preset: 'office-boss' })
  held.titles.set('session-pia', 'pia')
  held.titles.set('session-quinn', 'quinn')
  const pia = held.publish('session-pia')
  const quinn = held.publish('session-quinn')
  for (const sessionId of ['session-pia', 'session-quinn']) {
    await callBoss(chief, 'held', 'office_adopt', { session_id: sessionId })
  }

  pia.status = 'running'
  await call(pia, 'office_do_not_disturb', { enabled: true, note: 'in a review' })
  await call(quinn, 'office_post', { text: 'first', wake: ['@pia'] })
  // The one delivery the office makes on nobody's behalf is the colleague's own read, and the state
  // does not take it away: it answers "do not wake me", not "do not tell me".
  const taken = await call(pia, 'office_read_notifications', {})
  assert.deepEqual(taken.notifications.map(notification => notification.text), ['first'])
  await call(quinn, 'office_post', { text: 'second', wake: ['@pia'] })
  await call(quinn, 'office_dm', { wake: ['@pia'], text: 'third' })

  const before = pia.sent.length
  const released = await call(pia, 'office_do_not_disturb', { enabled: false })
  assert.equal(released.doNotDisturb, false)
  assert.equal(released.held, 2, 'the release reports what it is about to hand over')
  assert.equal(
    held.tables.get('colleagues').get('session-pia').doNotDisturb,
    undefined,
    'and the record is cleared rather than marked false',
  )
  assert.equal(pia.sent.length, before, 'the release is not a wake: the mail waits for the turn to end')
  await held.setStatus('session-pia', 'idle')
  assert.equal(pia.sent.length, before + 1, 'one turn carries everything that was held')
  const text = pia.sent.at(-1).message.content[0].text
  assert.equal(pia.sent.at(-1).message.source.batch, 2)
  assert.match(text, /second/)
  assert.match(text, /third/)

  // A colleague that is not loaded is not resumed to be told it is away, and the state outlives the
  // agent that set it: a session brought back for another reason still finds its mail waiting.
  await call(pia, 'office_do_not_disturb', { enabled: true, note: 'back at it' })
  held.dispose(pia)
  const resumes = held.resumed.length
  const parked = await call(quinn, 'office_post', { text: 'fourth', wake: ['@pia'] })
  assert.equal(parked.deliveries[0].status, 'do-not-disturb')
  assert.equal(held.resumed.length, resumes, 'holding a message never resumes the colleague it is held for')

  const returned = held.publish('session-pia')
  await held.setStatus('session-pia', 'idle')
  assert.equal(returned.sent.length, 0, 'the state still refuses the office\'s mail to a session that came back')
  const cleared = await call(returned, 'office_do_not_disturb', { enabled: false })
  assert.equal(cleared.held, 1)
  await held.setStatus('session-pia', 'idle')
  assert.deepEqual(returned.sent.map(sent => sent.via), ['followup'], 'and releasing it delivers')
})

await check('one do-not-disturb call silences every office that holds the colleague', async () => {
  const west = makeHarness({ officeName: 'west' }, undefined, { rowId: 'office_west' })
  const east = makeHarness({ officeName: 'east' }, undefined, { rowId: 'office_east' })
  await west.ready
  await east.ready
  // One preset runs both offices, so a session that runs them is a single boss over the pair.
  const chief = west.publish('session-west-boss', { preset: 'office-boss' })
  west.titles.set('session-tess', 'tess')
  west.titles.set('session-uma', 'uma')
  east.titles.set('session-tess', 'tess')
  east.titles.set('session-vic', 'vic')
  const tess = west.publish('session-tess')
  const uma = west.publish('session-uma')
  const vic = east.publish('session-vic')
  await callBoss(chief, 'west', 'office_adopt', { session_id: 'session-tess' })
  await callBoss(chief, 'east', 'office_adopt', { session_id: 'session-tess' })
  await callBoss(chief, 'west', 'office_adopt', { session_id: 'session-uma' })
  await callBoss(chief, 'east', 'office_adopt', { session_id: 'session-vic' })

  tess.status = 'running'
  const set = await call(tess, 'office_do_not_disturb', { enabled: true, note: 'writing' })
  assert.deepEqual([...set.offices].sort(), ['east', 'west'], 'one call writes every office that holds the colleague')
  assert.equal(west.tables.get('colleagues').get('session-tess').doNotDisturb, true)
  assert.equal(east.tables.get('colleagues').get('session-tess').doNotDisturb, true)

  for (const [poster, colleague] of [[uma, 'uma'], [vic, 'vic']]) {
    const posted = await call(poster, 'office_post', { text: 'tess, a word', wake: ['@tess'] })
    assert.equal(
      posted.deliveries[0].status,
      'do-not-disturb',
      `${colleague}'s own office reads the state the other office recorded`,
    )
  }

  const released = await call(tess, 'office_do_not_disturb', { enabled: false })
  assert.equal(released.held, 2, 'the release counts what both offices were holding')
  assert.equal(west.tables.get('colleagues').get('session-tess').doNotDisturb, undefined)
  assert.equal(east.tables.get('colleagues').get('session-tess').doNotDisturb, undefined, 'and clears both records')
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
    wake: ['@nina'],
    text: 'stop: wrong branch',
    notify: 'step-end',
  })
  assert.equal(steered.deliveries[0].status, 'steered', 'a step-end wake reports the splice, not a hold')
  assert.equal(nina.sent.length, 1)
  assert.equal(nina.sent[0].via, 'steer', 'the message enters the running turn at its next step boundary')
  assert.equal(
    nina.sent[0].message.source.kind,
    'user',
    'a splice claims the kind the Web Chat draws as an in-turn message, which is what puts it in the conversation',
  )
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
    wake: ['@nina'],
    text: 'no turn to steer',
    notify: 'step-end',
  })
  assert.equal(idleDm.deliveries[0].status, 'delivered')
  assert.equal(nina.sent.at(-1).via, 'followup', 'an idle colleague is handed the message now either way')

  await assert.rejects(
    () => callBoss(chief, 'steering', 'office_dm', { wake: ['@nina'], text: 'x', notify: 'turn' }),
    /notify must be one of step-end, turn-end/,
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
    wake: ['@otto'],
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
    wake: ['@otto'],
    text: 'cancelled away',
    notify: 'step-end',
  })
  assert.equal(discarded.deliveries[0].status, 'steered')
  recovering.discardInbox('session-otto')
  await recovering.setStatus('session-otto', 'idle')
  assert.equal(otto.sent.at(-1).via, 'followup')
  assert.match(otto.sent.at(-1).message.content[0].text, /cancelled away/, 'a discarded wake is not lost')
})

await check('office_read_notifications takes what is held for its own caller, mid-turn', async () => {
  const reading = makeHarness({ officeName: 'reading' })
  await reading.ready
  const chief = reading.publish('session-reading-boss', { preset: 'office-boss' })
  reading.titles.set('session-reading-boss', 'chief')
  reading.titles.set('session-ada', 'ada')
  reading.titles.set('session-ben', 'ben')
  const ada = reading.publish('session-ada')
  const ben = reading.publish('session-ben')
  for (const sessionId of ['session-ada', 'session-ben']) {
    await callBoss(chief, 'reading', 'office_adopt', { session_id: sessionId })
  }

  // Nothing held reads as nothing, and reading never wakes anybody.
  const empty = await call(ada, 'office_read_notifications', {})
  assert.deepEqual(empty.notifications, [])
  assert.deepEqual(Object.keys(empty).sort(), ['notifications', 'office'], 'the result names the office and the mail')
  assert.equal(ada.sent.length, 0)
  assert.equal(
    ada.tools.get('office_read_notifications').output.render({}, empty)[0].text,
    '[office reading] Nothing was held for you.',
  )

  // One steered notification and one held one, addressed to ada while it works. ben is busy too,
  // so its own copy stays held for it to read or receive later. A fourth message names the group
  // channel instead, so the mail a colleague reads states every spelling a wake can be written in.
  ada.status = 'running'
  ben.status = 'running'
  const steered = await callBoss(chief, 'reading', 'office_dm', { wake: ['@ada'], text: 'the step-boundary one' })
  assert.equal(steered.deliveries[0].status, 'steered')
  const held = await callBoss(chief, 'reading', 'office_post', {
    text: 'ben and ada, this can wait',
    wake: ['@ada', '@ben'],
    notify: 'turn-end',
  })
  assert.deepEqual(held.deliveries.map(entry => entry.status), ['queued', 'queued'])
  await callBoss(chief, 'reading', 'office_post', {
    text: 'the whole office, eventually',
    wake: ['$member'],
    notify: 'turn-end',
  })
  await callBoss(chief, 'reading', 'office_channel_create', { name: 'dev', members: ['ada', 'ben'] })
  await callBoss(chief, 'reading', 'office_post', {
    channel: 'dev',
    text: 'the dev plan moved',
    wake: ['#dev'],
    notify: 'turn-end',
  })
  assert.equal(ada.inbox.nextStep.length, 1, 'the steered copy is pending input until it is taken')

  const read = await call(ada, 'office_read_notifications', {})
  assert.deepEqual(
    read.notifications.map(entry => entry.text).sort(),
    ['ben and ada, this can wait', 'the dev plan moved', 'the step-boundary one', 'the whole office, eventually'],
    'everything held for the caller is read, whatever channel it arrived on',
  )
  assert.deepEqual(
    read.notifications.map(entry => entry.wake).sort(),
    ['#dev', '$member', '@ada', '@ada @ben'].sort(),
    'the result states the wake each notification was written with, in every spelling a wake has',
  )
  assert.deepEqual(
    read.notifications.map(entry => entry.kind).sort(),
    ['dm', 'public', 'public', 'public'],
    'and the kind of record each one is',
  )
  assert.deepEqual(
    read.notifications.map(entry => entry.notify).sort(),
    ['step-end', 'turn-end', 'turn-end', 'turn-end'],
    'the timing each was held under is the timing its sender asked for',
  )
  assert.equal(
    ada.inbox.nextStep.length,
    0,
    'the pending inbox copy goes back with the hold, so no step delivers it twice',
  )

  const rendered = ada.tools.get('office_read_notifications').output.render({}, read)[0].text
  assert.match(rendered, /^\[office reading\] 4 notifications were held for you, read here on request:/)
  assert.match(
    rendered,
    /\[office DM from colleague chief \| wake @ada \| dm-\S+\]\nthe step-boundary one/,
    'each held notification states the wake its sender wrote, as a delivered frame does',
  )
  assert.match(
    rendered,
    /\[office #general from colleague chief \| wake @ada @ben \| general-\d+\] \(held until the end of your turn\)/,
    'a notification held under the non-default timing says so',
  )
  assert.match(
    rendered,
    /\[office #general from colleague chief \| wake \$member \| general-\d+\] \(held until the end of your turn\)\nthe whole office, eventually/,
    'a level wake is stated to the colleague that reads the mail',
  )
  assert.match(
    rendered,
    /\[office #dev from colleague chief \| wake #dev \| dev-\d+\] \(held until the end of your turn\)\nthe dev plan moved/,
    'and so is a channel wake, named where the reader meets the message',
  )
  assert.ok(
    !rendered.includes('Most messages need no answer'),
    'the frame carries the notification, not an answering rule',
  )

  // Taking is what makes it a delivery, and it is only ever the caller's own mail.
  const stored = storedMessage(reading, steered.message.messageId).deliveries['session-ada']
  assert.equal(stored.status, 'delivered')
  assert.match(stored.detail, /office_read_notifications/)
  const pending = await callBoss(chief, 'reading', 'office_colleagues')
  const pendingOf = (name) => pending.colleagues.find(entry => entry.name === name).pending
  assert.equal(pendingOf('ada'), 0, 'the office stops holding what was read')
  assert.equal(pendingOf('ben'), 3, 'and keeps holding what was not')

  const benRead = await call(ada, 'office_read_notifications', {})
  assert.deepEqual(benRead.notifications, [], 'ada took its own mail, and ben holds its own')
  const bens = await call(ben, 'office_read_notifications', {})
  assert.deepEqual(
    bens.notifications.map(entry => entry.text).sort(),
    ['ben and ada, this can wait', 'the dev plan moved', 'the whole office, eventually'],
    'a colleague reads its own holds, and one addressed to two colleagues is each of theirs to read',
  )
  assert.equal(ben.sent.length, 0, 'and reading wakes nobody')

  // Reading twice takes nothing the second time, and the turn the office owes nobody is owed.
  const again = await call(ada, 'office_read_notifications', {})
  assert.deepEqual(again.notifications, [])
  const steers = ada.sent.length
  await reading.setStatus('session-ada', 'idle')
  assert.equal(ada.sent.length, steers, 'nothing already handed over or read is delivered again')

  // What the office gave up is the delivery, not the message: the record keeps it.
  const record = await callBoss(chief, 'reading', 'office_read', { channel: '#general' })
  assert.ok(
    record.messages.some(message => message.text === 'ben and ada, this can wait'),
    'the message a colleague read out of its mail is still in the channel record',
  )

  // A wake the running turn already carried is dropped rather than handed over twice. The hold
  // and the session log disagree only while the office's own deletion is in flight, which is the
  // state a claim and the read that follows it race into.
  ada.status = 'running'
  const raced = await callBoss(chief, 'reading', 'office_dm', { wake: ['@ada'], text: 'already in the turn' })
  assert.equal(raced.deliveries[0].status, 'steered')
  reading.discardInbox('session-ada')
  reading.carryInLog('session-ada', raced.message.messageId)
  const afterRace = await call(ada, 'office_read_notifications', {})
  assert.deepEqual(afterRace.notifications, [], 'the hold is stale, not the message')
  const settled = await callBoss(chief, 'reading', 'office_colleagues')
  assert.equal(
    settled.colleagues.find(entry => entry.name === 'ada').pending,
    0,
    'and a stale hold is dropped rather than kept for ever',
  )
})

await check('a leader reading its held mail is told the office it is reading it in', async () => {
  const ticker = makeHarness({ officeName: 'ticker' })
  await ticker.ready
  const chief = ticker.publish('session-ticker-boss', { preset: 'office-boss' })
  ticker.titles.set('session-ticker-boss', 'chief')
  ticker.titles.set('session-ticker-lead', 'lead')
  ticker.titles.set('session-ticker-hand', 'hand')
  const lead = ticker.publish('session-ticker-lead')
  const hand = ticker.publish('session-ticker-hand')
  await callBoss(chief, 'ticker', 'office_adopt', { session_id: 'session-ticker-lead', role: 'leader' })
  await callBoss(chief, 'ticker', 'office_adopt', { session_id: 'session-ticker-hand' })

  // Both are mid-turn, so both read their own mail; the leader is handed the office as it is at
  // the call, which is the office it is deciding in.
  lead.status = 'running'
  hand.status = 'running'
  await callBoss(chief, 'ticker', 'office_post', { text: 'lead, this can wait', wake: ['@lead'], notify: 'turn-end' })
  await callBoss(chief, 'ticker', 'office_post', { text: 'hand, this too', wake: ['@hand'], notify: 'turn-end' })

  const read = await call(lead, 'office_read_notifications', {})
  assert.equal(
    read.parallelism,
    'Office parallelism: 2/2 — 2 colleague(s) in the roster, 2 working.',
    'the figure is read in the turn that asks for the mail',
  )
  assert.equal(
    read.rosterChanges,
    'Roster changed since you were last notified.',
    'the roster line is read at the call too: the member that joined after this leader was recorded moved it',
  )
  const rendered = lead.tools.get('office_read_notifications').output.render({}, read)[0].text
  assert.match(
    rendered,
    /Roster changed since you were last notified\.\n\nOffice parallelism: 2\/2 — 2 colleague\(s\) in the roster, 2 working\./,
    'the read frame orders the two lines the way a delivered frame does',
  )
  assert.ok(
    rendered.endsWith(
      "(if you need reply to your colleagues, use office tool with `wake` parameter.)",
    ),
    "the rule a frame ends with stays last",
  );

  const memberRead = await call(hand, 'office_read_notifications', {})
  assert.deepEqual(
    Object.keys(memberRead).sort(),
    ['notifications', 'office'],
    'a member is handed its mail and nothing about the office',
  )
  assert.ok(
    !hand.tools.get('office_read_notifications').output.render({}, memberRead)[0].text.includes('Office parallelism'),
  )
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
    wake: ['@otto'],
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
  const posted = await callBoss(chief, 'stopping', 'office_post', {
    text: 'ivy, please take this',
    wake: ['@ivy'],
    notify: 'turn-end',
  })
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
  const posted = await callBoss(chief, 'leaving', 'office_post', {
    text: 'dana, before you go',
    wake: ['@dana'],
    notify: 'turn-end',
  })
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
  const posted = await call(poster, 'office_dm', { wake: ['@gina'], text: 'resume on your own route' })
  assert.deepEqual(
    posted.deliveries,
    [{ colleague: 'gina', status: 'delivered', colleagueStatus: 'inactive' }],
    'the status is the one the office found, not the idle the wake made of it',
  )
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
    const posted = await call(poster, 'office_post', { text: `ping ${round}`, wake: ['@dave'] })
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
  const first = await call(user, 'office_post', { text: 'kick off', wake: ['@eve'] })
  assert.deepEqual(first.deliveries, [{ colleague: 'eve', status: 'delivered' }])
  const eve = chained.liveAgents.get('session-eve')
  const second = await call(eve, 'office_post', { text: 'your turn', wake: ['@frank'] })
  assert.deepEqual(second.deliveries, [{ colleague: 'frank', status: 'delivered' }])
  const frank = chained.liveAgents.get('session-frank')
  const third = await call(frank, 'office_post', { text: 'back to you', wake: ['@eve'] })
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
  const posted = await call(poster, 'office_post', { text: 'quiet', wake: ['@carol'] })
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
    ['office_channel_create', 'office_channel_delete', 'office_channel_members', 'office_channels',
      'office_colleagues', 'office_compact', 'office_configure', 'office_dm', 'office_do_not_disturb',
      'office_interrupt', 'office_post', 'office_read', 'office_read_notifications'],
    'the new colleague is armed with exactly the tools its role holds, in the same activation',
  )
  await assert.rejects(
    () => callBoss(boss, 'office', 'office_hire', { name: 'Unnamed Role', role: 'engineer' }),
    /role must be one of member, leader/,
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
  assert.match(text, /The office tools your scope lists are how you take part/, 'and how it takes part')
  assert.ok(
    !/You hold \d+ tools?/.test(text),
    'the greeting does not copy the tool catalog into a turn its session keeps for its whole life',
  )
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

await check('a hired leader is sent to the notes written for that seat, and a member is not', async () => {
  // The role decides the seat, so it decides whether the guide belongs in the first turn: a
  // member has no dispatching to do, and a path it will never read is noise in its onboarding.
  const lead = await callBoss(boss, 'office', 'office_hire', { name: 'Guided', role: 'leader' })
  const told = liveAgents.get(lead.colleague.sessionId).sent[0].message.content[0].text
  assert.ok(told.includes(LEADER_GUIDE), 'the leader\'s onboarding names the guide by its absolute path')
  assert.match(told, /Read them before you dispatch your first piece of work/)
  const guide = await readFile(LEADER_GUIDE, 'utf8')
  assert.match(guide, /^# /, 'and the path it names is a markdown file the package ships')
  assert.ok(guide.includes('leading.md'), 'the file it names is the index of the articles, not one of them')
  const hand = await callBoss(boss, 'office', 'office_hire', { name: 'Unguided', role: 'member' })
  const plain = liveAgents.get(hand.colleague.sessionId).sent[0].message.content[0].text
  assert.ok(!plain.includes(LEADER_GUIDE), 'a member is not pointed at the leader\'s notes')
})

await check('a colleague whose title has no ASCII form is still addressable by name', async () => {
  const named = makeHarness({ officeName: 'namedcn' }, undefined, { rowId: 'office_namedcn' })
  await named.ready
  const namedBoss = named.publish('session-named-cn-boss', { preset: 'office-boss' })
  named.titles.set('session-zhang', '张三')
  const member = named.publish('session-zhang')
  await callBoss(namedBoss, 'namedcn', 'office_adopt', { session_id: 'session-zhang' })
  assert.equal(
    (await call(member, 'office_dm', { wake: ['@张三'], text: '到' })).deliveries[0].colleague,
    '张三',
    'a title that is entirely non-ASCII still resolves, which a slug normalization would erase',
  )
  const mentioned = await callBoss(namedBoss, 'namedcn', 'office_post', { text: '@张三 请报到', wake: ['@张三'] })
  assert.deepEqual(mentioned.deliveries, [{ colleague: '张三', status: 'delivered' }])
  await assert.rejects(
    () => callBoss(namedBoss, 'namedcn', 'office_post', { text: 'x', wake: ['@张'] }),
    /"@张" does not match any colleague/,
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

await check("a broadcast wakes every colleague except the sender", async () => {
  const roster = (await callBoss(boss, "office", "office_roster", {}))
    .colleagues;
  const all = await call(alice, "office_post", {
    text: "all hands",
    wake: ["$member"],
  });
  assert.deepEqual(
    all.deliveries.map((entry) => entry.colleague).sort(),
    roster
      .map((entry) => entry.name)
      .filter((name) => name !== "Alice Smith")
      .sort(),
    "every colleague except the sender is addressed",
  );
  assert.ok(all.deliveries.every((entry) => entry.status === "delivered"));
});
await check('a delivery frame names the sender, the wake, the message, and the one rule it carries', async () => {
  await call(alice, 'office_dm', { wake: ['@bob'], text: 'private note' })
  const dmText = bob.sent.at(-1).message.content[0].text
  assert.match(
    dmText,
    /^\[office DM from colleague Alice Smith \| wake @bob \| dm-\S+\]\n\nprivate note\n\n\(if you need reply to your colleagues, use office tool with `wake` parameter\.\)$/,
    "the frame is the sender, the identity, the wake, the body, and the one line the next action depends on",
  );
  await call(alice, 'office_post', { text: 'public note', wake: ['@bob'] })
  const publicText = bob.sent.at(-1).message.content[0].text
  assert.match(
    publicText,
    /^\[office #general from colleague Alice Smith \| wake @bob \| general-\d+\]\n\npublic note\n\n\(if you need reply to your colleagues, use office tool with `wake` parameter\.\)$/,
    'and a public post states the mention it was woken by, not the level it did not use',
  )

  // The wake a colleague reads is the one the sender wrote, in whatever spelling: a level states the
  // rung, a channel states the channel, and each is the same label the panel shows for that record.
  await call(alice, 'office_post', { text: 'standup soon', wake: ['$member'] })
  assert.match(
    bob.sent.at(-1).message.content[0].text,
    /^\[office #general from colleague Alice Smith \| wake \$member \| general-\d+\]/,
    'a level wake tells the colleague which rung reached it',
  )
  const boss = liveAgents.get('session-boss')
  const channel = await callBoss(boss, 'office', 'office_channel_create', { name: 'dev', members: ['bob'] })
  assert.equal(channel.channelId, 'dev')
  await callBoss(boss, 'office', 'office_channel_members', { channel: 'dev', add: ['Alice Smith'] })
  await call(alice, 'office_post', { channel: 'dev', text: 'the dev plan moved', wake: ['#dev'] })
  assert.match(
    bob.sent.at(-1).message.content[0].text,
    /^\[office #dev from colleague Alice Smith \| wake #dev \| dev-\d+\]/,
    'a channel wake tells the colleague which channel named it',
  )

  // The paragraph that used to be appended here — silence is the normal answer, answer where the
  // message stands, never post an acknowledgement — is standing context now: a frame is written
  // into the colleague's session and re-sent with every later request for the life of that history.
  for (const [kind, text] of [['dm', dmText], ['public', publicText]]) {
    assert.ok(
      !/stays in this session|need no answer|everyone can learn from it|acknowledge a message/.test(text),
      `the ${kind} frame appends no paragraph of rules`,
    )
  }
  assert.match(
    bob.tools.get('office_post').description,
    /Silence is the normal answer to a delivered message/,
    'the answering rules are in the tool that owns them',
  )
})

await check('a leader is told how loaded the office is, and a member is not', async () => {
  const floor = makeHarness({ officeName: 'load' })
  await floor.ready
  const chief = floor.publish('session-load-boss', { preset: 'office-boss' })
  floor.titles.set('session-load-boss', 'chief')
  for (const [sessionId, title] of [
    ['session-load-lead', 'lead'],
    ['session-load-hand', 'hand'],
    ['session-load-away', 'away'],
    ['session-load-plain', 'plain'],
  ]) {
    floor.titles.set(sessionId, title)
  }
  const lead = floor.publish('session-load-lead')
  const hand = floor.publish('session-load-hand')
  const away = floor.publish('session-load-away')
  const plain = floor.publish('session-load-plain')
  await callBoss(chief, 'load', 'office_adopt', { session_id: 'session-load-lead', role: 'leader' })
  for (const sessionId of ['session-load-hand', 'session-load-away', 'session-load-plain']) {
    await callBoss(chief, 'load', 'office_adopt', { session_id: sessionId })
  }
  // An unloaded colleague is still one of the office's people: it is counted in the roster, and it
  // is not something the office can report as working.
  floor.dispose(away)

  // A leader that is idle is handed the message now, and reads the office as it was handed over.
  hand.status = 'running'
  await callBoss(chief, 'load', 'office_dm', { wake: ['@lead'], text: 'hand is on the parser' })
  const first = lead.sent.at(-1).message.content[0].text
  assert.match(
    first,
    /Office parallelism: 1\/4 — 4 colleague\(s\) in the roster, 1 working\./,
    'the roster is everyone, and the working are the ones mid-turn',
  )
  assert.match(
    first,
    /\(if you need reply to your colleagues, use office tool with `wake` parameter\.\)$/,
    "the load line sits above the one rule a frame carries",
  );

  // The line is composed per frame rather than stored with the message or cached for the office:
  // the same leader is told a different office a moment later, and the frame it already holds
  // keeps the office it was written in.
  lead.status = 'running'
  await callBoss(chief, 'load', 'office_dm', { wake: ['@lead'], text: 'while you are working' })
  assert.equal(lead.sent.at(-1).via, 'steer')
  assert.match(
    lead.sent.at(-1).message.content[0].text,
    /Office parallelism: 2\/4 — 4 colleague\(s\) in the roster, 2 working\./,
    'a leader reading a splice into its own turn is one of the working',
  )
  assert.match(first, /Office parallelism: 1\/4/, 'and the earlier frame is not rewritten')
  assert.equal(floor.claim('session-load-lead').length, 1, 'the leader takes the splice at its next step')

  // A burst held for the leader while it worked is handed over as one turn, which carries the line
  // once rather than once per message.
  await callBoss(chief, 'load', 'office_dm', { wake: ['@lead'], text: 'held one', notify: 'turn-end' })
  await callBoss(chief, 'load', 'office_post', { wake: ['@lead'], text: 'held two', notify: 'turn-end' })
  await floor.setStatus('session-load-lead', 'idle')
  const merged = lead.sent.at(-1)
  assert.equal(merged.via, 'followup')
  assert.match(merged.message.content[0].text, /^\[office load \| 2 messages arrived while you were working\]/)
  assert.match(
    merged.message.content[0].text,
    /\n\n\[office DM from colleague chief \| wake @lead \| dm-\S+\]\nheld one\n\n\[office #general from colleague chief \| wake @lead \| general-\d+\]\nheld two/,
    'each held message keeps its own header and its own wake inside the one turn',
  )
  assert.equal(
    merged.message.content[0].text.match(/Office parallelism/g).length,
    1,
    'the merged turn states the office once, however many messages it carries',
  )
  assert.match(merged.message.content[0].text, /Office parallelism: 1\/4 — 4 colleague\(s\) in the roster, 1 working\./)

  // A member is told nothing about the office: its frame is the message it has to answer.
  await callBoss(chief, 'load', 'office_dm', { wake: ['@plain'], text: 'plain, take a look' })
  const memberFrame = plain.sent.at(-1).message.content[0].text
  assert.match(memberFrame, /^\[office DM from colleague chief \| wake @plain \| dm-\S+\]\n\nplain, take a look\n\n/)
  assert.ok(
    !memberFrame.includes('Office parallelism'),
    'the office load is a leader\'s context, not a line every colleague reads',
  )
})

await check('a leader is told the roster moved, once per change and for itself alone', async () => {
  const shifts = makeHarness({ officeName: 'shifts' })
  await shifts.ready
  const chief = shifts.publish('session-shifts-boss', { preset: 'office-boss' })
  shifts.titles.set('session-shifts-boss', 'chief')
  for (const [sessionId, title] of [
    ['session-shifts-lea', 'lea'],
    ['session-shifts-lia', 'lia'],
    ['session-shifts-mal', 'mal'],
  ]) {
    shifts.titles.set(sessionId, title)
  }
  const lea = shifts.publish('session-shifts-lea')
  const lia = shifts.publish('session-shifts-lia')
  const mal = shifts.publish('session-shifts-mal')
  await callBoss(chief, 'shifts', 'office_adopt', { session_id: 'session-shifts-lea', role: 'leader' })
  await callBoss(chief, 'shifts', 'office_adopt', { session_id: 'session-shifts-lia', role: 'leader' })
  await callBoss(chief, 'shifts', 'office_adopt', { session_id: 'session-shifts-mal' })
  const frame = agent => agent.sent.at(-1).message.content[0].text

  // The member that joined after both leaders were recorded is what moved the roster, and the frame
  // that follows says so — once. The next frame has nothing to add, so it says nothing.
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@lea'], text: 'first' })
  assert.match(frame(lea), /Roster changed since you were last notified\./)
  assert.match(
    frame(lea),
    /Roster changed since you were last notified\.\n\nOffice parallelism: /,
    'the roster line comes before the load line and above the one rule the frame carries',
  )
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@lea'], text: 'second' })
  assert.ok(
    !frame(lea).includes('Roster changed'),
    'a change is reported once, not on every frame that follows it',
  )

  // The baseline is per reader: the same change reaches the second leader on its own frame rather
  // than being consumed by whoever was notified first.
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@lia'], text: 'lia, first' })
  assert.match(frame(lia), /Roster changed since you were last notified\./)

  // What a colleague is, and who a colleague is, are roster changes too: a description, a rename,
  // and a dismissal each make the office say it again.
  await callBoss(chief, 'shifts', 'office_configure', { name: 'mal', description: 'owns the parser' })
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@lea'], text: 'after the notes changed' })
  assert.match(frame(lea), /Roster changed since you were last notified\./)
  await callBoss(chief, 'shifts', 'office_adopt', { session_id: 'session-shifts-mal', name: 'mal two' })
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@lea'], text: 'after the rename' })
  assert.match(frame(lea), /Roster changed since you were last notified\./)
  await callBoss(chief, 'shifts', 'office_configure', { name: 'mal two', description: 'owns the parser' })
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@lea'], text: 'the same notes again' })
  assert.ok(
    !frame(lea).includes('Roster changed'),
    'configuring what the office already holds is not a change',
  )
  // A member is told nothing about the roster and keeps no baseline of its own: the line is a
  // leader's, and a member's frame is the message it has to answer.
  mal.sent.length = 0
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@mal two'], text: 'mal, take a look' })
  assert.ok(!frame(mal).includes('Roster changed'))
  assert.ok(!frame(mal).includes('Office parallelism'))
  assert.equal(
    shifts.tables.get('colleagues').get('session-shifts-mal').rosterSeen,
    undefined,
    'a member holds no roster baseline, because it is told nothing about the roster',
  )

  await callBoss(chief, 'shifts', 'office_dismiss', { name: 'mal two' })
  await callBoss(chief, 'shifts', 'office_dm', { wake: ['@lea'], text: 'after the dismissal' })
  assert.match(frame(lea), /Roster changed since you were last notified\./)
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
    body: { text: '$member from the panel' },
  })
  assert.equal(posted.status, 200)
  assert.ok(posted.payload.deliveries.length > 0, 'a level the panel body writes wakes the rung it names')
  assert.deepEqual(
    posted.payload.deliveries.filter(entry => entry.status !== 'delivered'),
    [],
    'and every notified colleague received it',
  )
  const after = await callRoute(routes, officeRoute('state', 'office'))
  assert.equal(after.payload.messages.at(-1).senderName, 'user')
  assert.equal(after.payload.messages.at(-1).audience, '$member', 'the panel reads back the level the post addressed')
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
    ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'],
  )

  const quiet = await callRoute(routes, officeRoute('post', 'office'), {
    method: 'POST',
    body: { text: 'all hands from the panel' },
  })
  assert.equal(quiet.status, 200)
  assert.deepEqual(
    quiet.payload.deliveries,
    [],
    'a panel body that names nobody and calls no level wakes nobody',
  )
})

await check('a panel post wakes exactly the colleagues and wake tokens its text writes', async () => {
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
    body: { text, ...extra },
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
    (await callRoute(routes, officeRoute('post', 'hall'), { method: 'POST', body: { text: '$member everyone?' } }))
      .payload.deliveries.map(entry => entry.colleague).sort(),
    ['Alice', 'Alice Smith'],
    'a level the body writes reaches its own rung and every rung above it',
  )
  assert.deepEqual(
    (await callRoute(routes, officeRoute('post', 'hall'), { method: 'POST', body: { text: '$leader everyone?' } }))
      .payload.deliveries,
    [],
    'and a level nobody holds in this office wakes nobody rather than falling back on the roster',
  )
  assert.deepEqual(
    (await callRoute(routes, officeRoute('post', 'hall'), { method: 'POST', body: { text: '#general everyone?' } }))
      .payload.deliveries.map(entry => entry.colleague).sort(),
    ['Alice', 'Alice Smith'],
    'the standing public channel is the whole roster, whoever the post woke from the panel',
  )
  assert.deepEqual(
    (await callRoute(routes, officeRoute('post', 'hall'), { method: 'POST', body: { text: 'everyone?' } }))
      .payload.deliveries,
    [],
    'a body that names nobody and calls no level wakes nobody',
  )
  const mixed = await callRoute(routes, officeRoute('post', 'hall'), {
    method: 'POST',
    body: { text: '@Alice $leader now' },
  })
  assert.equal(mixed.status, 400, 'a body that names a colleague and a level is refused rather than guessed at')
  assert.match(mixed.payload.error, /a level stands alone/)

  // The panel colors and labels what the server resolved rather than its own guess, so the feed
  // cannot show a mention or a level that decided no audience.
  const state = await callRoute(routes, officeRoute('state', 'hall'))
  assert.deepEqual(
    state.payload.messages.find(message => message.text === '@Alice Smith 请报到').mentions,
    ['Alice Smith'],
  )
  assert.deepEqual(state.payload.messages.find(message => message.text === 'no name here').mentions, [])
  assert.deepEqual(
    state.payload.messages.find(message => message.text === '@Alice Smith 请报到').channels,
    [],
    'a body that names no channel addresses none, whatever the feed holds',
  )
  assert.deepEqual(
    state.payload.messages.find(message => message.text === '#general everyone?').channels,
    ['general'],
    'and one that does is reported as the channel it addressed',
  )
  assert.equal(
    state.payload.messages.find(message => message.text === '#general everyone?').wake,
    '#general',
    'the bubble states the channel token the post addressed rather than the colleagues it reached',
  )
  assert.equal(
    state.payload.messages.find(message => message.text === '$member everyone?').wake,
    '$member',
    'and states the level token the same way',
  )
  assert.equal(
    state.payload.messages.find(message => message.text === '@Alice 你好').wake,
    '@Alice',
    'a wake that named colleagues states the names it resolved to, which is whom it reached',
  )
  assert.equal(
    state.payload.messages.find(message => message.text === 'no name here').wake,
    'nobody',
    'and a wake that reached nobody says so',
  )
  // A body that spells the mailbox or a direct channel is prose: neither is a channel a wake may
  // name, so the panel neither colors it nor wakes anybody for it.
  const prose = await post('send it to #mailbox or #dm-alice+bob please')
  assert.deepEqual(prose.payload.deliveries, [], 'a body that spells no addressable channel wakes nobody')
  const afterProse = await callRoute(routes, officeRoute('state', 'hall'))
  assert.deepEqual(
    afterProse.payload.messages.find(message => message.text === 'send it to #mailbox or #dm-alice+bob please').channels,
    [],
    'and the feed reports no channel for it, because neither token addressed one',
  )
})

await check('a stored message states the wake it was written with, in the spelling that addresses it today', async () => {
  const archive = makeHarness({ officeName: 'archive' }, undefined, { rowId: 'office_archive' })
  await archive.ready
  const archiveBoss = archive.publish('session-archive-boss', { preset: 'office-boss' })
  archive.titles.set('session-archive-ann', 'ann')
  archive.publish('session-archive-ann')
  await callBoss(archiveBoss, 'archive', 'office_adopt', { session_id: 'session-archive-ann' })
  await callBoss(archiveBoss, 'archive', 'office_post', { text: 'a record from before levels moved', wake: [] })

  // A message a deployment stored before levels moved to `$` recorded `#leader`, which `#` no
  // longer means: a channel cannot be woken under a role's name, because that spelling is refused
  // as retired, so the bubble shows the level it reached. Any other `#name` is left as the channel
  // it was.
  const stored = storedMessage(archive, 'general-1')
  assert.equal(stored.audience, undefined, 'a post that woke nobody stored no audience token')
  await archive.tables.get('messages').put('general#000000000001', { ...stored, audience: '#leader' })
  assert.equal(
    (await callRoute(routes, officeRoute('state', 'archive'))).payload.messages.at(-1).wake,
    '$leader',
    'a pre-`$` level spelling is displayed as the level it reached',
  )

  const created = await callBoss(archiveBoss, 'archive', 'office_channel_create', { name: 'dev', members: ['ann'] })
  assert.equal(created.channelId, 'dev')
  await callBoss(archiveBoss, 'archive', 'office_post', { channel: 'dev', text: 'into a group channel', wake: ['#dev'] })
  assert.equal(
    (await callRoute(routes, `${officeRoute('state', 'archive')}&channel=dev`)).payload.messages.at(-1).wake,
    '#dev',
    'while a channel wake still states the channel it named',
  )
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
  assert.equal(temp.tools.size, 7)
  assert.equal(temp.promptSections.size, 1, 'and the delivery contract with them')
  harness.dispose(temp)
  assert.equal(temp.tools.size, 0, 'the scoped registrations unwind with the agent')
  assert.equal(temp.promptSections.size, 0, 'the prompt section unwinds with them')
})

await check('office_dismiss removes a colleague and withdraws its channel tools', async () => {
  const temp = harness.publish('session-temp')
  harness.titles.set('session-temp', 'temp')
  await callBoss(boss, 'office', 'office_adopt', { session_id: 'session-temp' })
  assert.equal(temp.tools.size, 7, 'adoption arms the session')
  assert.equal(temp.promptSections.size, 1, 'and gives it the office delivery contract')
  const dismissed = await callBoss(boss, 'office', 'office_dismiss', { name: 'temp' })
  assert.deepEqual(dismissed.colleague, { name: 'temp', sessionId: 'session-temp' })
  assert.equal(temp.tools.size, 0, 'the channel tools withdraw from the live session')
  assert.equal(temp.promptSections.size, 0, 'and so does the prompt section')
  const roster = await callBoss(boss, 'office', 'office_roster', {})
  assert.ok(!roster.colleagues.some(entry => entry.sessionId === 'session-temp'))
  await assert.rejects(() => callBoss(boss, 'office', 'office_dismiss', { name: 'temp' }), /does not match any colleague/)
})

await check('a dismissed session is no longer an addressable colleague', async () => {
  await assert.rejects(
    () => call(alice, 'office_dm', { wake: ['@temp'], text: 'still there?' }),
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
    ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'],
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

  await callBoss(commander, 'alpha', 'office_post', { text: 'in alpha', wake: [] })
  await callBoss(commander, 'beta', 'office_post', { text: 'in beta', wake: [] })
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

  const posted = await call(member, 'office_post', { text: 'hello from the member', wake: [] })
  assert.equal(posted.office, 'alpha', 'the colleague is routed without naming an office')
  const feed = await callBoss(alphaBoss, 'alpha', 'office_read', { channel: '#general' })
  assert.ok(feed.messages.some(entry => entry.text === 'hello from the member'))

  const explicit = await call(member, 'office_post', { office: 'alpha', text: 'names its own office', wake: [] })
  assert.equal(explicit.office, 'alpha', 'naming its own office is accepted')
  await assert.rejects(
    () => call(member, 'office_post', { office: 'beta', text: 'leak', wake: [] }),
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
    () => call(dual, 'office_post', { text: 'ambiguous', wake: [] }),
    /belongs to 2 offices — pass office to choose one of/,
    'an ambiguous colleague is refused rather than routed to an arbitrary office',
  )
  assert.equal((await call(dual, 'office_post', { office: 'beta', text: 'to beta', wake: [] })).office, 'beta')
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
    (await call(commander, 'office_post', { office: 'beta', text: 'still here', wake: [] })).office,
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

  const posted = await callBoss(namedBoss, '总部', 'office_post', { text: 'hello', wake: [] })
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
  await assert.rejects(
    () => makeHarness(undefined, undefined, { host: true, hostConfig: { askUserRoles: ['leader'] } }).ready,
    /config\.askUserRoles has no meaning on an office host row/,
    'the host owns the tool set, but which roles keep a harness tool is each office row\'s own decision',
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

  const first = await callBoss(chief, 'failing', 'office_post', { text: 'gil, are you there?', wake: ['@gil'] })
  assert.equal(first.deliveries[0].status, 'failed', 'a wake that could not happen is reported, not hidden')
  assert.match(first.deliveries[0].detail, /resume failed for session-gil/)
  const again = await callBoss(chief, 'failing', 'office_post', { text: 'gil, again', wake: ['@gil'] })
  assert.deepEqual(again.deliveries, [{ colleague: 'gil', status: 'delivered' }], 'the next wake is unaffected')
  assert.equal(failing.liveAgents.get('session-gil').sent.length, 1, 'only the delivered wake became a turn')
})

await check('a hired colleague is greeted without the office history being replayed', async () => {
  const joining = makeHarness({ officeName: 'joining' }, undefined, { rowId: 'office_joining' })
  await joining.ready
  const chief = joining.publish('session-joining-boss', { preset: 'office-boss' })
  joining.titles.set('session-joining-boss', 'chief')
  await callBoss(chief, 'joining', 'office_post', { text: 'old decision one', wake: [] })
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
  const first = callBoss(chief, 'lagging', 'office_post', { text: 'zed, first', wake: ['@zed'] })
  await new Promise(resolve => setTimeout(resolve, 5))
  await callBoss(chief, 'lagging', 'office_post', { text: 'a second message', wake: [] })
  const posted = await first
  assert.deepEqual(posted.deliveries, [{ colleague: 'zed', status: 'delivered' }])

  const body = lagging.liveAgents.get('session-zed').sent.at(-1).message.content[0].text
  assert.match(body, /^\[office #general from colleague chief \| wake @zed \| general-1\]/)
  assert.match(body, /#general had already reached general-2 when this turn was queued/)
  assert.match(body, /when this turn was queued; newer messages are not in it\./)
  assert.ok(!body.includes('office_read reads them'), 'the staleness line states the state, not where to read next')

  // A wake that was never overtaken carries no such line: a live message and a stale one must
  // not look the same in the opposite direction either.
  const live = await callBoss(chief, 'lagging', 'office_post', { text: 'zed, live', wake: ['@zed'] })
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
  await callBoss(chief, 'library', 'office_post', { text: 'kickoff at nine', wake: [] })
  await call(ann, 'office_post', { text: 'I am on the DOCS', wake: ['$member'] })
  await callBoss(chief, 'library', 'office_post', { text: '@ann please review', wake: ['@ann'] })
  await call(ben, 'office_post', { text: 'unrelated', wake: ['$member'] })
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
    wake: '$member',
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
    await callBoss(chief, 'archive', 'office_post', { text, wake: [] })
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

  const woke = await callBoss(chief, 'archive', 'office_post', { text: 'iris, standup', wake: ['@iris'] })
  assert.deepEqual(woke.deliveries, [{ colleague: 'iris', status: 'delivered' }])
  const body = iris.sent.at(-1).message.content[0].text
  assert.ok(!body.includes('plan a'), 'a wake carries its own message and never replays the channel')
  assert.ok(!body.includes('Everything so far'), 'not even the summary that now stands for it')
  assert.match(body, /^\[office #general from colleague chief \| wake @iris \| general-4\]/)
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
  for (const role of ['member', 'leader']) {
    roles.titles.set(`session-${role}`, role)
    sessions[role] = roles.publish(`session-${role}`)
    await callBoss(chief, 'roles', 'office_adopt', {
      session_id: `session-${role}`,
      role,
      description: `the office ${role}`,
    })
  }
  assert.deepEqual(toolNames(sessions.member), ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'])
  assert.deepEqual(toolNames(sessions.leader), [
    'office_channel_create',
    'office_channel_delete',
    'office_channel_members',
    'office_channels',
    'office_colleagues',
    'office_compact',
    'office_configure',
    'office_dm',
    'office_do_not_disturb',
    'office_interrupt',
    'office_post',
    'office_read',
    'office_read_notifications',
  ])
  const roster = await callBoss(chief, 'roles', 'office_roster', {})
  assert.deepEqual(
    roster.colleagues.map(entry => `${entry.name}:${entry.role}:${entry.description}`).sort(),
    ['leader:leader:the office leader', 'member:member:the office member'],
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
    role: 'member',
    description: 'reads the record and writes no files',
  })
  assert.deepEqual(
    toolNames(dana),
    ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'],
    'a demotion withdraws the leader-only tools rather than leaving them to refuse at call time',
  )
  assert.equal(demoted.colleague.description, 'reads the record and writes no files')

  const cleared = await callBoss(chief, 'shifts', 'office_configure', { name: 'dana', description: '' })
  assert.equal(cleared.colleague.description, undefined, 'an empty description removes it')
  assert.equal(cleared.colleague.role, 'member', 'and the omitted role keeps its stored value')
  await assert.rejects(
    () => callBoss(chief, 'shifts', 'office_configure', { name: 'dana' }),
    /pass role, description, or both/,
  )
  await assert.rejects(
    () => callBoss(chief, 'shifts', 'office_configure', { name: 'nobody', role: 'member' }),
    /does not match any colleague's session title/,
  )
  // Neither role the office no longer defines may be configured: a caller that asks for one is told
  // which roles exist rather than having its label stored and read back as the default.
  for (const role of ['consultant', 'reviewer']) {
    await assert.rejects(
      () => callBoss(chief, 'shifts', 'office_configure', { name: 'dana', role }),
      /role must be one of member, leader, got/,
      `${role} is not a role this office defines`,
    )
  }
  assert.equal(
    shifts.tables.get('colleagues').get('session-dana').role,
    'member',
    'and the refused role left the colleague on the role it already held',
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
  assert.equal(
    legacy.tables.get('colleagues').get('session-old').role,
    'member',
    'the write canonicalizes the label, so storage stops carrying a role nobody can resolve',
  )

  // The role the office itself retired is stored the same way: `consultant` was a role once, and a
  // deployment that holds one must read and rewrite it as the default rather than as a permission.
  legacy.titles.set('session-cons', 'cons')
  const cons = legacy.publish('session-cons')
  await legacy.tables.get('colleagues').put('session-cons', { sessionId: 'session-cons', role: 'consultant' })
  const withConsultant = await callBoss(chief, 'legacy', 'office_roster', {})
  assert.equal(
    withConsultant.colleagues.find(entry => entry.name === 'cons').role,
    'member',
    'a stored consultant reads as the member role it was retired into',
  )
  await callBoss(chief, 'legacy', 'office_configure', { name: 'cons', description: 'kept around' })
  assert.equal(legacy.tables.get('colleagues').get('session-cons').role, 'member')
  assert.deepEqual(
    toolNames(cons),
    ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'],
    'and holds the member tool set',
  )

  await callBoss(chief, 'legacy', 'office_configure', { name: 'old', description: 'kept around' })
  const stored = legacy.tables.get('colleagues').get('session-old')
  assert.equal(stored.description, 'kept around')
  assert.ok(
    Number.isSafeInteger(stored.adoptedAt),
    'the record keeps the arrival time it already carried',
  )
  assert.deepEqual(toolNames(old), ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'])
})

await check('office_colleagues reports the roster with each colleague live status', async () => {
  const board = makeHarness(
    { officeName: 'board', rolePermissions: { member: 'read-only' } },
    undefined,
    { rowId: 'office_board' },
  )
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
  await callBoss(chief, 'board', 'office_adopt', { session_id: 'session-ben' })
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
  assert.equal(second.permission, 'read-only', 'a member session runs under the preset its role maps to')
  assert.ok(first.adoptedAt <= Date.now())

  // Reading the roster delivers nothing, and a wake the office holds for a busy colleague is
  // reported as pending rather than delivered behind its back.
  const before = ann.sent.length
  await callBoss(chief, 'board', 'office_post', { text: 'status please', wake: ['@ann'], notify: 'turn-end' })
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

await check('a colleague waiting out an exhausted quota reports a status of its own', async () => {
  // The wait a colleague cannot make progress in is not the harness's to report: the retry row holds
  // the failed step open, so the session still says `running`. The office reads the wait from that
  // row, and `entries` is what a check moves a session in and out of it with.
  const entries = { 'session-wait': { pending: true } }
  const waiting = makeHarness({ officeName: 'waiting' }, undefined, {
    rowId: 'office_waiting',
    quotaRetry: entries,
  })
  await waiting.ready
  const chief = waiting.publish('session-wait-boss', { preset: 'office-boss' })
  waiting.titles.set('session-wait', 'waiter')
  waiting.titles.set('session-busy', 'busy')
  const waiter = waiting.publish('session-wait', { status: 'running' })
  const busy = waiting.publish('session-busy', { status: 'running' })
  await callBoss(chief, 'waiting', 'office_adopt', { session_id: 'session-wait' })
  await callBoss(chief, 'waiting', 'office_adopt', { session_id: 'session-busy' })

  const statusOf = async (colleague) => {
    const listed = await call(waiter, 'office_colleagues', {})
    return listed.colleagues.find(entry => entry.name === colleague).status
  }
  assert.equal(await statusOf('waiter'), 'quota-retry', 'a wait held open reads as its own status')
  assert.equal(await statusOf('busy'), 'running', 'a colleague no ledger holds is running, as before')

  // What is reported is the armed wait. An entry outlives a cancelled turn with nothing armed, and
  // the retry request that follows it is a request in flight, so neither is a colleague held.
  entries['session-wait'] = { pending: false }
  assert.equal(await statusOf('waiter'), 'running', 'an entry with no wait armed is not a wait')
  delete entries['session-wait']
  assert.equal(await statusOf('waiter'), 'running', 'and a session the retry row has forgotten is running')

  // An unloaded colleague has no turn to hold, so it cannot be in the wait whatever a ledger says.
  entries['session-busy'] = { pending: true }
  waiting.dispose(busy)
  assert.equal(await statusOf('busy'), 'inactive', 'a session that is not loaded is not waiting either')

  // The private message carries the status the office read before it delivered, which is the call
  // whose whole subject is one colleague. That the value passes the declared schema is what says
  // `office_dm` declares the field: an undeclared one fails the result.
  entries['session-wait'] = { pending: true }
  const mailed = await callBoss(chief, 'waiting', 'office_dm', { wake: ['@waiter'], text: 'how goes it?' })
  assert.equal(mailed.deliveries.length, 1)
  assert.equal(mailed.deliveries[0].status, 'steered', 'the wait holds the turn the message is steered into')
  assert.equal(mailed.deliveries[0].colleagueStatus, 'quota-retry')
  assert.match(
    chief.tools.get('office_dm').output.render({}, mailed)[0].text,
    /\[colleague status: quota-retry\]/,
    'the private message names the state it found the colleague in',
  )

  // A post is a report of delivery outcomes, and what a colleague is belongs in the roster, so the
  // wider field the office holds never reaches that result.
  const posted = await callBoss(chief, 'waiting', 'office_post', { text: 'anyone?', wake: ['@waiter'] })
  assert.equal('colleagueStatus' in posted.deliveries[0], false, 'office_post declares no such field')

  // A deployment that composes no quota row reads the roster it always did.
  const plain = makeHarness({ officeName: 'plain' }, undefined, { rowId: 'office_plain' })
  await plain.ready
  const plainChief = plain.publish('session-plain-boss', { preset: 'office-boss' })
  plain.titles.set('session-plain', 'plain')
  const plainMember = plain.publish('session-plain', { status: 'running' })
  await callBoss(plainChief, 'plain', 'office_adopt', { session_id: 'session-plain' })
  assert.equal(
    (await call(plainMember, 'office_colleagues', {})).colleagues[0].status,
    'running',
    'without the row, the status is the harness one and nothing else changes',
  )
})

await check('the panel and the interrupt tool report the same quota wait', async () => {
  const entries = { 'session-held': { pending: true } }
  const held = makeHarness({ officeName: 'held' }, undefined, { rowId: 'office_held', quotaRetry: entries })
  await held.ready
  const chief = held.publish('session-held-boss', { preset: 'office-boss' })
  held.titles.set('session-held', 'held')
  held.publish('session-held', { status: 'running' })
  await callBoss(chief, 'held', 'office_adopt', { session_id: 'session-held' })

  const state = officeRoute('state', 'held')
  const waiting = await callRoute(routes, state)
  assert.equal(waiting.payload.colleagues[0].status, 'quota-retry', 'the roster column shows the wait')

  // Entering or leaving the wait writes nothing to the office, so the token a poll compares has to
  // read the derived status: otherwise a panel already on screen would never repaint.
  delete entries['session-held']
  const left = await callRoute(routes, `${state}&since=${encodeURIComponent(waiting.payload.revision)}`)
  assert.notEqual(left.payload.revision, waiting.payload.revision, 'leaving the wait moves the panel token')
  assert.equal(left.payload.colleagues[0].status, 'running')

  // The wait is a running turn, so it is the one state a leader may stop — and the result says
  // which state it stopped rather than calling every running turn the same.
  entries['session-held'] = { pending: true }
  const stopped = await callBoss(chief, 'held', 'office_interrupt', { name: 'held' })
  assert.deepEqual(stopped, { office: 'held', colleague: 'held', status: 'quota-retry', interrupted: true })
  assert.match(
    chief.tools.get('office_interrupt').output.render({}, stopped)[0].text,
    /wait on an exhausted account quota/,
    'the interrupt result names what it ended',
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

await check('the office leaves the harness question tool with the roles it is told to', async () => {
  const questions = makeHarness({ officeName: 'questions' }, undefined, { rowId: 'office_questions', askUserTool: true })
  await questions.ready
  const chief = questions.publish('session-q-boss', { preset: 'office-boss' })
  const sessions = {}
  for (const role of ['member', 'leader']) {
    questions.titles.set(`session-q-${role}`, role)
    sessions[role] = questions.publish(`session-q-${role}`)
  }
  // A session the office never armed keeps whatever its own preset gives it: this row's list
  // decides what the office TAKES AWAY, and it takes nothing from a session it does not talk to.
  const bystander = questions.publish('session-q-bystander')
  for (const role of ['member', 'leader']) {
    await callBoss(chief, 'questions', 'office_adopt', { session_id: `session-q-${role}`, role })
  }

  assert.ok(seesAskUser(sessions.leader), 'a leader keeps the tool the row leaves it with')
  assert.ok(seesAskUser(chief), 'and a boss is untouched: the office leaves whatever its own preset gives it')
  assert.ok(seesAskUser(bystander), 'a session with no office role is never armed, so nothing is withdrawn from it')
  assert.ok(!seesAskUser(sessions.member), 'a member asks in the user\'s mailbox, where no turn is held open')
  assert.ok(
    sessions.member.tools.has('office_post') && sessions.member.tools.has('office_dm'),
    'the withdrawal reaches the harness tool alone, not the office tools registered beside it',
  )

  // The withdrawal belongs to the office's tool set, so it is lifted with it: a session the office
  // no longer talks to is an ordinary session of the user's, and its own preset decides its tools.
  await callBoss(chief, 'questions', 'office_dismiss', { name: 'member' })
  assert.ok(seesAskUser(sessions.member), 'a dismissed colleague gets its inherited tools back with its office tools gone')
})

await check('a role change moves the question tool with the role', async () => {
  const moves = makeHarness({ officeName: 'moves' }, undefined, { rowId: 'office_moves', askUserTool: true })
  await moves.ready
  const chief = moves.publish('session-m-boss', { preset: 'office-boss' })
  moves.titles.set('session-mia', 'mia')
  const mia = moves.publish('session-mia')
  await callBoss(chief, 'moves', 'office_adopt', { session_id: 'session-mia' })
  assert.ok(!seesAskUser(mia), 'a colleague with no role given starts as a member, which asks by mail')

  await callBoss(chief, 'moves', 'office_configure', { name: 'mia', role: 'leader' })
  assert.ok(seesAskUser(mia), 'a promotion is armed in the same call, so the tool comes back with the role')
  await callBoss(chief, 'moves', 'office_configure', { name: 'mia', role: 'member' })
  assert.ok(!seesAskUser(mia), 'and a demotion takes it away again, rather than leaving it to refuse at call time')
})

await check('the offices that leave the question tool vote as a union', async () => {
  const ask = makeHarness({ officeName: 'askunion' }, undefined, { rowId: 'office_askunion', askUserTool: true })
  const quiet = makeHarness({ officeName: 'quietunion', askUserRoles: [] }, undefined, { rowId: 'office_quietunion' })
  await ask.ready
  await quiet.ready
  const askBoss = ask.publish('session-qa-boss', { preset: 'office-boss' })
  const quietBoss = quiet.publish('session-qq-boss', { preset: 'office-boss' })
  ask.titles.set('session-noa', 'noa')
  quiet.titles.set('session-noa', 'noa')
  const noa = ask.publish('session-noa')
  quiet.adoptAgent(noa)
  await callBoss(askBoss, 'askunion', 'office_adopt', { session_id: 'session-noa', role: 'leader' })
  await callBoss(quietBoss, 'quietunion', 'office_adopt', { session_id: 'session-noa', role: 'member' })

  assert.ok(
    seesAskUser(noa),
    'one office that lists the role keeps the tool, the way one office that grants a capability grants it',
  )
  await callBoss(askBoss, 'askunion', 'office_configure', { name: 'noa', role: 'member' })
  assert.ok(
    !seesAskUser(noa),
    'and the tool goes once every office that adopted the colleague leaves the role out',
  )
})

await check('a deployment with no question tool is armed without a word about it', async () => {
  const bare = makeHarness({ officeName: 'noquestions' }, undefined, { rowId: 'office_noquestions' })
  await bare.ready
  const chief = bare.publish('session-nq-boss', { preset: 'office-boss' })
  bare.titles.set('session-nda', 'nda')
  const nda = bare.publish('session-nda')
  await callBoss(chief, 'noquestions', 'office_adopt', { session_id: 'session-nda' })

  assert.ok(!seesAskUser(nda), 'there is no such tool to hold')
  assert.deepEqual(
    toolNames(nda),
    ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'],
    'and the colleague is armed exactly as before: a name the deployment never mounted is not an error',
  )
})

await check('an office row refuses a question-role list that names no colleague role', async () => {
  await assert.rejects(
    () => makeHarness({ askUserRoles: ['boss'] }).ready,
    /config\.askUserRoles names no predefined colleague role.*its preset decides/s,
    'a boss is not a colleague role: no office row decides which globals a boss holds',
  )
  await assert.rejects(
    () => makeHarness({ askUserRoles: 'leader' }).ready,
    /config\.askUserRoles must be an array of roles/,
  )
})

await check('a role maps to the session permission preset the office row declares', async () => {
  // The shipped map is empty, so a confined role is one the row declares rather than one the
  // plugin ships: this row confines its members and leaves its leaders alone.
  const perm = makeHarness(
    { officeName: 'perm', rolePermissions: { member: 'read-only' } },
    undefined,
    { rowId: 'office_perm' },
  )
  await perm.ready
  const chief = perm.publish('session-perm-boss', { preset: 'office-boss' })
  perm.titles.set('session-cons', 'cons')
  const cons = perm.publish('session-cons')
  const adopted = await callBoss(chief, 'perm', 'office_adopt', { session_id: 'session-cons', role: 'member' })
  assert.equal(adopted.colleague.permission, 'read-only')
  assert.equal(perm.permissions.get('session-cons'), 'read-only', 'the member session itself carries the preset')

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
    { officeName: 'narrow', rolePermissions: { member: 'read-only' } },
    undefined,
    { rowId: 'office_narrow', permissionPresets: ['workspace-write'] },
  )
  await narrow.ready
  const chief = narrow.publish('session-narrow-boss', { preset: 'office-boss' })
  narrow.titles.set('session-pia', 'pia')
  narrow.publish('session-pia')
  await assert.rejects(
    () => callBoss(chief, 'narrow', 'office_adopt', { session_id: 'session-pia', role: 'member' }),
    /does not define; available: workspace-write/,
  )
  assert.deepEqual(
    (await callBoss(chief, 'narrow', 'office_roster', {})).colleagues,
    [],
    'the refused colleague left no record behind with a restriction nobody enforces',
  )

  const bare = makeHarness(
    { officeName: 'bare', rolePermissions: { member: 'read-only' } },
    undefined,
    { rowId: 'office_bare', permissionPresets: null },
  )
  await bare.ready
  const bareBoss = bare.publish('session-bare-boss', { preset: 'office-boss' })
  bare.titles.set('session-quinn', 'quinn')
  bare.publish('session-quinn')
  await assert.rejects(
    () => callBoss(bareBoss, 'bare', 'office_hire', { name: 'quinn', role: 'member' }),
    /mounts no permission presets/,
  )
})

await check('an office row refuses a rolePermissions map it cannot act on', async () => {
  await assert.rejects(
    () => makeHarness({ officeName: 'badrole', rolePermissions: { chief: 'read-only' } }).ready,
    /config\.rolePermissions\.chief names no predefined role/,
  )
  await assert.rejects(
    () => makeHarness({ officeName: 'retiredrole', rolePermissions: { consultant: 'read-only' } }).ready,
    /config\.rolePermissions\.consultant names no predefined role; it takes member, leader/,
    'the role the office retired is not a predefined role, so a row cannot confine a colleague to it',
  )
  await assert.rejects(
    () => makeHarness({ officeName: 'badpreset', rolePermissions: { member: '  ' } }).ready,
    /config\.rolePermissions\.member must name a permission preset/,
  )
  await assert.rejects(
    () => makeHarness({ officeName: 'badvalue', rolePermissions: 'read-only' }).ready,
    /config\.rolePermissions must be an object mapping a role to a permission preset/,
  )
  await assert.rejects(
    () => makeHarness(undefined, undefined, {
      host: true,
      hostConfig: { rolePermissions: { member: 'read-only' } },
    }).ready,
    /has no meaning on an office host row/,
    'the mapping belongs to an office, and the host refuses the field rather than ignoring it',
  )
})

await check('a confined colleague speaks into the office while its session runs read-only', async () => {
  const quiet = makeHarness(
    { officeName: 'quiet', rolePermissions: { member: 'read-only' } },
    undefined,
    { rowId: 'office_quiet' },
  )
  await quiet.ready
  const chief = quiet.publish('session-quiet-boss', { preset: 'office-boss' })
  quiet.titles.set('session-rose', 'rose')
  const rose = quiet.publish('session-rose')
  const hired = await callBoss(chief, 'quiet', 'office_adopt', {
    session_id: 'session-rose',
    role: 'member',
    description: 'reads and advises',
  })
  assert.equal(hired.colleague.permission, 'read-only', 'the preset is the session restriction, not the voice')

  // The rule about answering in public is standing context, not part of the frame: a frame is
  // written into the colleague's session and re-sent with every later request.
  await callBoss(chief, 'quiet', 'office_post', { text: 'any advice? mention me if so', wake: ['@rose'] })
  const frame = rose.sent.at(-1).message.content[0].text
  assert.ok(!frame.includes('everyone can learn from it'), 'the frame carries the message alone')
  assert.match(
    rose.tools.get('office_post').description,
    /Silence is the normal answer to a delivered message/,
    'and the colleague holds the tool that states the rule',
  )

  const spoken = await call(rose, 'office_post', { text: 'advice: the summary is settled', wake: [] })
  assert.equal(spoken.message.channelId, 'general', 'a confined colleague writes into the office like any member')
  const read = await callBoss(chief, 'quiet', 'office_read', { channel: '#general' })
  assert.equal(read.messages.at(-1).text, 'advice: the summary is settled')

  const greeting = await callBoss(chief, 'quiet', 'office_hire', { name: 'sage', role: 'member' })
  const greeted = quiet.liveAgents.get(greeting.colleague.sessionId)
  const text = greeted.sent[0].message.content[0].text
  assert.match(text, /Your role: member\./)
  assert.match(text, /your role decides which you hold/, 'the greeting points at the scope, not at a copied catalog')
  assert.ok(!text.includes('You hold no tool that writes into the office'), 'a confined member holds the messaging tools')
})

await check('the panel snapshot offers the roles, and the configure route edits a colleague', async () => {
  // The panel offers the roles the office defines, each with the preset the row maps it to, so a
  // dialog can say what choosing a role does to that colleague's session.
  const panel = makeHarness(
    { officeName: 'paneledit', rolePermissions: { member: 'read-only' } },
    undefined,
    { rowId: 'office_paneledit' },
  )
  await panel.ready
  const chief = panel.publish('session-paneledit-boss', { preset: 'office-boss' })
  panel.titles.set('session-pia', 'pia')
  const pia = panel.publish('session-pia')
  await callBoss(chief, 'paneledit', 'office_adopt', { session_id: 'session-pia' })

  const state = await callRoute(routes, officeRoute('state', 'paneledit'))
  assert.equal(state.status, 200)
  assert.deepEqual(
    state.payload.roles,
    [{ id: 'member', permission: 'read-only' }, { id: 'leader' }],
    'each role travels with the preset the office row maps it to',
  )
  const bare = await callRoute(routes, officeRoute('state', 'office'))
  assert.deepEqual(
    bare.payload.roles,
    [{ id: 'member' }, { id: 'leader' }],
    'the shipped map is empty, so a row that declares no mapping confines no role',
  )
  assert.deepEqual(
    state.payload.colleagues.map(entry => `${entry.name}:${entry.role}:${entry.status}`),
    ['pia:member:idle'],
    'the roster the panel draws carries the role and the live status',
  )

  const configured = await callRoute(routes, officeRoute('configure', 'paneledit'), {
    method: 'POST',
    body: { name: 'pia', role: 'leader', description: 'keeps the record' },
  })
  assert.equal(configured.status, 200, `configure refused: ${JSON.stringify(configured.payload)}`)
  assert.equal(configured.payload.colleague.role, 'leader')
  assert.equal(
    configured.payload.colleague.permission,
    undefined,
    'a role the row maps to no preset reports none, because it leaves the session permission alone',
  )
  assert.ok(pia.tools.has('office_interrupt'), 'the panel edit reaches the live session exactly as the tool does')
  const refused = await callRoute(routes, officeRoute('configure', 'paneledit'), {
    method: 'POST',
    body: { name: 'pia', role: 'reviewer' },
  })
  assert.equal(refused.status, 400)
  assert.match(refused.payload.error, /role must be one of member, leader/)
  const retired = await callRoute(routes, officeRoute('configure', 'paneledit'), {
    method: 'POST',
    body: { name: 'pia', role: 'consultant' },
  })
  assert.equal(retired.status, 400, 'the role the office retired cannot be configured back through the panel')
  assert.match(retired.payload.error, /role must be one of member, leader/)
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
    ['office_channels', 'office_colleagues', 'office_dm', 'office_do_not_disturb', 'office_post', 'office_read', 'office_read_notifications'],
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
    wake: ['@user'],
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
  const dm = await call(nia, 'office_dm', { wake: ['@user'], text: 'and the build is red' })
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
    body: { text: 'please look at @user' },
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
    await callBoss(chief, 'deepfeed', 'office_post', { text, wake: [] })
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

await check('the boss and the leaders manage channels, whose members decide who reads and who wakes', async () => {
  // A fresh office mounts into the shared harness, so the checks run on a roster of their own
  // while the one host keeps serving the routes the panel asks for.
  harness.ctx.fiber.entry.options.id = 'office_teams'
  await apply(harness.ctx, { officeName: 'teams' })
  harness.titles.set('session-teams-boss', 'chief')
  harness.titles.set('session-lea', 'lea')
  harness.titles.set('session-mia', 'mia')
  const chief = harness.publish('session-teams-boss', { preset: 'office-boss' })
  const lea = harness.publish('session-lea')
  const mia = harness.publish('session-mia')
  await callBoss(chief, 'teams', 'office_adopt', { session_id: 'session-lea', role: 'leader' })
  await callBoss(chief, 'teams', 'office_adopt', { session_id: 'session-mia' })
  assert.ok(lea.tools.has('office_channel_create'), 'a leader holds the channel-management tools')
  assert.ok(!mia.tools.has('office_channel_create'), 'a member holds none of them')
  await assert.rejects(
    () => call(mia, 'office_channel_create', { office: 'teams', name: 'shadow' }),
    /tool office_channel_create must be installed/,
    'a member never reaches a management tool',
  )

  const created = await call(lea, 'office_channel_create', { office: 'teams', name: 'Release Log', members: ['mia'] })
  assert.equal(created.channelId, 'release-log', 'the spelling is normalized into the id the other tools address')
  assert.deepEqual(created.members, ['mia'])
  for (const bad of ['general', 'mailbox', 'dm-x']) {
    await assert.rejects(
      () => call(lea, 'office_channel_create', { office: 'teams', name: bad }),
      /reserved channel id/,
      `${bad} is not an id a group channel may take`,
    )
  }
  await assert.rejects(
    () => call(lea, 'office_channel_create', { office: 'teams', name: 'release-log' }),
    /already exists/,
    'a second channel of one id would be unaddressable',
  )
  await assert.rejects(
    () => call(lea, 'office_channel_create', { office: 'teams', name: 'empty', members: ['nobody'] }),
    /does not match any colleague's session title/,
    'a typo fails instead of building a channel nobody can reach',
  )
  assert.deepEqual(
    (await callBoss(chief, 'teams', 'office_roster', {})).channels.map(entry => entry.channelId),
    ['general', 'mailbox', 'release-log'],
    'the boss sees every channel, the mailbox included',
  )

  const listed = await call(mia, 'office_channels', { office: 'teams' })
  assert.deepEqual(
    listed.channels.map(channel => channel.channelId).sort(),
    ['general', 'release-log'],
    'a member reads the channels its membership admits',
  )
  assert.ok(listed.channels.every(channel => channel.kind !== 'mailbox'), 'the mailbox is refused everywhere')
  const wide = await call(lea, 'office_channels', { office: 'teams' })
  assert.deepEqual(
    wide.channels.filter(channel => channel.kind === 'group').map(channel => channel.channelId),
    [],
    'a leader reads only the channels it is a member of, like any other colleague',
  )
  assert.deepEqual(
    (await callBoss(chief, 'teams', 'office_channels', {})).channels.filter(channel => channel.kind === 'group')
      .map(channel => channel.channelId),
    ['release-log'],
    'the boss is privy to every channel it manages',
  )

  // The audience of a post is the channel's own members; the boss may write anywhere.
  await callBoss(chief, 'teams', 'office_channel_create', { name: 'wakecheck', members: ['mia'] })
  const before = [lea.sent.length, mia.sent.length]
  const broadcast = await callBoss(chief, 'teams', 'office_post', { channel: '#wakecheck', text: 'the release notes are ready', wake: ['$member'] })
  assert.deepEqual(
    broadcast.deliveries.map(entry => entry.colleague),
    ['mia'],
    'a broadcast there wakes exactly the subscribed colleagues',
  )
  assert.equal(broadcast.message.channelId, 'wakecheck')
  assert.ok(mia.sent.length > before[1], 'a member is woken')
  assert.equal(lea.sent.length, before[0], 'and nobody else is, not even the boss preset\'s other ties')
  const frame = mia.sent.at(-1).message.content[0].text
  assert.ok(
    !frame.includes('everyone can learn from it'),
    'the frame names the message, not the rule it used to carry',
  )
  assert.match(
    mia.tools.get('office_post').description,
    /answer a message where it stands/,
    'the standing rule tells a colleague to answer in the channel the message arrived on',
  )
  const read = await call(mia, 'office_read', { office: 'teams', channel: '#wakecheck' })
  assert.equal(read.messages.at(-1).text, 'the release notes are ready')
  await assert.rejects(
    () => call(lea, 'office_read', { office: 'teams', channel: 'wakecheck' }),
    /not a channel this session is a member of/,
    'a non-member is refused through any spelling it guesses',
  )
  await assert.rejects(
    () => call(lea, 'office_post', { office: 'teams', channel: 'wakecheck', text: 'sneak post', wake: ['$member'] }),
    /not a member of that channel/,
    'and cannot reach the channel through writing either',
  )
  const wildcard = await call(lea, 'office_read', { office: 'teams', channel: '*' })
  assert.ok(!wildcard.messages.some(message => message.messageId.startsWith('wakecheck-')),
    'the wildcard walks only the channels the caller can read')
})

await check('office_channel_members edits the roster, the routes mirror the tools, and deletion cleans up', async () => {
  // Another fresh office of the shared harness keeps the deletion checks off the last one.
  harness.ctx.fiber.entry.options.id = 'office_cleanup'
  await apply(harness.ctx, { officeName: 'cleanup' })
  harness.titles.set('session-cleanup-boss', 'chief')
  harness.titles.set('session-nia', 'nia')
  harness.titles.set('session-tim', 'tim')
  const chief = harness.publish('session-cleanup-boss', { preset: 'office-boss' })
  const nia = harness.publish('session-nia')
  const tim = harness.publish('session-tim')
  await callBoss(chief, 'cleanup', 'office_adopt', { session_id: 'session-nia' })
  await callBoss(chief, 'cleanup', 'office_adopt', { session_id: 'session-tim' })

  // Membership decides both readability and the wake list, and the tool edits it.
  await callBoss(chief, 'cleanup', 'office_channel_create', { name: 'shortlived', members: ['nia', 'tim'] })
  const edited = await callBoss(chief, 'cleanup', 'office_channel_members', { channel: 'shortlived', remove: ['tim'] })
  assert.deepEqual(edited.members, ['nia'], 'a removal takes the member out of the stored record')
  await assert.rejects(
    () => call(tim, 'office_read', { office: 'cleanup', channel: 'shortlived' }),
    /not a channel this session is a member of/,
    'a removed member loses the channel, not merely a refusal',
  )
  await assert.rejects(
    () => callBoss(chief, 'cleanup', 'office_channel_members', { channel: 'mailbox', add: ['nia'] }),
    /not a group channel/,
  )
  await assert.rejects(
    () => callBoss(chief, 'cleanup', 'office_channel_members', { channel: 'shortlived', add: ['user'] }),
    /cannot be a channel member/,
    'the user holds no session and is never a member',
  )

  // A member of the channel that is mid-turn holds the delivery; the channel must not strand it.
  await harness.setStatus('session-nia', 'running')
  await callBoss(chief, 'cleanup', 'office_post', {
    channel: 'shortlived',
    text: 'held while nia works',
    wake: ['$member'],
    notify: 'turn-end',
  })
  await callBoss(chief, 'cleanup', 'office_channel_delete', { channel: 'shortlived' })
  assert.equal(
    [...harness.tables.get('messages').keys()].filter(key => key.startsWith('shortlived#')).length,
    0,
    'the messages went with the channel',
  )
  assert.equal([...harness.tables.get('pending').keys()].length, 0, 'and nothing is held for a feed that no longer exists')
  await harness.setStatus('session-nia', 'idle')
  await assert.rejects(
    () => call(nia, 'office_read', { office: 'cleanup', channel: 'shortlived' }),
    /neither "#general", a known colleague, nor a known channel/,
    'a deleted channel resolves to nothing',
  )

  // The panel routes are the same operations the tools run, with members named by title.
  const created = await callRoute(routes, '/dsh-office/offices/channels/create?office=cleanup', {
    method: 'POST',
    body: { name: 'routed', topic: 'born from the panel' },
  })
  assert.equal(created.status, 200)
  assert.equal(created.payload.channelId, 'routed')
  const state = await callRoute(routes, '/dsh-office/offices/state?office=cleanup&channel=routed')
  assert.equal(state.payload.channel, 'routed', 'the snapshot serves the channel the feed asked for')
  assert.deepEqual(state.payload.messages, [], 'a channel opens empty')
  await callRoute(routes, officeRoute('post', 'cleanup'), {
    method: 'POST',
    body: { text: 'panel post into a channel', channel: 'routed' },
  })
  const history = await callRoute(routes, '/dsh-office/offices/history?office=cleanup&channel=routed&before=99&limit=50')
  assert.equal(history.payload.total, 1, 'the history pages a group channel by its own sequence')

  const configuration = await callRoute(routes, '/dsh-office/offices/channels/configure?office=cleanup', {
    method: 'POST',
    body: { channel: 'routed', topic: 'edited topic', members: { add: ['tim'] } },
  })
  assert.equal(configuration.status, 200, `configure refused: ${JSON.stringify(configuration.payload)}`)
  assert.deepEqual(configuration.payload.members, ['tim'])
  assert.deepEqual(
    (await call(tim, 'office_read', { office: 'cleanup', channel: 'routed' })).messages.at(-1).text,
    'panel post into a channel',
    'a member added through the panel reads the channel like any member',
  )
  const deleted = await callRoute(routes, '/dsh-office/offices/channels/delete?office=cleanup', {
    method: 'POST',
    body: { channel: 'routed' },
  })
  assert.equal(deleted.status, 200)
  const afterDelete = await callRoute(routes, '/dsh-office/offices/state?office=cleanup&channel=routed')
  assert.equal(afterDelete.payload.channel, 'general', 'the state route falls back to the public feed')
})

await check('an idle office asks its leaders what comes next, and only when something new happened', async () => {
  const idle = makeHarness(
    { officeName: 'idle', idleNotice: { enabled: true, text: 'the office stopped; leaders, decide' } },
    undefined,
    { rowId: 'office_idle' },
  )
  await idle.ready
  idle.titles.set('session-idle-boss', 'chief')
  idle.titles.set('session-idle-lead', 'lead')
  idle.titles.set('session-idle-hand', 'hand')
  const chief = idle.publish('session-idle-boss', { preset: 'office-boss' })
  const lead = idle.publish('session-idle-lead')
  const hand = idle.publish('session-idle-hand')
  await callBoss(chief, 'idle', 'office_adopt', { session_id: 'session-idle-lead', role: 'leader' })
  await callBoss(chief, 'idle', 'office_adopt', { session_id: 'session-idle-hand' })

  /** The messages the office itself wrote, oldest first. */
  const notices = () => [...idle.tables.get('messages').entries()]
    .map(([, value]) => value)
    .filter(message => message.senderName === 'office')
    .sort((left, right) => left.createdAt - right.createdAt)

  // Nothing was ever said in this office, so there is nothing to decide and nobody to ask.
  await idle.setStatus('session-idle-lead', 'running')
  await idle.setStatus('session-idle-lead', 'idle')
  assert.equal(notices().length, 0, 'an office with no history has nothing to ask about')

  // Work happened, and the last colleague to stop leaves the office idle with a question to ask.
  // The post wakes nobody, so every delivery below belongs to the notice itself.
  await callBoss(chief, 'idle', 'office_post', { text: 'the release is cut', wake: [] })
  await idle.setStatus('session-idle-lead', 'running')
  await idle.setStatus('session-idle-lead', 'idle')
  const asked = notices()
  assert.equal(asked.length, 1, 'the office asks once the last colleague has stopped')
  assert.equal(asked[0].channelId, 'general', 'the question is part of the office record')
  assert.equal(asked[0].text, 'the office stopped; leaders, decide')
  assert.deepEqual(asked[0].recipients, ['session-idle-lead'], 'only a leader is addressed')
  assert.equal(
    asked[0].audience,
    '$leader',
    'the shipped default is the leader level, so a row that configures no wake still asks the leaders',
  )
  assert.equal(lead.sent.length, 1, 'the leader is woken with the question')
  assert.equal(lead.sent[0].via, 'followup')
  assert.match(lead.sent[0].message.content[0].text, /the office stopped; leaders, decide/)
  assert.equal(hand.sent.length, 0, 'a member is not woken by the office asking its leaders')

  // The brake: asking again would be the only thing that ever happens, so the office asks once
  // and waits until somebody writes something new.
  await idle.setStatus('session-idle-hand', 'running')
  await idle.setStatus('session-idle-hand', 'idle')
  assert.equal(notices().length, 1, 'the notice does not repeat without new work')
  assert.equal(lead.sent.length, 1, 'and nobody is woken a second time')

  // A colleague's post is work, so the next time the office stops there is something to decide.
  await call(hand, 'office_post', { office: 'idle', text: 'the migration notes are done', wake: ['@lead'] })
  await idle.setStatus('session-idle-lead', 'running')
  await idle.setStatus('session-idle-lead', 'idle')
  assert.equal(notices().length, 2, 'new work arms the next notice')

  // The office is not idle while one colleague is still working, which is the whole condition.
  await call(hand, 'office_dm', { office: 'idle', wake: ['@lead'], text: 'one more thing' })
  await idle.setStatus('session-idle-hand', 'running')
  await idle.setStatus('session-idle-lead', 'idle')
  assert.equal(notices().length, 2, 'a colleague that is still working means the office has not stopped')
  await idle.setStatus('session-idle-hand', 'idle')
  assert.equal(notices().length, 3, 'and the office asks once it really has stopped')

  // A status change is process-wide, so a session that is not a colleague must not be mistaken
  // for one. The stranger's turn asks nothing, and the colleague that follows it proves the
  // office was armed to ask and simply was not asked by a stranger's transition.
  idle.publish('session-idle-stranger')
  await call(hand, 'office_dm', { office: 'idle', wake: ['@lead'], text: 'and one more' })
  await idle.setStatus('session-idle-stranger', 'running')
  await idle.setStatus('session-idle-stranger', 'idle')
  assert.equal(notices().length, 3, 'a session outside the roster asks nothing')
  await idle.setStatus('session-idle-lead', 'running')
  await idle.setStatus('session-idle-lead', 'idle')
  assert.equal(notices().length, 4, 'while the office asking after its own colleague does')

  // What the office asked last is stored rather than remembered, so a restart is not a reason to
  // ask the same question again.
  await idle.close()
  idle.ctx.fiber.entry.options.id = 'office_idle'
  await apply(idle.ctx, {
    officeName: 'idle',
    idleNotice: { enabled: true, text: 'the office stopped; leaders, decide' },
  })
  await settle()
  assert.equal(notices().length, 4, 'a restart with nothing new to decide asks nothing')
})

await check('the idle notice needs an audience it can reach, a colleague, and a channel that exists', async () => {
  // An office of members only has nobody its default wake reaches, and must not guess at a substitute.
  const headless = makeHarness({ officeName: 'headless', idleNotice: { enabled: true } }, undefined, {
    rowId: 'office_headless',
  })
  await headless.ready
  headless.titles.set('session-headless-boss', 'chief')
  headless.titles.set('session-headless-hand', 'hand')
  const headlessChief = headless.publish('session-headless-boss', { preset: 'office-boss' })
  const headlessHand = headless.publish('session-headless-hand')
  await callBoss(headlessChief, 'headless', 'office_adopt', { session_id: 'session-headless-hand' })
  await callBoss(headlessChief, 'headless', 'office_post', { text: 'nobody leads this office', wake: [] })
  await headless.setStatus('session-headless-hand', 'running')
  await headless.setStatus('session-headless-hand', 'idle')
  assert.equal(
    [...headless.tables.get('messages').entries()].filter(([, message]) => message.senderName === 'office').length,
    0,
    'an office with no leader has nobody to ask',
  )

  // `wakesEnabled: false` is a promise that no session is ever woken, and a question nobody is
  // woken for is not a question.
  const mute = makeHarness({ officeName: 'mute', wakesEnabled: false, idleNotice: { enabled: true } }, undefined, {
    rowId: 'office_mute',
  })
  await mute.ready
  mute.titles.set('session-mute-boss', 'chief')
  mute.titles.set('session-mute-lead', 'lead')
  const muteChief = mute.publish('session-mute-boss', { preset: 'office-boss' })
  const muteLead = mute.publish('session-mute-lead')
  await callBoss(muteChief, 'mute', 'office_adopt', { session_id: 'session-mute-lead', role: 'leader' })
  await callBoss(muteChief, 'mute', 'office_post', { text: 'stored, never delivered', wake: [] })
  await mute.setStatus('session-mute-lead', 'running')
  await mute.setStatus('session-mute-lead', 'idle')
  assert.equal(muteLead.sent.length, 0, 'a silent office wakes nobody')
  assert.equal(
    [...mute.tables.get('messages').entries()].filter(([, message]) => message.senderName === 'office').length,
    0,
    'and stores no question of its own',
  )

  // A configured channel the office does not hold is reported rather than dropped: the office
  // keeps asking at the next idle transition, and the operator has something to read.
  const lost = makeHarness({ officeName: 'lost', idleNotice: { enabled: true, channel: 'nowhere' } }, undefined, {
    rowId: 'office_lost',
  })
  await lost.ready
  lost.titles.set('session-lost-boss', 'chief')
  lost.titles.set('session-lost-lead', 'lead')
  const lostChief = lost.publish('session-lost-boss', { preset: 'office-boss' })
  lost.publish('session-lost-lead')
  await callBoss(lostChief, 'lost', 'office_adopt', { session_id: 'session-lost-lead', role: 'leader' })
  await callBoss(lostChief, 'lost', 'office_post', { text: 'somewhere to ask', wake: [] })
  await lost.setStatus('session-lost-lead', 'running')
  await lost.setStatus('session-lost-lead', 'idle')
  assert.match(lost.warnings.join('\n'), /the idle notice failed: .*unknown channel "nowhere"/)
})

await check('an office row refuses an idleNotice it could never send', async () => {
  await assert.rejects(() => makeHarness({ idleNotice: 'yes' }).ready, /idleNotice must be an object/)
  await assert.rejects(
    () => makeHarness({ idleNotice: { who: 'leaders' } }).ready,
    /idleNotice\.who has no meaning/,
    'an unknown key would look configured while doing nothing',
  )
  await assert.rejects(() => makeHarness({ idleNotice: { enabled: 'yes' } }).ready, /idleNotice\.enabled must be a boolean/)
  for (const channel of ['mailbox', 'dm-a+b', '  ']) {
    await assert.rejects(
      () => makeHarness({ idleNotice: { channel } }).ready,
      /idleNotice\.channel must name a channel of the office/,
      `${JSON.stringify(channel)} is not a channel the office can post to`,
    )
  }
  await assert.rejects(() => makeHarness({ idleNotice: { text: '   ' } }).ready, /must be a non-empty message body/)
  await assert.rejects(
    () => makeHarness(undefined, undefined, { host: true, hostConfig: { idleNotice: {} } }).ready,
    /config\.idleNotice has no meaning on an office host row/,
    'the notice belongs to an office, not to the host that owns the tool set',
  )
  // The defaults are the safe ones: an office row that says nothing about the notice never asks.
  const quiet = makeHarness({ officeName: 'quiet' }, undefined, { rowId: 'office_quiet' })
  await quiet.ready
  quiet.titles.set('session-quiet-boss', 'chief')
  quiet.titles.set('session-quiet-lead', 'lead')
  const quietChief = quiet.publish('session-quiet-boss', { preset: 'office-boss' })
  const quietLead = quiet.publish('session-quiet-lead')
  await callBoss(quietChief, 'quiet', 'office_adopt', { session_id: 'session-quiet-lead', role: 'leader' })
  await callBoss(quietChief, 'quiet', 'office_post', { text: 'work, unasked', wake: [] })
  await quiet.setStatus('session-quiet-lead', 'running')
  await quiet.setStatus('session-quiet-lead', 'idle')
  assert.equal(quietLead.sent.length, 0, 'a row that never opts in never asks')
})

await check('a wake level reaches its own rung and every rung above it', async () => {
  const ranks = makeHarness({ officeName: 'ranks' }, undefined, { rowId: 'office_ranks' })
  await ranks.ready
  const chief = ranks.publish('session-ranks-boss', { preset: 'office-boss' })
  const seated = new Map()
  for (const [sessionId, title] of [
    ['session-ranks-member', 'minnie'],
    ['session-ranks-second', 'manny'],
    ['session-ranks-leader', 'lead'],
  ]) {
    ranks.titles.set(sessionId, title)
    seated.set(sessionId, ranks.publish(sessionId))
  }
  await callBoss(chief, 'ranks', 'office_adopt', { session_id: 'session-ranks-member', role: 'member' })
  await callBoss(chief, 'ranks', 'office_adopt', { session_id: 'session-ranks-second', role: 'member' })
  await callBoss(chief, 'ranks', 'office_adopt', { session_id: 'session-ranks-leader', role: 'leader' })

  const asked = async (level) => {
    const posted = await callBoss(chief, 'ranks', 'office_post', { text: `asking ${level}`, wake: [level] })
    return { woke: posted.deliveries.map(entry => entry.colleague).sort(), audience: storedMessage(ranks, posted.message.messageId).audience }
  }

  assert.deepEqual(
    await asked('$leader'),
    { woke: ['lead'], audience: '$leader' },
    'the top rung reaches the leaders alone',
  )
  assert.deepEqual(
    await asked('$member'),
    { woke: ['lead', 'manny', 'minnie'], audience: '$member' },
    'and the lowest rung is the whole office: there is no rung below the member role',
  )

  // A colleague is not woken by its own post, however wide the rung it names.
  const own = await call(seated.get('session-ranks-leader'), 'office_post', {
    office: 'ranks',
    text: 'leaders only',
    wake: ['$leader'],
  })
  assert.deepEqual(own.deliveries, [], 'the sender is never in its own audience')
  assert.deepEqual(storedMessage(ranks, own.message.messageId).recipients, [])

  // A named wake stays what it was: exactly the colleagues it names, whatever rung they hold.
  const named = await callBoss(chief, 'ranks', 'office_post', { text: 'minnie only', wake: ['@minnie'] })
  assert.deepEqual(named.deliveries.map(entry => entry.colleague), ['minnie'])
  assert.equal(storedMessage(ranks, named.message.messageId).audience, undefined, 'a named wake records no level')
})

await check('a channel wake reaches exactly the named channel members, wherever the post goes', async () => {
  const core = makeHarness({ officeName: 'core' }, undefined, { rowId: 'office_core' })
  await core.ready
  const coreBoss = core.publish('session-core-boss', { preset: 'office-boss' })
  const seated = new Map()
  for (const [sessionId, title] of [
    ['session-core-a', 'ada'],
    ['session-core-b', 'ben'],
    ['session-core-c', 'cal'],
    ['session-core-d', 'dee'],
  ]) {
    core.titles.set(sessionId, title)
    seated.set(sessionId, core.publish(sessionId))
  }
  for (const title of ['ada', 'ben', 'cal', 'dee']) {
    await callBoss(coreBoss, 'core', 'office_adopt', { session_id: `session-core-${title[0]}`, role: 'member' })
  }
  await callBoss(coreBoss, 'core', 'office_channel_create', { name: 'project', members: ['ada', 'ben'] })
  await callBoss(coreBoss, 'core', 'office_channel_create', { name: 'release', members: ['ada', 'cal'] })

  // The mailbox and the direct-message idspace are addresses of a different kind, so a wake may not
  // name them; the direct channel is the one an office_dm between two colleagues creates. A wake
  // token is normalized the way every channel spelling is, so a refusal names the normalized id.
  const direct = await callBoss(coreBoss, 'core', 'office_dm', { wake: ['@cal'], text: 'a private word' })
  const directChannel = direct.message.channelId
  const posted = await callBoss(coreBoss, 'core', 'office_post', {
    channel: '#release',
    text: 'the project plan moved',
    wake: ['#project'],
  })
  assert.equal(posted.message.channelId, 'release', 'the post lands where it was written')
  assert.deepEqual(
    posted.deliveries.map(entry => entry.colleague).sort(),
    ['ada', 'ben'],
    'and wakes the channel it named, not the members of the channel it was written to',
  )
  assert.equal(
    storedMessage(core, posted.message.messageId).audience,
    '#project',
    'the record states the channel the wake addressed',
  )
  assert.ok(
    !posted.deliveries.some(entry => ['cal', 'dee'].includes(entry.colleague)),
    'nobody outside the named channel is woken',
  )
  assert.deepEqual(
    (await callBoss(coreBoss, 'core', 'office_post', { text: 'the release is cut', wake: ['#general'] }))
      .deliveries.map(entry => entry.colleague).sort(),
    ['ada', 'ben', 'cal', 'dee'],
    'the standing public channel is the whole roster',
  )
  assert.deepEqual(
    (await callBoss(coreBoss, 'core', 'office_post', { text: 'release notes', wake: ['#release'] }))
      .deliveries.map(entry => entry.colleague).sort(),
    ['ada', 'cal'],
    'and a group channel reaches that channel alone',
  )
  const inPublic = await callBoss(coreBoss, 'core', 'office_post', {
    channel: '#general',
    text: 'the plan moved, project only',
    wake: ['#project'],
  })
  assert.equal(inPublic.message.channelId, 'general', 'a channel wake is a wake, not a destination')
  assert.deepEqual(
    inPublic.deliveries.map(entry => entry.colleague).sort(),
    ['ada', 'ben'],
    'so a post to the public channel wakes the named group channel and nobody else',
  )

  // The wake is the channel's own membership: a recipient mid-turn is steered into the turn it is
  // running, exactly as a level or a name would be, and the channel is not the post's destination.
  await core.setStatus('session-core-a', 'running')
  const steered = await callBoss(coreBoss, 'core', 'office_post', {
    text: 'cal, you are on the release too',
    wake: ['#project'],
  })
  assert.deepEqual(
    steered.deliveries.map(entry => `${entry.colleague}:${entry.status}`).sort(),
    ['ada:steered', 'ben:delivered'],
    'a channel wake steers the member it reaches mid-turn and delivers to the one that is idle',
  )
  await core.setStatus('session-core-a', 'idle')

  // A wake token is normalized the way every channel spelling is, so the refusal names the
  // normalized id rather than the caller's own spelling.
  const refusedChannel = async (wake) => {
    const normalized = `#${wake.slice(1).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    try {
      await callBoss(coreBoss, 'core', 'office_post', { text: 'x', wake: [wake] })
    } catch (error) {
      assert.match(
        error.message,
        new RegExp(`office_post: "${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
        `${wake} is refused with the tool that refused it`,
      )
      return error.message
    }
    throw new Error(`office_post accepted the channel wake ${wake}`)
  }
  assert.match(await refusedChannel('#nowhere'), /is not a channel of office "core"/)
  assert.match(await refusedChannel('#mailbox'), /is not an addressable channel/)
  // The direct channel's stored id keeps the `+` that joins its two session ids, while a wake token
  // is normalized away from it, so the direct channel a caller pastes is refused as one this office
  // does not hold rather than as one no wake may name. Either way the refusal is the tool's own.
  assert.match(await refusedChannel(`#${directChannel}`), /is not a channel of office "core"/)

  for (const wake of [['#project', '$member'], ['$member', '#project'], ['#project', '@ada']]) {
    await assert.rejects(
      () => callBoss(coreBoss, 'core', 'office_post', { text: 'x', wake }),
      /stands alone, because it already decides the whole audience/,
      `a channel cannot be combined with ${JSON.stringify(wake)}`,
    )
  }
  await assert.rejects(
    () => callBoss(coreBoss, 'core', 'office_post', { text: 'x', wake: ['@ada', '#project'] }),
    /stands alone/,
    'and a channel cannot follow a name either',
  )
  assert.ok(seated.get('session-core-a').sent.length > 0, 'the named channel member was woken at least once')
})

await check('a wake that is not understood is refused rather than guessed at', async () => {
  const strict = makeHarness({ officeName: 'strict' }, undefined, { rowId: 'office_strict' })
  await strict.ready
  const chief = strict.publish('session-strict-boss', { preset: 'office-boss' })
  for (const [sessionId, title] of [['session-strict-hand', 'hand'], ['session-strict-other', 'other']]) {
    strict.titles.set(sessionId, title)
    strict.publish(sessionId)
  }
  await callBoss(chief, 'strict', 'office_adopt', { session_id: 'session-strict-hand' })
  await callBoss(chief, 'strict', 'office_adopt', { session_id: 'session-strict-other' })

  const post = wake => callBoss(chief, 'strict', 'office_post', { text: 'hello', wake })
  await assert.rejects(() => post(undefined), /wake is required/, 'an omitted wake is not a default audience')
  await assert.rejects(() => post('hand'), /wake is required and must be an array/, 'a bare name is not a wake array')
  await assert.rejects(() => post(['hand']), /wake addresses colleagues as "@name"/, 'a name without its marker is refused')
  await assert.rejects(() => post(['$everyone']), /office_post: "\$everyone" is not a wake level/, 'a level nobody defined is refused')
  await assert.rejects(() => post(['$leader', '$member']), /a level stands alone/, 'two levels are refused rather than unioned')
  await assert.rejects(() => post(['@hand', '$leader']), /a level stands alone/, 'a level and a name are refused rather than unioned')
  await assert.rejects(() => post(['  ']), /must be a non-empty string/)
  await assert.rejects(() => post(['@nobody']), /does not match any colleague/, 'a name nobody answers to fails loud')

  // The wake levels moved from `#` to `$`, and the office says which spelling replaced the one it
  // was handed rather than reporting a channel it cannot find.
  const retired = [
    ['#member', '$member'],
    ['#leader', '$leader'],
    ['#consultant', '$member'],
  ]
  for (const [spelling, replacement] of retired) {
    await assert.rejects(
      () => post([spelling]),
      new RegExp(`office_post: "${spelling}" is the old spelling of a wake level; that level is now written "\\${replacement}"`),
      `${spelling} names no channel: it is the retired spelling of ${replacement}`,
    )
  }
  // `#general` is a channel, not a retired level, so it reaches the roster rather than being read
  // as a level nobody defined.
  assert.deepEqual(
    (await post(['#general'])).deliveries.map(entry => entry.colleague).sort(),
    ['hand', 'other'],
  )

  // A private message is one conversation: it names one colleague and refuses a level, an address
  // that decides a whole audience by itself.
  const dm = wake => callBoss(chief, 'strict', 'office_dm', { text: 'psst', wake })
  await assert.rejects(
    () => dm(['$leader']),
    /office_dm: wake names one colleague, and "\$leader" is a level.*private message is one conversation/,
  )
  await assert.rejects(
    () => dm(['#general']),
    /office_dm: wake names one colleague, and "#general" is a channel.*private message is one conversation/,
    'and refuses a channel exactly as it refuses a level',
  )
  await assert.rejects(() => dm([]), /wake must name exactly one colleague/, 'a private message needs a recipient')
  await assert.rejects(() => dm(['@hand', '@other']), /wake must name exactly one colleague/)
  assert.equal((await dm(['@hand'])).deliveries[0].colleague, 'hand', 'and one colleague is what it delivers to')
})

await check('an idle notice wakes the level its row configures', async () => {
  const wide = makeHarness(
    { officeName: 'wide', idleNotice: { enabled: true, wake: ['$member'], text: 'the office stopped' } },
    undefined,
    { rowId: 'office_wide' },
  )
  await wide.ready
  wide.titles.set('session-wide-boss', 'chief')
  wide.titles.set('session-wide-lead', 'lead')
  wide.titles.set('session-wide-hand', 'hand')
  const chief = wide.publish('session-wide-boss', { preset: 'office-boss' })
  wide.publish('session-wide-lead')
  wide.publish('session-wide-hand')
  await callBoss(chief, 'wide', 'office_adopt', { session_id: 'session-wide-lead', role: 'leader' })
  await callBoss(chief, 'wide', 'office_adopt', { session_id: 'session-wide-hand' })
  await callBoss(chief, 'wide', 'office_post', { text: 'the release is cut', wake: [] })
  await wide.setStatus('session-wide-hand', 'running')
  await wide.setStatus('session-wide-hand', 'idle')
  const asked = [...wide.tables.get('messages').entries()]
    .map(([, message]) => message)
    .filter(message => message.senderName === 'office')
  assert.equal(asked.length, 1, 'the office asks once the last colleague stops')
  assert.deepEqual(
    [...asked[0].recipients].sort(),
    ['session-wide-hand', 'session-wide-lead'],
    'the configured rung reaches the member and the leader above it',
  )
  assert.equal(asked[0].audience, '$member', 'and the record says which level asked the question')
  await wide.close()
})

await check('an idle notice that could not reach anybody is refused with the row', async () => {
  await assert.rejects(
    () => makeHarness({ idleNotice: { enabled: true, wake: [] } }).ready,
    /idleNotice\.wake must address somebody/,
    'a notice that wakes nobody would ask nothing of anyone',
  )
  await assert.rejects(
    () => makeHarness({ idleNotice: { enabled: true, wake: ['$boss'] } }).ready,
    /config\.idleNotice\.wake: "\$boss" is not a wake level/,
    'a level nobody predefined is refused rather than stored and never resolved',
  )
  await assert.rejects(
    () => makeHarness({ idleNotice: { enabled: true, wake: ['boss'] } }).ready,
    /wake addresses colleagues as "@name"/,
  )
  // The row spells the wake the way a tool call does, so the retired spelling is refused here with
  // the same message rather than being resolved as a channel nobody holds.
  await assert.rejects(
    () => makeHarness({ idleNotice: { enabled: true, wake: ['#leader'] } }).ready,
    /config\.idleNotice\.wake: "#leader" is the old spelling of a wake level; that level is now written "\$leader"/,
  )
  // The notice's channel is a channel of the office, so a group channel is what a row names when
  // it wants the question somewhere other than the public feed.
  const routed = makeHarness(
    { officeName: 'routed', idleNotice: { enabled: true, channel: 'leaders', wake: ['#leaders'] } },
    undefined,
    { rowId: 'office_routed' },
  )
  await routed.ready
  routed.titles.set('session-routed-boss', 'chief')
  routed.titles.set('session-routed-lead', 'lead')
  const routedChief = routed.publish('session-routed-boss', { preset: 'office-boss' })
  const routedLead = routed.publish('session-routed-lead')
  await callBoss(routedChief, 'routed', 'office_adopt', { session_id: 'session-routed-lead', role: 'leader' })
  await callBoss(routedChief, 'routed', 'office_channel_create', { name: 'leaders', members: ['lead'] })
  await callBoss(routedChief, 'routed', 'office_post', { text: 'the release is cut', wake: [] })
  await routed.setStatus('session-routed-lead', 'running')
  await routed.setStatus('session-routed-lead', 'idle')
  assert.equal(routedLead.sent.length, 1, 'the notice wakes the channel it names')
})

await check('every cold resume is owned by the process context, not by this plugin generation', () => {
  assert.ok(resumePlanes.length > 0, 'the suite resumed a colleague, so the plane was observed')
  assert.deepEqual(
    [...new Set(resumePlanes)],
    ['process'],
    'a resume through the office row would make a source reload dispose the colleague mid-turn',
  )
})

await check('a panel poll holding the snapshot token is told nothing moved, until something does', async () => {
  const first = await callRoute(routes, officeRoute('state', 'office'))
  assert.match(
    first.payload.revision,
    /^[0-9a-f]{16}$/,
    'the token is a short digest: it travels as a query parameter, so the office itself cannot ride in it',
  )
  assert.equal(first.payload.unchanged, undefined, 'and a full snapshot never claims that nothing moved')

  const held = `${officeRoute('state', 'office')}&since=${encodeURIComponent(first.payload.revision)}`
  const quiet = await callRoute(routes, held)
  assert.equal(quiet.payload.unchanged, true, 'the same tick is answered without a snapshot')
  assert.equal(quiet.payload.colleagues, undefined, 'so a quiet poll carries no roster at all')
  assert.equal(quiet.payload.revision, first.payload.revision, 'and hands the same token back')

  // A post that names nobody wakes nobody, so the tick can only have moved because the channel the
  // panel reads moved — which is the difference between a feed refresh and a colleague's hold.
  const posted = await callRoute(routes, officeRoute('post', 'office'), {
    method: 'POST',
    body: { text: 'a line into the feed the panel reads' },
  })
  assert.equal(posted.status, 200)
  const after = await callRoute(routes, held)
  assert.notEqual(after.payload.unchanged, true, 'a message in that channel moves the tick')
  assert.notEqual(after.payload.revision, first.payload.revision, 'so the stale token is refused')
})

await check("the token moves for the roster's live state and stays put for another channel's traffic", async () => {
  // A second office mounts into the shared harness, so the check owns a channel of its own while
  // the one host keeps serving the routes the panel asks for.
  harness.ctx.fiber.entry.options.id = 'office_ticks'
  await apply(harness.ctx, { officeName: 'ticks' })
  harness.titles.set('session-ticks-boss', 'tick chief')
  harness.titles.set('session-tick-a', 'ada')
  const chief = harness.publish('session-ticks-boss', { preset: 'office-boss' })
  harness.publish('session-tick-a')
  await callBoss(chief, 'ticks', 'office_adopt', { session_id: 'session-tick-a' })

  const token = async (channel) =>
    (await callRoute(routes, `${officeRoute('state', 'ticks')}&channel=${channel}`)).payload.revision
  const holds = (channel, since) =>
    `${officeRoute('state', 'ticks')}&channel=${channel}&since=${encodeURIComponent(since)}`
  const settled = await token('general')

  // A colleague that starts working moves nothing the office stored, so the roster's own live
  // status is the case the tick has to read from the registry rather than from a write.
  await harness.setStatus('session-tick-a', 'running')
  assert.notEqual(await token('general'), settled, "a colleague's status moves the tick")
  assert.notEqual(
    (await callRoute(routes, holds('general', settled))).payload.unchanged,
    true,
    'so a panel holding the old token is answered with a snapshot',
  )

  // A channel the panel is not reading is not a change to the page it draws. The group channel has
  // no members, so a post into #general wakes nobody and stores no hold for anyone either — the
  // mailbox, the roster, and the channel being read are all untouched by it.
  const created = await callBoss(chief, 'ticks', 'office_channel_create', { name: 'elsewhere' })
  assert.equal(created.channelId, 'elsewhere', `creating the group channel failed: ${JSON.stringify(created)}`)
  const elsewhere = await token('elsewhere')
  const other = await callRoute(routes, officeRoute('post', 'ticks'), {
    method: 'POST',
    body: { text: 'a line in the general feed' },
  })
  assert.equal(other.status, 200, `posting to #general failed: ${JSON.stringify(other.payload)}`)
  assert.equal(
    (await callRoute(routes, holds('elsewhere', elsewhere))).payload.unchanged,
    true,
    "another channel's traffic leaves the panel's own token alone",
  )
})

await check('a colleague reads the wake of every message, whatever spelling wrote it', async () => {
  const spokes = makeHarness({ officeName: 'spokes' }, undefined, { rowId: 'office_spokes' })
  await spokes.ready
  const chief = spokes.publish('session-spokes-boss', { preset: 'office-boss' })
  spokes.titles.set('session-spokes-boss', 'chief')
  spokes.titles.set('session-alice', 'alice')
  spokes.titles.set('session-bob', 'bob')
  const alice = spokes.publish('session-alice')
  spokes.publish('session-bob')
  await callBoss(chief, 'spokes', 'office_adopt', { session_id: 'session-alice' })
  await callBoss(chief, 'spokes', 'office_adopt', { session_id: 'session-bob' })
  await callBoss(chief, 'spokes', 'office_channel_create', { name: 'dev', members: ['alice', 'bob'] })

  const post = (text, wake, channel) => call(alice, 'office_post', {
    office: 'spokes',
    text,
    wake,
    ...(channel === undefined ? {} : { channel }),
  })
  await post('everyone, standup in ten', ['$member'])
  await post('dev, the plan moved', ['#dev'], 'dev')
  await post('bob, please review', ['@bob'])
  await post('quiet note', [])
  // A message a deployment stored before levels moved to `$` recorded `#leader`, which `#` no
  // longer means: a reader sees the level that addresses its audience today. The retired consultant
  // rung maps onto the lowest level, so it reads the same way.
  const oldLevel = await post('the old level', ['$leader'])
  await spokes.tables.get('messages').put(
    `general#${String(storedMessage(spokes, oldLevel.message.messageId).seq).padStart(12, '0')}`,
    { ...storedMessage(spokes, oldLevel.message.messageId), audience: '#leader' },
  )
  const retiredLevel = await post('the retired level', ['$member'])
  await spokes.tables.get('messages').put(
    `general#${String(storedMessage(spokes, retiredLevel.message.messageId).seq).padStart(12, '0')}`,
    { ...storedMessage(spokes, retiredLevel.message.messageId), audience: '#consultant' },
  )

  const read = await callBoss(chief, 'spokes', 'office_read', { channel: '#general' })
  const wakeOf = text => read.messages.find(message => message.text === text).wake
  assert.equal(wakeOf('everyone, standup in ten'), '$member', 'a level wake reads as the level it named')
  assert.equal(wakeOf('bob, please review'), '@bob', 'a named wake reads as the colleague it resolved to')
  assert.equal(wakeOf('quiet note'), 'nobody', 'and a wake that reached nobody says so')
  assert.equal(wakeOf('the old level'), '$leader', 'a pre-`$` stored level reads in the spelling that addresses it today')
  assert.equal(wakeOf('the retired level'), '$member', 'and the retired rung reads as the lowest level that replaced it')
  const dev = await callBoss(chief, 'spokes', 'office_read', { channel: 'dev' })
  assert.equal(dev.messages.find(message => message.text === 'dev, the plan moved').wake, '#dev',
    'a channel wake reads as the channel it named, in the channel it was written to')

  // The rendered page states it in the head of each line, before the body, and omits the clause for
  // a record that states no wake at all.
  const rendered = chief.tools.get('office_read').output.render({ channel: '#general' }, read)[0].text
  assert.match(
    rendered,
    /^\[general-\d+\] alice · wake \$member: everyone, standup in ten$/m,
    'the rendered line puts the wake beside the sender, where the reader meets it before the body',
  )
  assert.match(rendered, /^\[general-\d+\] alice · wake @bob: bob, please review$/m)
  assert.match(rendered, /^\[general-\d+\] alice · wake nobody: quiet note$/m)
  assert.match(rendered, /^\[general-\d+\] alice · wake \$leader: the old level$/m)
  assert.match(rendered, /^\[general-\d+\] alice · wake \$member: the retired level$/m)
  const devLine = await callBoss(chief, 'spokes', 'office_read', { channel: 'dev' })
  assert.match(
    chief.tools.get('office_read').output.render({ channel: 'dev' }, devLine)[0].text,
    /^\[dev-\d+\] alice · wake #dev: dev, the plan moved$/m,
  )

  // A summary is not a message anybody addressed, so it states no wake.
  await callBoss(chief, 'spokes', 'office_compact', { channel: '#general', from: 1, to: 1, summary: 'settled' })
  const compacted = await callBoss(chief, 'spokes', 'office_read', { channel: '#general', from: 1, to: 1 })
  assert.equal(compacted.messages.at(-1).kind, 'summary')
  assert.equal(compacted.messages.at(-1).wake, undefined, 'a summary states no wake')
  assert.ok(
    !chief.tools.get('office_read').output.render({ channel: '#general', from: 1, to: 1 }, compacted)[0].text
      .includes('wake'),
    'and its rendered line carries no wake clause',
  )
})

await check("naming the roster reads the title projections, never a session's log", async () => {
  // `titles: {}` mounts the projection registry, which is what a deployment that shows a session
  // list has and what makes a live title readable without folding the log behind it.
  const naming = makeHarness({ officeName: 'naming' }, undefined, { rowId: 'office_naming', titles: {} })
  await naming.ready
  naming.titles.set('session-naming-boss', 'naming chief')
  naming.titles.set('session-name-a', 'ada')
  const chief = naming.publish('session-naming-boss', { preset: 'office-boss' })
  naming.publish('session-name-a')
  await callBoss(chief, 'naming', 'office_adopt', { session_id: 'session-name-a' })

  naming.titleFolds.count = 0
  const listed = await callBoss(chief, 'naming', 'office_colleagues', {})
  assert.deepEqual(listed.colleagues.map(entry => entry.name), ['ada'])
  assert.equal(naming.titleFolds.count, 0, 'the roster reads the live title projection, not the log')

  naming.titles.set('session-name-a', 'ada lovelace')
  const renamed = await callBoss(chief, 'naming', 'office_colleagues', {})
  assert.deepEqual(
    renamed.colleagues.map(entry => entry.name),
    ['ada lovelace'],
    'and a session renamed anywhere renames the colleague with no log read either',
  )
  assert.equal(naming.titleFolds.count, 0, 'a rename is not an excuse to fold the history')
})

await check('a cold resume mounts the preset the session log names, so the colleague keeps its own tools', async () => {
  const plane = makeHarness({ officeName: 'plane' }, undefined, {
    rowId: 'office_plane',
    sessionPresets: { 'session-cold': 'standard' },
  })
  await plane.ready
  const chief = plane.publish('session-plane-boss', { preset: 'office-boss' })
  plane.titles.set('session-cold', 'cold')
  await callBoss(chief, 'plane', 'office_adopt', { session_id: 'session-cold' })

  const posted = await callBoss(chief, 'plane', 'office_post', { text: 'please look', wake: ['@cold'] })
  assert.deepEqual(posted.deliveries, [{ colleague: 'cold', status: 'delivered' }])
  // The harness mounts a preset only through the `setup` the resuming caller passes, so a resume
  // without one publishes an agent that holds no preset tool at all. The mount is the difference
  // between a colleague that can work and one that only answers.
  assert.ok(
    plane.presetMounts.some(mount => mount.id === 'standard' && mount.via === 'resume'),
    'the cold resume must hand the harness a setup that mounts the session preset',
  )
  const cold = plane.liveAgents.get('session-cold')
  assert.equal(plane.presetBindings.get(cold.ctx), 'standard', 'and the colleague ends up bound to it')
  const row = (await callBoss(chief, 'plane', 'office_colleagues')).colleagues.find(entry => entry.name === 'cold')
  assert.equal(row.agentPreset, 'standard', 'the roster reports the preset the colleague actually runs')
  assert.ok(row.tools >= 6, `a member with its preset holds at least the office tools, got ${String(row.tools)}`)
})

await check('the preset a session selected outlives its creation header on a resume', async () => {
  const switched = makeHarness({ officeName: 'switched' }, undefined, {
    rowId: 'office_switched',
    presets: ['personal'],
    sessionPresets: { 'session-picked': 'standard' },
    agentPresetProjection: { 'session-picked': 'personal' },
  })
  await switched.ready
  const chief = switched.publish('session-switched-boss', { preset: 'office-boss' })
  switched.titles.set('session-picked', 'picked')
  await callBoss(chief, 'switched', 'office_adopt', { session_id: 'session-picked' })
  await callBoss(chief, 'switched', 'office_post', { text: 'wake up', wake: ['@picked'] })

  // A session may change preset while it is blank, and the change is what later turns ran under:
  // composing from the frozen creation header would rebuild the composition the session left.
  assert.deepEqual(
    switched.presetMounts.filter(mount => mount.via === 'resume').map(mount => mount.id),
    ['personal'],
    'the resume composes the projected preset, not the header',
  )
})

await check('a live colleague that holds no preset plane gets one back before its turn', async () => {
  const stripped = makeHarness({ officeName: 'stripped' }, undefined, { rowId: 'office_stripped' })
  await stripped.ready
  const chief = stripped.publish('session-stripped-boss', { preset: 'office-boss' })
  stripped.titles.set('session-stripped', 'stripped')
  // Live, and composed with no preset: the state every colleague the office woke before it passed
  // a `setup` is in. It answers turns it cannot work with until something rebinds it.
  const bare = stripped.publish('session-stripped', { preset: 'standard', bound: false })
  assert.equal(stripped.presetBindings.get(bare.ctx), undefined, 'the fake starts it with no plane')
  await callBoss(chief, 'stripped', 'office_adopt', { session_id: 'session-stripped' })

  const before = bare.sent.length
  const posted = await callBoss(chief, 'stripped', 'office_post', { text: 'are you there?', wake: ['@stripped'] })
  assert.deepEqual(posted.deliveries, [{ colleague: 'stripped', status: 'delivered' }])
  assert.ok(
    stripped.presetMounts.some(mount => mount.id === 'standard' && mount.via === 'recompose'),
    'a colleague found without its preset is rebound, not handed a turn it cannot work with',
  )
  assert.equal(stripped.presetBindings.get(bare.ctx), 'standard', 'and it keeps its history and its session')
  assert.equal(bare.sent.length, before + 1, 'the turn it was woken for still arrives, once')
})

await check('a colleague whose plane is restored is armed with the same withdrawal a fresh one gets', async () => {
  const repaired = makeHarness({ officeName: 'repaired' }, undefined, {
    rowId: 'office_repaired',
    askUserTool: true,
  })
  await repaired.ready
  const chief = repaired.publish('session-repaired-boss', { preset: 'office-boss' })
  repaired.titles.set('session-repaired-member', 'member')
  repaired.titles.set('session-repaired-leader', 'leader')
  const member = repaired.publish('session-repaired-member', { preset: 'standard', bound: false })
  const leader = repaired.publish('session-repaired-leader', { preset: 'standard', bound: false })
  // An agent with no preset plane inherits nothing at all, so the tool this row decides about is
  // simply absent from it — which is why the arming that ran had no decision to make.
  assert.ok(!seesAskUser(member), 'a stripped colleague holds no preset tool, not even the question one')

  await callBoss(chief, 'repaired', 'office_adopt', { session_id: 'session-repaired-member', role: 'member' })
  await callBoss(chief, 'repaired', 'office_adopt', { session_id: 'session-repaired-leader', role: 'leader' })
  await callBoss(chief, 'repaired', 'office_post', { text: 'work please', wake: ['@member', '@leader'] })

  // The plane handed back carries the harness question tool, and the role decides who keeps it: the
  // set has to be rebuilt around the restored plane, or every repaired colleague would come back
  // holding it and a member could block a turn waiting for a human who is not in that Chat.
  assert.ok(!seesAskUser(member), 'a repaired member still asks by mail rather than holding a turn open')
  assert.ok(seesAskUser(leader), 'while a repaired leader keeps the tool its role is left with')
  assert.ok(member.tools.has('office_post'), 'and the office tools are installed beside the restored plane')
})

await check('mounting an office gives back the plane of a colleague that is already live without one', async () => {
  const remount = makeHarness({ officeName: 'remount' }, undefined, { rowId: 'office_remount' })
  await remount.ready
  const chief = remount.publish('session-remount-boss', { preset: 'office-boss' })
  remount.titles.set('session-remount-guest', 'guest')
  // Adopted while it was live, and stripped of its plane: the state a colleague is left in when
  // nothing composes it again. A reader talking to it directly reaches it through the Web surface,
  // which reuses the live agent as it is, so no wake ever repairs it — the office has to sweep.
  const guest = remount.publish('session-remount-guest', { preset: 'standard', bound: false })
  await callBoss(chief, 'remount', 'office_adopt', { session_id: 'session-remount-guest' })
  assert.equal(remount.presetBindings.get(guest.ctx), undefined, 'the fake starts it with no plane')

  // A remount is what a source reload, a profile-patch reload, and a Host start all produce.
  await remount.close()
  remount.ctx.fiber.entry.options.id = 'office_remount'
  await apply(remount.ctx, { officeName: 'remount' })
  assert.equal(
    remount.presetBindings.get(guest.ctx),
    'standard',
    'mounting an office repairs the colleagues it can see, without waiting for a wake',
  )
  const row = (await callBoss(chief, 'remount', 'office_colleagues'))
    .colleagues.find(entry => entry.name === 'guest')
  assert.equal(row.agentPreset, 'standard', 'and the roster reads the plane it now holds')
})

await check('a deployment that mounts no preset registry resumes a colleague as it always did', async () => {
  const bareDeployment = makeHarness({ officeName: 'noregistry' }, undefined, {
    rowId: 'office_noregistry',
    agentPresets: null,
  })
  await bareDeployment.ready
  const chief = bareDeployment.publish('session-noregistry-boss', { preset: 'office-boss' })
  bareDeployment.titles.set('session-noregistry-cold', 'cold')
  await callBoss(chief, 'noregistry', 'office_adopt', { session_id: 'session-noregistry-cold' })
  const posted = await callBoss(chief, 'noregistry', 'office_post', {
    text: 'wake up',
    wake: ['@cold'],
  })
  assert.deepEqual(posted.deliveries, [{ colleague: 'cold', status: 'delivered' }])
  assert.deepEqual(bareDeployment.presetMounts, [], 'a deployment with no registry mounts nothing')
  const row = (await callBoss(chief, 'noregistry', 'office_colleagues'))
    .colleagues.find(entry => entry.name === 'cold')
  assert.equal(row.agentPreset, undefined, 'and the roster claims no preset it cannot know')
})

await check('a colleague whose preset nobody declares fails the wake instead of coming up stripped', async () => {
  const gone = makeHarness({ officeName: 'gone' }, undefined, {
    rowId: 'office_gone',
    sessionPresets: { 'session-gone': 'retired-preset' },
  })
  await gone.ready
  const chief = gone.publish('session-gone-boss', { preset: 'office-boss' })
  gone.titles.set('session-gone', 'gonecolleague')
  await callBoss(chief, 'gone', 'office_adopt', { session_id: 'session-gone' })

  const posted = await callBoss(chief, 'gone', 'office_post', { text: 'wake up', wake: ['@gonecolleague'] })
  assert.equal(posted.deliveries[0].status, 'failed', 'the wake is reported, not half-done')
  assert.match(posted.deliveries[0].detail, /Unknown agent preset: retired-preset/)
  assert.equal(
    gone.liveAgents.has('session-gone'),
    false,
    'a colleague that cannot be composed is not published as one that holds nothing',
  )
})

for (const label of checks) console.log(`  ok  ${label}`)
console.log(`\ndsh-office probe: ${checks.length} checks passed`)