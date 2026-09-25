/**
 * dsh-office — a persistent colleague office over ordinary DSH sessions.
 *
 * Colleagues are ordinary sessions the user adopts by id. Channels, direct
 * messages, and delivery bookkeeping live in the office's own storage domain, so the
 * office outlives any session and no session log is the coordination authority.
 *
 * Two harness contracts shape the implementation.
 *
 * 1. All authoritative state stays in the domain. An out-of-tree plugin must not
 *    add `SessionEventMap` members: `KNOWN_SESSION_EVENT_TYPES` is generated from
 *    the harness source and `Session.append` cannot stamp the envelope's
 *    `ignorable` marker, so a custom event type would make the owning session
 *    unreadable at its next open.
 * 2. Delivery into a colleague is a standard `user/message` whose `source.kind`
 *    is `office-message`. The session read path requires a nonempty source `kind`
 *    and does not constrain its value, which makes this the only model-visible
 *    channel open to this plugin.
 *
 * Waking is explicit and unconditional: a public post notifies the whole office unless the
 * caller narrows it to named colleagues, and a notification is always delivered. A colleague
 * that is mid-turn is never interrupted: what arrives meanwhile is held and handed over as one
 * merged turn when that turn ends, so no budget or cascade depth can refuse a message someone
 * sent. A wake carries its own messages alone; history is read with `office_read`.
 *
 * @module dsh-office
 */

import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isSeq, parseDocument } from 'yaml'

/** Cordis plugin name. */
export const name = 'office'

/** Services this plugin cannot operate without. */
export const inject = ['tools', 'agents', 'storageDomain']

/** The public channel created on first activation. */
const GENERAL_CHANNEL = 'general'

/**
 * The user's mailbox: the one channel every colleague is refused.
 *
 * A colleague can address the user — with `office_dm` to the user's name, or a public post that
 * mentions it — and the user has no session to wake, so the message needs somewhere to live. It
 * lives here, which makes the mailbox a single authoritative feed rather than a query the panel
 * assembles. `kind: 'mailbox'` is what keeps it out of every colleague's `office_read`: this is
 * the user's private mail, and `office_read({ channel: '*' })` must not reach it.
 */
const MAILBOX_CHANNEL = 'mailbox'

/**
 * The predefined colleague roles. A colleague's stored `role` is one of these and nothing
 * else: the role decides which office tools that colleague's session receives, so a
 * free-text label would be a permission nobody can predict from the roster.
 */
const ROLE_MEMBER = 'member'
const ROLE_LEADER = 'leader'
const ROLE_CONSULTANT = 'consultant'

/** Every predefined colleague role, in the order the Web panel offers them. */
const COLLEAGUE_ROLES = [ROLE_MEMBER, ROLE_LEADER, ROLE_CONSULTANT]

/**
 * Office capabilities each predefined role holds. A capability is one group of tools, and
 * the tool set a colleague receives is the union of the capabilities its roles hold — a
 * single session may be a colleague of several offices, so the same agent can hold two
 * roles at once. Every gated tool re-checks the capability against the office the call
 * resolved, because the union grants the tool, not the right to use it everywhere.
 *
 * `member` is the default and the migration target: a stored role that is absent, or that
 * no longer names a predefined role, reads as `member`.
 */
const ROLE_CAPABILITIES = {
  [ROLE_MEMBER]: ['read', 'colleagues', 'post', 'dm'],
  [ROLE_LEADER]: ['read', 'colleagues', 'post', 'dm', 'interrupt', 'compact', 'configure'],
  [ROLE_CONSULTANT]: ['read', 'colleagues'],
}

/** Capabilities a boss holds: it runs the office, so it holds every capability there is. */
const BOSS_CAPABILITIES = ['manage', 'read', 'colleagues', 'post', 'dm', 'interrupt', 'compact', 'configure']

/** Role a colleague holds when its stored role is absent or no longer predefined. */
const DEFAULT_COLLEAGUE_ROLE = ROLE_MEMBER

/** Longest description one colleague may carry. It reaches the roster, the greeting, and the panel. */
const DESCRIPTION_MAX_CHARS = 2000

/**
 * Role → session permission preset, per office row.
 *
 * A role's office capabilities decide which office tools its session holds; this map decides
 * the DSH permission preset its session runs under (sandbox mode plus approval policy, owned
 * by `ctx.permissionPresets` and enforced by every confined capability). `consultant` is
 * read-only by default: it takes part in the office but cannot write to disk.
 */
const DEFAULT_ROLE_PERMISSIONS = { [ROLE_CONSULTANT]: 'read-only' }

/**
 * The predefined role a stored value names, or the default.
 * @param value - a stored or requested role.
 * @returns a role of {@link COLLEAGUE_ROLES}.
 */
function canonicalRole(value) {
  return typeof value === 'string' && COLLEAGUE_ROLES.includes(value) ? value : DEFAULT_COLLEAGUE_ROLE
}

/**
 * Validate a role supplied by a caller.
 * @param value - the requested role.
 * @param where - the tool or operation refusing it, for the diagnostic.
 * @returns the role.
 * @throws {TypeError} when the value is not a predefined role.
 */
function requireRole(value, where) {
  if (typeof value !== 'string' || !COLLEAGUE_ROLES.includes(value)) {
    throw new TypeError(
      `dsh-office: ${where}: role must be one of ${COLLEAGUE_ROLES.join(', ')}, got ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * Normalize a description supplied by a caller.
 * @param value - the requested description.
 * @param where - the tool or operation refusing it, for the diagnostic.
 * @returns the trimmed description, or undefined when it is empty.
 * @throws {TypeError} when the value is not a string, or is longer than {@link DESCRIPTION_MAX_CHARS}.
 */
function normalizeDescription(value, where) {
  if (typeof value !== 'string') {
    throw new TypeError(`dsh-office: ${where}: description must be a string, got ${JSON.stringify(value)}`)
  }
  const trimmed = value.trim()
  if (trimmed.length > DESCRIPTION_MAX_CHARS) {
    throw new TypeError(
      `dsh-office: ${where}: description is ${String(trimmed.length)} characters; the limit is ${String(DESCRIPTION_MAX_CHARS)}`,
    )
  }
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * The `role` property every tool that sets a colleague's role declares.
 * @returns the property schema.
 */
function roleProperty() {
  return {
    type: 'string',
    enum: COLLEAGUE_ROLES,
    description: `Predefined role: ${COLLEAGUE_ROLES.join(', ')}. The role decides which office tools `
      + 'the colleague holds: member reads and writes to the office, leader also interrupts and compacts, '
      + 'consultant reads only. It also selects the session permission preset the office row maps it to.',
  }
}

/**
 * The `description` property every tool that sets a colleague's description declares.
 * @returns the property schema.
 */
function descriptionProperty() {
  return {
    type: 'string',
    description: `What this colleague is for, in one or two sentences (at most ${String(DESCRIPTION_MAX_CHARS)} `
      + 'characters). It reaches the colleague\'s onboarding message, the roster, and the Web panel.',
  }
}

/**
 * Deployment defaults for the office HOST row.
 *
 * The host owns everything that exists once per deployment rather than once per office:
 * the agent tool set and the Web panel. Values an individual office needs to store and
 * deliver its own messages live in {@link DEFAULT_OFFICE_CONFIG} instead.
 */
const DEFAULT_HOST_CONFIG = {
  readLimit: 20,
  readLimitMax: 100,
  bossPreset: 'office-boss',
  profilePatch: undefined,
}

/** Deployment defaults for one OFFICE row. */
const DEFAULT_OFFICE_CONFIG = {
  maxMessageChars: 16384,
  wakesEnabled: true,
  userName: 'user',
  bossPreset: 'office-boss',
  rolePermissions: { ...DEFAULT_ROLE_PERMISSIONS },
  // Both are listed so the unknown-key check accepts them, and neither carries a value here.
  // They are the two halves of an office's identity: `officeName` is the name people and the
  // model read and pass, and `officeId` is the storage key behind it, which defaults to the
  // row id because that is the one identifier no patch override can replace.
  officeName: undefined,
  officeId: undefined,
}

/**
 * The row id this package reserves for its host.
 *
 * The row kind comes from the id rather than from a config field, because a patch override
 * REPLACES the whole `config`: a user tweaking one value on the office row would
 * otherwise drop the very field that says which kind of row it is, and the office would be
 * read as a second host. An id is the patch's own match key, so no override can remove it.
 */
const HOST_ROW_ID = 'office-host'

/** The row id this package's own patch gives its shipped office, which is named `office`. */
const SHIPPED_OFFICE_ROW_ID = 'office'

/**
 * Per-table schema stub for the office domain. The domain facility calls only
 * `valueSchema.parse` on stored records, so record validation belongs to this
 * plugin; see {@link validateColleague}, {@link validateChannel}, and
 * {@link validateMessage}.
 */
const PASSTHROUGH_SCHEMA = { parse: (value) => value }

/**
 * Build one office's storage domain from its identity.
 *
 * The domain is named by the office ID, not by the office name: the storage hub requires a
 * unit name to match {@link OFFICE_ID_RE}, because a backend turns it into a file-name or
 * SQL-identifier segment. The name is data — it is stored in the global slot, so renaming an
 * office never moves its storage unit.
 * @param officeId - the office's storage key.
 * @param name - the office's current name, seeding the stored global.
 * @returns the domain declaration.
 */
function officeDomain(officeId, name) {
  return {
    name: officeId,
    version: 1,
    global: { schema: PASSTHROUGH_SCHEMA, initial: { officeId, name } },
    tables: {
      colleagues: { valueSchema: PASSTHROUGH_SCHEMA },
      channels: { valueSchema: PASSTHROUGH_SCHEMA },
      messages: { valueSchema: PASSTHROUGH_SCHEMA },
      pending: { valueSchema: PASSTHROUGH_SCHEMA },
    },
  }
}

/**
 * An office ID is the storage unit name, so it must satisfy the storage hub's `UNIT_NAME_RE`
 * (`/^[a-z][a-z0-9_]*$/` in `dsh-storage`).
 */
const OFFICE_ID_RE = /^[a-z][a-z0-9_]*$/

/** Bound on an office ID, which becomes a file-name segment on the durable medium. */
const OFFICE_ID_MAX_CHARS = 64

/**
 * An office NAME is what the user, the panel, and the model read and pass, so it accepts
 * any script — Chinese, accented Latin, Cyrillic — and is canonicalized before this test.
 * Underscore is the only punctuation it takes: the name travels in tool arguments and in a
 * query parameter, so a blank, a separator, or a quote in it would be ambiguous at best.
 */
const OFFICE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*$/u

/**
 * Canonical form of a name people address: trimmed and NFC-normalized, so one visible name is
 * one identity. Unicode lets the same name be spelled with composed or decomposed accents, and
 * only the canonical spelling may reach storage, comparison, the panel, or a tool argument.
 * @param value - a name from configuration, a request body, or a tool argument.
 * @returns the canonical name.
 */
function canonicalName(value) {
  return String(value).trim().normalize('NFC')
}

/**
 * The key two names are compared by: an office name, or a colleague's session title.
 *
 * Names are how people and the model address an office or a colleague, so two that differ only
 * in case would be ambiguous everywhere; comparing case-insensitively makes them one name
 * rather than a surprise. The stored spelling keeps whatever the user typed. This is a
 * Unicode comparison and not a slug, because a colleague titled `张三` has no ASCII form: an
 * ASCII-only normalization would erase the title entirely and make every mention of it fail.
 * @param value - an office name or a session title.
 * @returns the comparison key.
 */
function nameKey(value) {
  return canonicalName(value).toLowerCase()
}

/**
 * Offices mounted from this package in the current Host, keyed by office name, each
 * carrying the configuration it was mounted with.
 *
 * Every row of this package imports the same module — the Loader imports a row by name with
 * no cache-busting — so one module-level table is the process's only description of which
 * offices exist. It answers the panel's discovery request, resolves the office a tool call
 * acts on, and names the offices a create or delete request may target. The host owns it
 * and reads it for the tool set and the panel; each office adds and removes its own entry.
 */
const mountedOffices = new Map()

/** Path the panel asks for the mounted-office list. Namespaced so no officeName can collide with it. */
const OFFICES_ROUTE = '/dsh-office/offices'

/** Host routes that manage offices rather than act inside one. Namespaced for the same reason. */
const CREATE_OFFICE_ROUTE = '/dsh-office/offices/create'
const DELETE_OFFICE_ROUTE = '/dsh-office/offices/delete'
const RENAME_OFFICE_ROUTE = '/dsh-office/offices/rename'

/**
 * The mounted office host, which owns the agent tool set and the Web panel.
 *
 * There is exactly one per process. Its lifetime is deliberately independent of every
 * office: the tools take the office as an argument and the panel lists whatever offices
 * exist, so both must survive the registry being emptied.
 */
let officeHost

/**
 * Agents currently holding the shared office tool set, keyed by agent.
 *
 * A scope rejects a duplicate tool name, so the set is installed once per agent and
 * withdrawn when the agent holds no office role at all. Only the host installs; see
 * {@link syncOfficeTools} and {@link installOfficeTools}.
 */
const officeToolInstalls = new Map()

/** What may not follow a mentioned name: a longer word is prose, not a mention. */
const MENTION_BOUNDARY_RE = /[\p{L}\p{N}_]/u

/**
 * Resolve the colleagues one message names in its text.
 *
 * A mention is `@` at the message start or after whitespace, followed by a colleague's exact
 * name — longest name first, so a title containing a space matches whole — and ending at a
 * boundary, so `@张三x` is prose rather than a mention of `张三`. The *stored text* decides which
 * colleagues the panel's narrowed post notifies, so no request can notify someone the message
 * does not name, and every client derives the same audience from the same body.
 * @param text - the message body.
 * @param names - the roster's colleague names.
 * @returns the mentioned names, in the order they appear, without duplicates.
 */
function mentionsIn(text, names) {
  const ordered = [...new Set(names)].sort((left, right) => right.length - left.length)
  const found = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue
    if (index > 0 && !/\s/.test(text[index - 1])) continue
    const name = ordered.find((candidate) => {
      if (text.slice(index + 1, index + 1 + candidate.length).toLowerCase() !== candidate.toLowerCase()) return false
      const next = text[index + 1 + candidate.length]
      return next === undefined || !MENTION_BOUNDARY_RE.test(next)
    })
    if (name === undefined) continue
    if (!found.includes(name)) found.push(name)
    index += name.length
  }
  return found
}

/**
 * Validate and complete one row's configuration against its defaults.
 *
 * The Loader passes the row's `config` through unchanged because this plugin declares no
 * `Config` export, so every deployment value is checked here and a bad one fails the
 * activation instead of degrading silently. An unknown key is refused rather than ignored:
 * the host and office rows take different fields, so a field on the wrong kind of row would
 * otherwise look configured while doing nothing.
 * @param raw - the row's `config` object, or undefined.
 * @param defaults - the defaults for this row kind.
 * @param label - the row kind, used in diagnostics.
 * @param rowId - the row's id, which an office row uses as its storage key by default.
 * @returns the complete configuration.
 * @throws {TypeError} when a field has the wrong type, an out-of-range value, or no meaning on this row kind.
 */
function resolveRowConfig(raw, defaults, label, rowId) {
  const config = { ...defaults, ...(raw ?? {}) }
  const positiveInteger = (key) => {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`dsh-office: config.${key} must be a positive safe integer, got ${JSON.stringify(value)}`)
    }
  }
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new TypeError(
        `dsh-office: config.${key} has no meaning on ${label}; it takes ${Object.keys(defaults).sort().join(', ')}`,
      )
    }
  }
  if (typeof config.bossPreset !== 'string' || config.bossPreset.trim().length === 0) {
    throw new TypeError('dsh-office: config.bossPreset must name the agent preset that manages the roster')
  }
  if (config.profilePatch !== undefined
    && (typeof config.profilePatch !== 'string' || config.profilePatch.length === 0)) {
    throw new TypeError('dsh-office: config.profilePatch must be a non-empty path when present')
  }
  if (label === LABEL_HOST) {
    positiveInteger('readLimit')
    positiveInteger('readLimitMax')
    if (config.readLimit > config.readLimitMax) {
      throw new TypeError('dsh-office: config.readLimit must not exceed config.readLimitMax')
    }
    return config
  }
  positiveInteger('maxMessageChars')
  if (typeof config.wakesEnabled !== 'boolean') {
    throw new TypeError(`dsh-office: config.wakesEnabled must be a boolean, got ${JSON.stringify(config.wakesEnabled)}`)
  }
  if (typeof config.userName !== 'string' || config.userName.trim().length === 0) {
    throw new TypeError(`dsh-office: config.userName must be a non-empty name, got ${JSON.stringify(config.userName)}`)
  }
  // Canonical for the same reason a colleague name is: the name travels in tool arguments and in
  // message bodies, and two spellings of it would be two addresses in one office.
  config.userName = canonicalName(config.userName)
  const officeName = canonicalName(config.officeName)
  if (typeof config.officeName !== 'string' || !OFFICE_NAME_RE.test(officeName)) {
    throw new TypeError(
      `dsh-office: config.officeName must be a name of letters, digits, or underscores in any script, `
      + `got ${JSON.stringify(config.officeName)}. `
      + 'A patch override replaces the whole config, so an override of an office row must restate its officeName.',
    )
  }
  config.officeName = officeName
  // The row id is the default storage key because a patch override cannot replace it: an
  // override that dropped an explicit `officeId` would otherwise repoint the office at
  // another storage unit, which is the same failure the row-id dispatch exists to prevent.
  const officeId = config.officeId ?? rowId
  if (typeof officeId !== 'string' || !OFFICE_ID_RE.test(officeId) || officeId.length > OFFICE_ID_MAX_CHARS) {
    throw new TypeError(
      `dsh-office: config.officeId must match ${String(OFFICE_ID_RE)} and be at most `
      + `${String(OFFICE_ID_MAX_CHARS)} characters, got ${JSON.stringify(officeId)}. `
      + 'It defaults to the row id, so a row whose id cannot name a storage unit must set it.',
    )
  }
  config.officeId = officeId
  // A fresh object rather than the shared default, so one row's edit cannot reach another's
  // mapping. A key that is not a predefined role is refused rather than ignored: it would
  // look configured while granting nothing.
  const rolePermissions = config.rolePermissions
  if (rolePermissions === null || typeof rolePermissions !== 'object' || Array.isArray(rolePermissions)) {
    throw new TypeError(
      `dsh-office: config.rolePermissions must be an object mapping a role to a permission preset, `
      + `got ${JSON.stringify(rolePermissions)}`,
    )
  }
  const mapping = {}
  for (const [role, preset] of Object.entries(rolePermissions)) {
    if (!COLLEAGUE_ROLES.includes(role)) {
      throw new TypeError(
        `dsh-office: config.rolePermissions.${role} names no predefined role; it takes ${COLLEAGUE_ROLES.join(', ')}`,
      )
    }
    if (typeof preset !== 'string' || preset.trim().length === 0) {
      throw new TypeError(
        `dsh-office: config.rolePermissions.${role} must name a permission preset, got ${JSON.stringify(preset)}`,
      )
    }
    mapping[role] = preset.trim()
  }
  config.rolePermissions = mapping
  return config
}

/** Row-kind labels, which also name the fields each kind rejects. */
const LABEL_HOST = 'an office host row'
const LABEL_OFFICE = 'an office row'

/**
 * Resolve the host row's configuration.
 *
 * The row id dispatches, so this function is reached only for the row whose id is
 * {@link HOST_ROW_ID}; see {@link apply}.
 * @param raw - the row's `config` object, or undefined.
 * @param rowId - the row's id, unused by the host.
 * @returns the complete host configuration.
 */
function resolveHostConfig(raw, rowId) {
  return resolveRowConfig(raw, DEFAULT_HOST_CONFIG, LABEL_HOST, rowId)
}

/**
 * Resolve one office row's configuration.
 * @param raw - the row's `config` object, which must name its office.
 * @param rowId - the row's id, the office's storage key unless `config.officeId` overrides it.
 * @returns the complete office configuration.
 */
function resolveOfficeConfig(raw, rowId) {
  return resolveRowConfig(raw, DEFAULT_OFFICE_CONFIG, LABEL_OFFICE, rowId)
}

/**
 * Resolve the profile patch this plugin edits to add or remove an office row.
 *
 * Explicit configuration wins; otherwise the launcher's own `profileContext` names the
 * file. Read per request rather than cached, because that service may activate after this
 * plugin does. When neither source exists the office-management routes refuse rather than
 * guess at a path.
 * @param ctx - the plugin context.
 * @param config - the resolved deployment configuration.
 * @returns the patch path, or undefined when the deployment exposes none.
 */
function profilePatchPath(ctx, config) {
  if (typeof config.profilePatch === 'string') return config.profilePatch
  const profile = ctx.get('profileContext')
  const path = profile?.patchPath
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

/**
 * Read the profile patch as a comment-preserving YAML document.
 *
 * The document model is what keeps the user's own comments intact across an edit;
 * parsing to plain data and re-serializing would discard them.
 * @param path - the profile patch file.
 * @returns the parsed document.
 * @throws when the file does not parse or its root is not a sequence.
 */
async function readPatch(path) {
  const document = parseDocument(await readFile(path, 'utf8'))
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('dsh-office: the profile patch must be a YAML sequence')
  return document
}

/**
 * Replace the profile patch with one document, writing beside it first so a partial
 * write can never leave an unparseable file for the next boot.
 * @param path - the profile patch file.
 * @param document - the edited document.
 */
async function writePatch(path, document) {
  const temporary = `${path}.dsh-office.tmp`
  await writeFile(temporary, String(document), { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Locate the profile row that governs one office.
 *
 * A row is found by the name it declares, by the storage key it declares, or by an id this
 * package gives an office row — the stored key, the shipped `office` row, and the `office-<name>`
 * form the panel used to write. The name comes first because it is what a user reads; a
 * key catches the row after the office was renamed, because a rename changes stored data
 * rather than the profile. Matching on a defaulted name instead would mistake any unrelated
 * override, such as `- id: browser`, for an office row.
 *
 * A row mounts only from inside an `insert` list. The Loader reads a top-level patch entry
 * as an id-targeted override of a row an earlier layer created, which is why both forms
 * are located and why they are not equivalent to delete; see the delete route.
 * @param document - the parsed profile patch.
 * @param wanted - the office's current name, and its storage key when one is known.
 * @returns the row's `deleteIn` path — `[item]`, or `[item, 'insert', row]` — or undefined.
 */
function officeRowPath(document, wanted) {
  const matches = (path) => {
    const declaredName = document.getIn([...path, 'config', 'officeName'])
    if (typeof declaredName === 'string' && nameKey(declaredName) === nameKey(wanted.name)) return true
    const declaredId = document.getIn([...path, 'config', 'officeId'])
    if (declaredId !== undefined && declaredId === wanted.officeId) return true
    const id = document.getIn([...path, 'id'])
    if (typeof id !== 'string') return false
    if (wanted.officeId !== undefined && id === wanted.officeId) return true
    // Rows written before an id carried the storage key: this package's own patch ships
    // `office`, and every office the panel used to create was `office-<name>`.
    return id === `office-${wanted.name}`
      || (id === SHIPPED_OFFICE_ROW_ID && nameKey(wanted.name) === SHIPPED_OFFICE_ROW_ID)
  }
  const items = document.contents.items
  for (let position = 0; position < items.length; position += 1) {
    if (matches([position])) return [position]
  }
  for (let position = 0; position < items.length; position += 1) {
    const inserted = document.getIn([position, 'insert'])
    if (!isSeq(inserted)) continue
    for (let row = 0; row < inserted.items.length; row += 1) {
      if (matches([position, 'insert', row])) return [position, 'insert', row]
    }
  }
  return undefined
}

/**
 * Read the identity one profile row declares.
 *
 * The name falls back to the requested one, and the storage key to the row id, which is the
 * same default {@link resolveRowConfig} applies. Both are read from the document rather than
 * from the registry, because the delete route must locate the storage unit of an office that
 * is no longer mounted.
 * @param document - the parsed profile patch.
 * @param path - the row's path in that document.
 * @param fallbackName - the office name the request used.
 * @returns the declared name and storage key, either of which may be undefined.
 */
function rowOfficeIdentity(document, path, fallbackName) {
  const declaredName = document.getIn([...path, 'config', 'officeName'])
  const declaredId = document.getIn([...path, 'config', 'officeId'])
  const rowId = document.getIn([...path, 'id'])
  return {
    name: typeof declaredName === 'string' && declaredName.trim().length > 0
      ? canonicalName(declaredName)
      : canonicalName(fallbackName),
    officeId: typeof declaredId === 'string' ? declaredId : (typeof rowId === 'string' ? rowId : undefined),
  }
}

/**
 * Erase every record one office domain holds and reset its global.
 *
 * The storage backend contract exposes no unit drop, so deletion is expressed through the
 * public domain API: drop every record in every table, then reset the global. The medium
 * is left empty rather than removed, which keeps this backend-agnostic.
 * @param domain - an open office domain.
 * @param identity - the storage key and name to restore after the wipe.
 */
async function purgeDomain(domain, identity) {
  for (const tableName of ['colleagues', 'channels', 'messages', 'pending']) {
    const table = domain.table(tableName)
    for (const key of [...table.keys()]) await table.delete(key)
  }
  await domain.global.set(identity)
}

/** Normalize a colleague or channel name to lowercase kebab-case. */
function normalizeName(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Drop keys whose value is `undefined`.
 *
 * A declared result schema with `additionalProperties: false` types every present
 * key, so an optional field must be absent rather than present-and-undefined when
 * the tool returns an object the model is promised.
 * @param record - the object to project.
 * @returns the object without undefined-valued keys.
 */
function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

/**
 * Build the channel id shared by two colleagues. It is keyed by session id, not by
 * title, so renaming a colleague cannot split one conversation across two channels.
 */
function directMessageChannelId(left, right) {
  const strip = (value) => String(value).replace(/[^a-z0-9]/gi, '')
  return `dm-${[strip(left), strip(right)].sort().join('+')}`
}

/** Build the message record key that orders messages within one channel. */
function messageKey(channelId, seq) {
  return `${channelId}#${String(seq).padStart(12, '0')}`
}

/**
 * Reject a stored record that no longer satisfies its contract, so a hand-edited
 * medium fails loud instead of surfacing as a downstream property access.
 * @param kind - the record kind, for the diagnostic.
 * @param value - the stored record.
 * @returns the validated record.
 */
function requireRecord(kind, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`dsh-office: stored ${kind} record is invalid: ${JSON.stringify(value)}`)
  }
  return value
}

/** Validate one stored colleague record. */
function validateColleague(value) {
  const record = requireRecord('colleague', value)
  if (typeof record.sessionId !== 'string') {
    throw new Error(`dsh-office: stored colleague record is invalid: ${JSON.stringify(value)}`)
  }
  // Both optional fields reach a declared result schema, which types every present key, so a
  // hand-edited medium carrying a number here must fail at the read rather than at the tool.
  if (record.role !== undefined && typeof record.role !== 'string') {
    throw new Error(`dsh-office: stored colleague role is invalid: ${JSON.stringify(value)}`)
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new Error(`dsh-office: stored colleague description is invalid: ${JSON.stringify(value)}`)
  }
  return record
}

/** Validate one stored channel record. */
function validateChannel(value) {
  const record = requireRecord('channel', value)
  if (typeof record.channelId !== 'string' || !Array.isArray(record.members)) {
    throw new Error(`dsh-office: stored channel record is invalid: ${JSON.stringify(value)}`)
  }
  return record
}

/** Validate one stored message record. */
function validateMessage(value) {
  const record = requireRecord('message', value)
  if (typeof record.messageId !== 'string' || typeof record.text !== 'string') {
    throw new Error(`dsh-office: stored message record is invalid: ${JSON.stringify(value)}`)
  }
  // A summary is rendered and read through its coverage, so a record that lost the pair would
  // fail later as an index into nothing rather than here.
  if (record.kind === 'summary'
    && !(Array.isArray(record.covers) && record.covers.length === 2 && record.covers.every(Number.isSafeInteger))) {
    throw new Error(`dsh-office: stored summary record is invalid: ${JSON.stringify(value)}`)
  }
  return record
}

/** How one frame names the destination the message arrived on. */
function whereOf(message) {
  return message.kind === 'dm'
    ? `DM from ${message.senderName}`
    : `#${message.channelName} from ${message.senderName}`
}

/** How a line talks about the channel itself, rather than about who sent what. */
function channelLabel(message) {
  return message.kind === 'dm' ? 'this direct channel' : `#${message.channelName}`
}

/**
 * What a delivered message asks of the colleague that receives it.
 *
 * The office's tools default to waking the whole roster, and a colleague that answers every
 * wake in public multiplies that default: one post wakes every colleague, each woken colleague
 * posts an answer, and the answers wake the office again. Every frame therefore ends with the
 * same rule, stated where the choice is made — the default answer to a delivered message is
 * silence — and a public message adds where an answer belongs when there is one.
 */
const OFFICE_SILENCE_RULE = 'Your reply stays in this session and reaches nobody. Most messages '
  + 'need no answer, and silence is a normal one.'

/** Where an answer belongs when a delivered public message does need one. */
const OFFICE_PUBLIC_ANSWER_RULE = 'To answer the sender alone, use office_dm; to answer the office, '
  + 'use office_post with mentions naming who should read it. Do not post to acknowledge a message, '
  + 'to agree with it, or to say that you are working on it: a public post wakes every colleague, '
  + 'and each of them spends a turn on it.'

/**
 * Where an answer belongs, for the message kind that arrived and the role that received it.
 *
 * Two rules meet here. A direct message never suggests a public post, because turning a private
 * message into a public one is not the recipient's call to make. And the rule cannot name a tool
 * the recipient does not hold: a consultant's scope carries neither `office_post` nor `office_dm`,
 * so telling it to answer with one would spend its turn on a tool that is not there.
 * @param kind - the delivered message's kind: `dm` or `public`.
 * @param role - the receiving colleague's predefined role.
 * @returns the sentence appended to the frame that colleague receives.
 */
function answerRule(kind, role) {
  const capabilities = ROLE_CAPABILITIES[canonicalRole(role)]
  if (!capabilities.includes('post') && !capabilities.includes('dm')) {
    return 'Nothing you write here reaches the office: your role holds no tool that writes to a channel, '
      + 'so whoever needs your answer reads this session.'
  }
  if (kind === 'dm') return 'To answer the sender, use office_dm.'
  return OFFICE_PUBLIC_ANSWER_RULE
}

/**
 * Compose the model-visible framing of one delivered office message.
 *
 * The frame names the destination, the sender, and the message identity so the
 * receiving colleague can attribute and answer it without reading the office domain.
 * It also states where a reply does and does not surface: delivery is a private turn
 * in the target's own session, so nothing anyone else reads happens by answering it.
 *
 * `newestSeq` is how far past this message the channel had already moved when the turn was
 * queued. Without it, a message from ten minutes ago is indistinguishable from a live one,
 * and answering it reads as engaging with something already settled.
 * @param message - the stored message record that triggered the wake.
 * @param newestSeq - the channel's newest sequence when this turn was queued, when known.
 * @param role - the receiving colleague's predefined role, which decides what an answer may use.
 * @returns the framed text delivered as the colleague's user turn.
 */
function frameDelivery(message, newestSeq, role) {
  const answer = `${OFFICE_SILENCE_RULE} ${answerRule(message.kind, role)}`
  const freshness = newestSeq === undefined || newestSeq <= message.seq
    ? undefined
    : `(${channelLabel(message)} had already reached ${message.channelId}-${String(newestSeq)} when this turn was queued. `
      + 'Newer messages are not part of it; office_read reads them.)'
  return [ `[office ${whereOf(message)} | ${message.messageId}]`, message.text, freshness, `(${answer})` ]
    .filter(line => line !== undefined)
    .join('\n\n')
}

/**
 * Compose the one turn a batch of held wakes becomes.
 *
 * A batch is what a colleague that was mid-turn receives: every message that arrived while it
 * worked, in order, each with its own identity, in a single turn. That is the difference
 * between answering a conversation and answering a queue — one turn carries the whole burst,
 * so the colleague responds once instead of writing one reply per message long after each was
 * written. A batch of one is an ordinary frame.
 * @param officeName - the office the wakes came from.
 * @param messages - the batched messages, oldest first.
 * @param newestSeq - the newest sequence of the last message's channel, when known.
 * @param role - the receiving colleague's predefined role, which decides what an answer may use.
 * @returns the framed text delivered as the colleague's user turn.
 */
function frameBatch(officeName, messages, newestSeq, role) {
  if (messages.length === 1) return frameDelivery(messages[0], newestSeq, role)
  const last = messages.at(-1)
  const freshness = newestSeq === undefined || newestSeq <= last.seq
    ? undefined
    : `(${channelLabel(last)} had already reached ${last.channelId}-${String(newestSeq)} when this turn was queued.)`
  const guidance = 'These arrived while your previous turn was running. They are one turn because '
    + 'they arrived together, not because each one asks for an answer. '
    + `${OFFICE_SILENCE_RULE} ${answerRule('public', role)}`
  return [
    `[office ${officeName} | ${String(messages.length)} messages arrived while you were working]`,
    ...messages.map(message => `[office ${whereOf(message)} | ${message.messageId}]\n${message.text}`),
    freshness,
    `(${guidance})`,
  ].filter(line => line !== undefined).join('\n\n')
}

/** Distinguishing short form of a session id, for an unnamed sender in a transcript. */
function shortSessionId(sessionId) {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return bare.slice(0, 8)
}

/**
 * Open the office over one domain and expose the operations the tools use.
 * @param ctx - the plugin context carrying the agent service.
 * @param domain - the opened office domain.
 * @param config - the resolved deployment configuration.
 * @param hooks - `onAdopted`, `onConfigured`, and `onDismissed` run after one session enters or
 *   leaves the roster, or changes the role it holds in it, so the caller can bring that session's
 *   office tool set in line.
 * @returns the office operations.
 */
function createOffice(ctx, domain, config, hooks) {
  const colleagues = domain.table('colleagues')
  const channels = domain.table('channels')
  const messages = domain.table('messages')
  const pendingWakes = domain.table('pending')

  /** The session's committed title, or undefined when none exists yet. */
  const readTitle = async (sessionId) => {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return undefined
    const snapshot = await query.readTitle(sessionId)
    const title = snapshot?.title
    return typeof title === 'string' && title.length > 0 ? title : undefined
  }

  /** The name a session is addressed by: its title, or a short-id fallback. */
  const nameOf = async (sessionId) => (await readTitle(sessionId)) ?? `session-${shortSessionId(sessionId)}`

  /** Adopted colleagues with their current session titles resolved. */
  const listColleagues = async () => {
    const records = [...colleagues.entries()].map(([, value]) => validateColleague(value))
    const named = []
    for (const record of records) named.push({ ...record, name: await nameOf(record.sessionId) })
    return named
  }

  const colleagueBySession = (sessionId) => {
    const record = colleagues.get(sessionId)
    return record === undefined ? undefined : validateColleague(record)
  }

  /**
   * Resolve one colleague from the name the model used. Session titles are not
   * unique, so an ambiguous name fails loud and names the candidates rather than
   * silently addressing one of them.
   */
  const colleagueByName = async (name) => {
    const wanted = nameKey(name)
    if (wanted.length === 0) return undefined
    const matches = (await listColleagues()).filter(colleague => nameKey(colleague.name) === wanted)
    if (matches.length === 0) return undefined
    if (matches.length > 1) {
      throw new Error(
        `"${name}" matches ${matches.length} colleagues (${matches.map(entry => entry.sessionId).join(', ')}); `
        + 'rename one of those sessions so the name addresses exactly one',
      )
    }
    return matches[0]
  }

  const listChannels = () => [...channels.entries()].map(([, value]) => validateChannel(value))

  /** Create the channel when absent and return its current record. */
  const ensureChannel = async (channelId, init) => {
    const existing = channels.get(channelId)
    if (existing !== undefined) return validateChannel(existing)
    const created = { channelId, createdAt: Date.now(), nextSeq: 1, ...init }
    await channels.put(channelId, created)
    return created
  }

  /** Allocate the next message sequence in one channel. */
  const allocateSequence = async (channelId) => {
    const updated = await channels.update(channelId, current => ({ ...current, nextSeq: current.nextSeq + 1 }))
    return updated.nextSeq - 1
  }

  /** Read one channel's messages oldest-first, bounded to the newest `limit`. */
  const readMessages = (channelId, limit) => {
    const prefix = `${channelId}#`
    const keys = []
    for (const key of messages.keys()) {
      if (key.startsWith(prefix)) keys.push(key)
    }
    keys.sort()
    return keys.slice(-limit).map((key) => validateMessage(messages.get(key)))
  }

  /**
   * Every channel one colleague can read: the public channel and its own direct-message ones.
   *
   * The user's mailbox is never in this list. It is the user's private mail, and `office_read`
   * with `channel: "*"` walks exactly this list, so excluding it here is what keeps a colleague
   * from reading mail addressed to the user.
   * @param sessionId - the reading session.
   * @returns the channels it may read.
   */
  const visibleChannels = (sessionId) => listChannels().filter((channel) => {
    if (channel.kind === 'mailbox') return false
    return channel.kind !== 'dm' || channel.members.includes(sessionId)
  })

  /** Record the outcome of one delivery attempt on the message that caused it. */
  const recordDelivery = async (key, colleagueName, entry) => {
    await messages.update(key, current => ({
      ...current,
      deliveries: { ...current.deliveries, [colleagueName]: entry },
    }))
  }

  /**
   * Resolve the model route a cold-resumed colleague runs on.
   *
   * The `provider` and `model` prompt variables read `agent.options`, so a resume
   * without `agentOptions` fails prompt assembly outright. Prefer the route the
   * session itself last logged, then the deployment default.
   */
  const resolveRoute = async (sessionId) => {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      const snapshot = await query.readSession(sessionId)
      for (let index = snapshot.events.length - 1; index >= 0; index--) {
        const event = snapshot.events[index]
        if (event.type !== 'request/header') continue
        const config = event.data?.header?.config
        if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
          return compact({
            provider: config.provider,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
          })
        }
      }
    }
    const fallback = ctx.get('agentDefaultModel')?.currentSelection()
    if (fallback === undefined) {
      throw new Error(
        `dsh-office: cannot resolve a model route for session ${sessionId}; `
        + 'mount a default-model service or give the session a logged request',
      )
    }
    return compact({
      provider: fallback.provider,
      model: fallback.model,
      reasoningEffort: fallback.reasoningEffort,
    })
  }

  /**
   * The live agent of one colleague, cold-resuming its session when it is not loaded.
   *
   * `ctx.agents.resume` is the only harness operation that reaches an inactive ordinary
   * session. The handle is deliberately not retained: the agent stays live in the registry for
   * the plugin's lifetime, because disposing it would tear the session down underneath a
   * browser that has it open.
   * @param sessionId - the colleague's session id.
   * @returns the agent that can be handed a turn.
   */
  const ensureAgent = async (sessionId) => {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live
    // AgentRegistry.resume takes only the options and binds ownership to the
    // calling fiber; the two-argument (ownerCtx, options) form is the
    // lower-level agentLoop factory contract.
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: await resolveRoute(sessionId),
    })
    return handle.agent
  }

  /** The key one held wake is stored under: the waiting colleague, then the message. */
  const pendingKey = (sessionId, messageId) => `${sessionId}#${messageId}`

  /**
   * Hold one wake until its colleague is idle.
   *
   * A colleague that is mid-turn is handed one turn carrying everything that arrived while it
   * worked, rather than one turn per message. A queue of single-message turns makes it answer
   * each message minutes after it was written and answer the last one long after the
   * conversation moved on; a merged turn costs one, and it answers once.
   *
   * The hold is durable because a wake is a promise the office keeps: a restart with wakes
   * still held delivers them instead of dropping them.
   * @param sessionId - the colleague that is mid-turn.
   * @param message - the stored message it has not been handed yet.
   */
  const holdWake = async (sessionId, message) => {
    await pendingWakes.put(pendingKey(sessionId, message.messageId), {
      sessionId,
      channelId: message.channelId,
      seq: message.seq,
      at: Date.now(),
    })
  }

  /**
   * What one colleague is waiting for, oldest first.
   *
   * A message compacted away while it was held is dropped from the batch on purpose: its
   * summary is what replaced it, and the summary is what a reader meets.
   * @param sessionId - the colleague whose held wakes to collect.
   * @returns the held messages with the record key and the message key each is stored under.
   */
  const heldWakes = (sessionId) => {
    const prefix = `${sessionId}#`
    const held = []
    for (const [key, value] of pendingWakes.entries()) {
      if (!key.startsWith(prefix)) continue
      const record = requireRecord('pending', value)
      const keyOfMessage = messageKey(record.channelId, record.seq)
      const message = messages.get(keyOfMessage)
      if (message === undefined) {
        continue
      }
      held.push({ pendingKey: key, messageKey: keyOfMessage, message: validateMessage(message) })
    }
    held.sort((left, right) => left.message.createdAt - right.message.createdAt
      || left.message.channelId.localeCompare(right.message.channelId)
      || left.message.seq - right.message.seq)
    return held
  }

  /**
   * The single turn one batch of wakes becomes.
   *
   * The newest message supplies the turn's identity, so a batch is addressable exactly like a
   * single delivery; every message keeps its own header inside the body.
   * @param batch - the batched messages, oldest first.
   * @param newestSeq - the newest sequence of the last message's channel, when known.
   * @param role - the receiving colleague's predefined role, which decides what the frame may suggest.
   * @returns the message payload to hand to the colleague's session.
   */
  const batchPayload = (batch, newestSeq, role) => {
    const newest = batch.at(-1)
    return {
      id: `office-${newest.messageId}`,
      role: 'user',
      content: [{ type: 'text', text: frameBatch(name(), batch, newestSeq, role) }],
      // Every field here reaches the session log, which is JSON, and the harness rejects a
      // value JSON cannot round-trip — `undefined` among them. A message the user posted
      // from the panel has no sender session, so that field must be absent rather than present
      // and undefined; leaving it in fails the whole delivery with "carries
      // non-JSON-serializable data".
      source: compact({
        kind: 'office-message',
        channelId: newest.channelId,
        messageId: newest.messageId,
        senderName: newest.senderName,
        senderSessionId: newest.senderSessionId,
        ...batch.length > 1 ? { batch: batch.length } : {},
      }),
    }
  }

  /** Release one colleague's held wakes: the records go only after their turn is queued. */
  const releaseWakes = async (sessionId, held, agent) => {
    const colleague = colleagueBySession(sessionId)
    agent.followup(batchPayload(held.map(entry => entry.message), undefined, canonicalRole(colleague?.role)))
    for (const entry of held) {
      await pendingWakes.delete(entry.pendingKey)
      if (messages.get(entry.messageKey) === undefined) continue
      await recordDelivery(entry.messageKey, sessionId, {
        status: 'delivered',
        at: Date.now(),
        batch: held.length,
      })
    }
  }

  /**
   * Hand one colleague everything it is waiting for, as a single turn.
   *
   * Called when it goes idle and once at activation, which is what makes a hold survive a
   * restart. A colleague that is busy again by the time this runs keeps its held wakes: the
   * next idle transition delivers them.
   * @param sessionId - the colleague to deliver to.
   * @returns how many messages that turn carried.
   */
  const flushWakes = async (sessionId) => {
    const held = heldWakes(sessionId)
    if (held.length === 0) return 0
    if (colleagueBySession(sessionId) === undefined) {
      // Nobody is waiting for them any more: a dismissed colleague does not keep the office's
      // messages pending for ever.
      for (const entry of held) await pendingWakes.delete(entry.pendingKey)
      return 0
    }
    const agent = await ensureAgent(sessionId)
    if (agent.status !== 'idle') return 0
    await releaseWakes(sessionId, held, agent)
    return held.length
  }

  /**
   * Deliver the wakes a previous process was holding when it stopped.
   *
   * One turn per colleague, whatever it was waiting for.
   */
  const restoreWakes = async () => {
    const waiting = new Set()
    for (const [, value] of pendingWakes.entries()) {
      const record = requireRecord('pending', value)
      if (typeof record.sessionId === 'string') waiting.add(record.sessionId)
    }
    for (const sessionId of waiting) await flushWakes(sessionId)
  }

  /**
   * Deliver one message into a colleague's session, or hold it until it can be delivered with
   * everything else that arrived meanwhile.
   *
   * A colleague that is idle is handed the message now — together with anything it was already
   * waiting for, because those wakes were held for exactly this moment. One that is mid-turn is
   * not interrupted: nothing is spliced into the turn it is running, and it is not queued a row
   * of stale single-message turns either.
   * @param message - the stored message.
   * @param key - the message's key in the messages table, where the outcome is recorded.
   * @param colleague - the recipient's roster record.
   * @returns `delivered` or `queued`.
   */
  const deliver = async (message, key, colleague) => {
    const agent = await ensureAgent(colleague.sessionId)
    if (agent.status !== 'idle') {
      await holdWake(colleague.sessionId, message)
      await recordDelivery(key, colleague.sessionId, {
        status: 'queued',
        at: Date.now(),
        detail: 'the colleague is mid-turn; it receives this with everything else that arrives before that turn ends',
      })
      return 'queued'
    }
    const held = heldWakes(colleague.sessionId)
    const batch = [...held.map(entry => entry.message), message]
    const newest = readMessages(message.channelId, 1).at(-1)
    agent.followup(batchPayload(batch, newest?.seq, canonicalRole(colleague.role)))
    for (const entry of held) {
      await pendingWakes.delete(entry.pendingKey)
      if (messages.get(entry.messageKey) === undefined) continue
      await recordDelivery(entry.messageKey, colleague.sessionId, {
        status: 'delivered',
        at: Date.now(),
        batch: batch.length,
      })
    }
    await recordDelivery(key, colleague.sessionId, {
      status: 'delivered',
      at: Date.now(),
      ...batch.length > 1 ? { batch: batch.length } : {},
    })
    return 'delivered'
  }

  /** Ensure the two-party direct-message channel exists, keyed by the two session ids. */
  const ensureDirectChannel = async (leftSessionId, rightSessionId, label) => {
    const channelId = directMessageChannelId(leftSessionId, rightSessionId)
    await ensureChannel(channelId, {
      kind: 'dm',
      name: label,
      topic: `direct messages between ${leftSessionId} and ${rightSessionId}`,
      members: [leftSessionId, rightSessionId].sort(),
    })
    return channelId
  }

  /**
   * Whether one name addresses the user rather than a colleague.
   *
   * The user name is configuration, so a deployment that renames the user addresses the mailbox
   * by the name it configured; the comparison is the same case-insensitive one a colleague name
   * gets, because both are names people type.
   * @param name - a name from a tool argument, a request body, or a message body.
   * @returns whether it names the user.
   */
  const isUser = (name) => typeof name === 'string' && nameKey(name) === nameKey(config.userName)

  /**
   * Resolve the names one message addresses into colleagues and the user.
   *
   * A name the office cannot resolve is refused rather than dropped: a wake nobody receives is
   * worse than a call that fails, and the user's name is a recipient like any other.
   * @param names - the caller's names, from `mentions` or `to`.
   * @param tool - the registered tool name, prefixed onto a refusal.
   * @returns the resolved colleagues, and whether the user was addressed.
   */
  const resolveRecipients = async (names, tool) => {
    const list = names ?? []
    if (!Array.isArray(list)) throw new TypeError(`${tool}: mentions must be an array of colleague names`)
    const colleagues = []
    let toUser = false
    for (const raw of list) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      if (isUser(raw)) {
        toUser = true
        continue
      }
      const colleague = await colleagueByName(raw)
      if (colleague === undefined) {
        throw new Error(
          `${tool}: "${raw}" does not match any colleague's session title or the user "${config.userName}"`,
        )
      }
      if (!colleagues.some(entry => entry.sessionId === colleague.sessionId)) colleagues.push(colleague)
    }
    return { colleagues, toUser }
  }

  /**
   * Append one message to the user's mailbox.
   *
   * The user has no session: nothing is woken, nothing is delivered, and there is no delivery
   * record to write, because reading the mailbox is the panel's own read. A message copied here
   * from a channel keeps `origin`, so the panel can say where it was also said.
   * @param request.sender - the sending identity.
   * @param request.text - the body.
   * @param request.origin - `{ channelId, messageId }` when this copies a channel message.
   * @returns the stored mailbox record.
   */
  const mail = async ({ sender, text, origin }) => {
    const channelRecord = channels.get(MAILBOX_CHANNEL)
    if (channelRecord === undefined) {
      throw new Error(`dsh-office: office "${name()}" has no "${MAILBOX_CHANNEL}" channel`)
    }
    const seq = await allocateSequence(MAILBOX_CHANNEL)
    const record = compact({
      messageId: `${MAILBOX_CHANNEL}-${seq}`,
      channelId: MAILBOX_CHANNEL,
      channelName: channelRecord.name,
      kind: 'mailbox',
      seq,
      senderName: sender.name,
      senderSessionId: sender.sessionId,
      recipients: [],
      text,
      createdAt: Date.now(),
      deliveries: {},
      origin,
    })
    await messages.put(messageKey(MAILBOX_CHANNEL, seq), record)
    return record
  }

  /** The delivery outcome a message addressed to the user reports, since no session is woken. */
  const mailboxDelivery = () => ({
    colleague: config.userName,
    status: 'mailbox',
    detail: 'the user has no session to wake; the message waits in the user mailbox',
  })

  /**
   * Append one message and wake every colleague it names. Every named colleague
   * gets a durable delivery record: the wake itself, or the reason it could not be
   * delivered, so a failure is visible rather than a silent drop.
   *
   * A message that also addresses the user is copied into the user mailbox. The public record is
   * written first and the copy second, so the office's own history never depends on the mailbox
   * being writable, and a failure to copy is reported instead of losing the message.
   * @param request - the destination, the sender identity, the body, and the named recipients.
   * @returns the stored message and one delivery outcome per recipient.
   */
  const post = async ({ channel, sender, text, recipients, kind, mentionAll, toUser = false }) => {
    if (text.length > config.maxMessageChars) {
      throw new Error(`dsh-office: message is ${text.length} characters; the limit is ${config.maxMessageChars}`)
    }
    // A direct message to the user is mail and nothing else: there is no colleague to hand it to
    // and no wake to attempt, so it is written to the mailbox and the call is done.
    if (kind === 'dm' && toUser) {
      const mailed = await mail({ sender, text })
      return {
        message: mailed,
        deliveries: [mailboxDelivery()],
      }
    }
    // A broadcast addresses every other colleague; a session never receives its own message.
    const audience = mentionAll
      ? (await listColleagues()).filter(colleague => colleague.sessionId !== sender.sessionId)
      : recipients
    if (kind === 'dm' && audience[0] === undefined) {
      throw new Error('dsh-office: a direct message needs exactly one recipient colleague')
    }
    const channelId = kind === 'dm'
      ? await ensureDirectChannel(
        sender.sessionId,
        audience[0].sessionId,
        `${sender.name} ↔ ${audience[0].name}`,
      )
      : normalizeName(channel)
    const channelRecord = channels.get(channelId)
    if (channelRecord === undefined) {
      throw new Error(`dsh-office: unknown channel "${channelId}"; post to "#general" or use office_dm`)
    }
    const seq = await allocateSequence(channelId)
    const message = {
      messageId: `${channelId}-${seq}`,
      channelId,
      channelName: channelRecord.name,
      kind,
      seq,
      senderName: sender.name,
      senderSessionId: sender.sessionId,
      recipients: audience.map(colleague => colleague.sessionId),
      text,
      createdAt: Date.now(),
      deliveries: {},
    }
    const key = messageKey(channelId, seq)
    await messages.put(key, message)
    const deliveries = toUser
      ? [mailboxDelivery()]
      : []
    if (toUser) {
      try {
        await mail({ sender, text, origin: { channelId, messageId: message.messageId } })
      } catch (error) {
        deliveries[0] = {
          colleague: config.userName,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }
    if (!config.wakesEnabled) {
      return {
        message,
        deliveries: [...deliveries, ...audience.map(c => ({ colleague: c.name, status: 'wakes-disabled' }))],
      }
    }
    for (const colleague of audience) {
      try {
        const status = await deliver(message, key, colleague)
        deliveries.push({ colleague: colleague.name, status })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await recordDelivery(key, colleague.sessionId, { status: 'failed', at: Date.now(), detail })
        deliveries.push({ colleague: colleague.name, status: 'failed', detail })
      }
    }
    return { message, deliveries }
  }

  /**
   * Resolve the sender identity of one tool call. A colleague is named by its session
   * title; any other session falls back to its short id, so a channel transcript never
   * attributes a message to an ambiguous "user".
   */
  const senderOf = async (agent) => {
    if (agent === undefined) throw new Error('dsh-office: this operation requires an owning agent session')
    const sessionId = agent.session.header.id
    return { sessionId, name: await nameOf(sessionId) }
  }

  /**
   * Adopt one session, keyed by its durable id. The colleague's name is the session
   * title, so renaming that session from any other surface renames the colleague too.
   *
   * The stored role is canonicalized on every write, which is what migrates a record that
   * predates the predefined roles: a free-text label reads — and is rewritten — as
   * {@link DEFAULT_COLLEAGUE_ROLE} rather than surviving as a permission nobody can resolve.
   * @param request - the session, and the role and description to store.
   * @returns the stored colleague record.
   */
  const adopt = async ({ sessionId, role, description }) => {
    const existing = colleagueBySession(sessionId)
    if (role !== undefined) requireRole(role, 'adopt')
    const nextRole = canonicalRole(role ?? existing?.role)
    // The role's permission preset is applied before the record is written, so a role whose
    // restriction this deployment cannot enforce fails the adopt instead of being stored.
    const permission = await applyRolePermission(sessionId, nextRole)
    const record = compact({
      sessionId,
      role: nextRole,
      description: description === undefined ? existing?.description : normalizeDescription(description, 'adopt'),
      adoptedAt: existing?.adoptedAt ?? Date.now(),
    })
    await colleagues.put(sessionId, record)
    hooks.onAdopted(sessionId)
    return { record, permission }
  }

  /**
   * Change the role and description one colleague record carries.
   *
   * A key the caller omits keeps its stored value, and an explicit empty description removes
   * it, so the two fields are set independently.
   * @param sessionId - the colleague's session.
   * @param changes - `role` and/or `description`, the latter as `undefined` to remove.
   * @returns the stored record.
   * @throws {Error} when the session is not a colleague of this office.
   */
  const configure = async (sessionId, changes) => {
    const existing = colleagueBySession(sessionId)
    if (existing === undefined) {
      throw new Error(`dsh-office: session ${sessionId} is not a colleague of office "${name()}"`)
    }
    if (Object.hasOwn(changes, 'role')) requireRole(changes.role, 'configure')
    const nextRole = canonicalRole(Object.hasOwn(changes, 'role') ? changes.role : existing.role)
    // Only a role change touches the session's permission. Re-applying it on a description-only
    // change would revert a preset the user switched by hand, which is their own act.
    const permission = Object.hasOwn(changes, 'role')
      ? await applyRolePermission(sessionId, nextRole)
      : undefined
    const record = compact({
      ...existing,
      role: nextRole,
      description: Object.hasOwn(changes, 'description')
        ? (changes.description === undefined ? undefined : normalizeDescription(changes.description, 'configure'))
        : existing.description,
    })
    await colleagues.put(sessionId, record)
    hooks.onConfigured(sessionId)
    return { record, permission }
  }

  /**
   * Enforce the office row's role → permission map on one colleague's session.
   *
   * The role's office capabilities are enforced by which tools the session holds; this is the
   * other half of the role, the DSH permission preset its session runs under. It is applied
   * when the role is set — at hire, at adopt, and at configure — and deliberately NOT re-applied
   * on every turn: switching a session's preset from the Web UI is the user's own explicit
   * act, and reverting it silently at the next wake would be a surprise. The drift stays
   * visible instead, because the roster reports each colleague's effective preset.
   *
   * A role the map does not name leaves the session's own permission alone, and a mapping whose
   * preset the deployment does not define is refused rather than skipped: a restriction that
   * did not apply must not look like one that did.
   * @param sessionId - the colleague's session.
   * @param role - the role being set.
   * @returns the effective preset, or undefined when the map names none for this role.
   */
  const applyRolePermission = async (sessionId, role) => {
    const preset = config.rolePermissions[canonicalRole(role)]
    if (preset === undefined) return undefined
    const service = ctx.get('permissionPresets')
    if (service === undefined) {
      throw new Error(
        `dsh-office: office "${name()}" maps role "${canonicalRole(role)}" to permission preset "${preset}", `
        + 'but this deployment mounts no permission presets; mount @deepseek-ai/dsh-permission-presets or '
        + 'remove that entry from the office row\'s rolePermissions',
      )
    }
    if (!service.names.includes(preset)) {
      throw new Error(
        `dsh-office: office "${name()}" maps role "${canonicalRole(role)}" to permission preset "${preset}", `
        + `which this deployment does not define; available: ${service.names.join(', ')}`,
      )
    }
    let agent
    try {
      agent = await ensureAgent(sessionId)
    } catch (error) {
      throw new Error(
        `dsh-office: cannot apply permission preset "${preset}" for role "${canonicalRole(role)}" to session `
        + `${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    service.set(agent.session, preset)
    return currentPermission(agent)
  }

  /** The permission preset one colleague's live session currently runs under, when it can be read. */
  const currentPermission = (agent) => {    const service = ctx.get('permissionPresets')
    if (service === undefined) return undefined
    try {
      return service.current(agent.session)
    } catch {
      // An unreadable projection is reported as an absent preset rather than failing the read:
      // the roster is an inspection surface, not a gate.
      return undefined
    }
  }

  /** Newest office message time per session: what it sent, and what was addressed to it. */
  const lastMessageTimes = () => {
    const times = new Map()
    const bump = (sessionId, at) => {
      if (typeof sessionId !== 'string' || !Number.isSafeInteger(at)) return
      if ((times.get(sessionId) ?? 0) >= at) return
      times.set(sessionId, at)
    }
    for (const [, value] of messages.entries()) {
      const message = validateMessage(value)
      bump(message.senderSessionId, message.createdAt)
      for (const sessionId of message.recipients ?? []) bump(sessionId, message.createdAt)
    }
    return times
  }

  /** The live agent of one session, or undefined when that session is not loaded. */
  const liveAgent = (sessionId) => ctx.agents.get(sessionId)

  /**
   * The roster with each colleague's live status, for the roster tools and the panel.
   *
   * Status is read from the live agent when the session is loaded and is `inactive` when it is
   * not, because an unloaded colleague has no turn to be in either state of. The effective
   * permission preset and the model route are reported only for a loaded session: they are
   * properties of that live agent, and guessing them from storage would report a fact this
   * office does not hold.
   * @returns one record per colleague, in roster order.
   */
  const rosterStatus = async () => {
    const list = await listColleagues()
    const times = lastMessageTimes()
    return list.map((colleague) => {
      const live = liveAgent(colleague.sessionId)
      return compact({
        name: colleague.name,
        sessionId: colleague.sessionId,
        role: canonicalRole(colleague.role),
        description: colleague.description,
        status: live === undefined ? 'inactive' : live.status,
        permission: live === undefined ? undefined : currentPermission(live),
        provider: live === undefined ? undefined : live.options.provider,
        model: live === undefined ? undefined : live.options.model,
        pending: heldWakes(colleague.sessionId).length,
        lastMessageAt: times.get(colleague.sessionId),
        adoptedAt: colleague.adoptedAt,
      })
    })
  }

  /** Set the session title that every surface displays as the colleague's name. */
  const rename = async (sessionId, title) => {
    const trimmed = typeof title === 'string' ? title.trim() : ''
    if (trimmed.length === 0) throw new TypeError('a colleague name must be a non-empty string')
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      throw new Error('dsh-office: renaming requires the session controller; mount @deepseek-ai/dsh-api-session-controller')
    }
    await controller.rename({ sessionId, title: trimmed })
    return trimmed
  }

  /**
   * Open a new colleague's conversation with one private turn.
   *
   * A session is blank until it takes a turn, and the Web workspace tree hides a blank
   * session unless it is the selected one: a colleague nobody has spoken to yet is invisible
   * in the workspace it was hired into, and knows nothing about the office it joined. One
   * message solves both — the delivered turn clears the blank state, and the body names the
   * colleague, the office, its role, and the tools that role holds.
   *
   * Onboarding is a private turn and nothing else: it is not written to `#general` or to any
   * other channel, so the office's public history stays a record of work rather than of
   * arrivals, and no colleague is notified of a hire. The turn itself is durable in the new
   * colleague's own session log, which is what the harness requires of anything a model sees.
   *
   * The greeting is best-effort: a delivery that fails reports its reason and leaves the hire
   * itself intact, so the caller learns about it instead of losing the colleague.
   * @param colleague - the roster record of the colleague just hired.
   * @returns the delivery status the hire reports.
   */
  const greet = async (colleague) => {
    if (!config.wakesEnabled) return 'wakes-disabled'
    const role = canonicalRole(colleague.role)
    const held = ROLE_CAPABILITIES[role]
    // The greeting names the tools this colleague actually holds, because the role decides them:
    // a consultant told about office_post would spend its first turn on a tool it does not have.
    const described = [
      'office_read reads #general or a direct channel',
      'office_colleagues lists the roster with each colleague\'s role, description, and current status',
      held.includes('post') ? 'office_post says something in #general, where the rest of the office can read it' : undefined,
      held.includes('dm') ? 'office_dm sends one colleague a private message' : undefined,
      held.includes('interrupt')
        ? 'office_interrupt cancels a colleague\'s running turn, which then receives everything the office held for it as one turn'
        : undefined,
      held.includes('compact')
        ? 'office_compact replaces a range of a channel\'s messages with a summary you wrote'
        : undefined,
      held.includes('configure') ? 'office_configure sets a colleague\'s role or description' : undefined,
    ].filter(line => line !== undefined)
    const body = [
      `You are "${colleague.name}", a colleague of the office "${name()}".`,
      `Your role: ${role}.`,
      colleague.description === undefined ? undefined : `Notes on you: ${colleague.description}.`,
      `This office is a set of ordinary sessions. You hold ${String(described.length)} `
      + `${described.length === 1 ? 'tool' : 'tools'}: ${described.join('; ')}.`,
      held.includes('post') || held.includes('dm')
        ? undefined
        : 'You hold no tool that writes into the office: what you answer in this session reaches no '
          + 'channel, and the office reads the record rather than your replies.',
      'The office has a history from before you joined, and nothing replays it. Read the range you'
      + ' need with office_read, which takes a sequence range and filters by sender, text, mention,'
      + ' or time; a channel that grew long holds summaries where older messages were compacted.',
      'A message delivered to you is a private turn in your own session, and what you answer here'
      + ' reaches nobody. Most messages need no answer, and silence is a normal one.',
      held.includes('post')
        ? '#general is the office\'s shared record, not a chat room. A post there wakes every colleague'
          + ' and each of them spends a turn on it, so post when the whole office needs to know'
          + ' something, and answer one colleague with office_dm. Do not post to acknowledge a message,'
          + ' to agree with it, or to announce that you are working.'
        : undefined,
      'You do not need to announce yourself in #general, and nobody is waiting on you yet. Answer'
      + ' this message briefly, then wait for real work.',
    ].filter(line => line !== undefined).join('\n')
    const payload = {
      id: `office-hire-${colleague.sessionId}`,
      role: 'user',
      content: [{
        type: 'text',
        text: `[office ${name()} | you were hired]\n${body}\n\n`
          + '(This is a private note from the office; nothing here was posted to a channel. '
          + 'Your reply stays in this session and reaches nobody, and it does not need to be posted'
          + ' anywhere.)',
      }],
      // A source kind and identity are required on every delivered turn; this one belongs to no
      // channel, and says so rather than naming a channel it was never written to.
      source: compact({
        kind: 'office-message',
        channelId: 'office-onboarding',
        messageId: `onboarding-${colleague.sessionId}`,
        senderName: config.userName,
      }),
    }
    try {
      const agent = await ensureAgent(colleague.sessionId)
      agent.followup(payload)
      return 'delivered'
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Create a fresh ordinary session and adopt it in one step.
   *
   * Creation goes through the host session controller rather than `ctx.agents.create`:
   * the controller is what attaches the session to a workspace, and therefore what
   * makes the new colleague appear in the Web sidebar.
   */
  const hire = async ({
    name,
    role,
    description,
    workspaceId,
    cwd,
    agentPreset,
    provider,
    model,
    reasoningEffort,
  }) => {
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      throw new Error('dsh-office: hiring requires the session controller; mount @deepseek-ai/dsh-api-session-controller')
    }
    const registry = ctx.get('workspaceRegistry')
    // Default to the caller's own workspace. The registry's order is not a preference,
    // and a colleague placed in an unrelated workspace is effectively invisible.
    const own = cwd === undefined ? undefined : await registry?.resolveByPath(cwd)
    const requested = workspaceId ?? own?.id ?? registry?.list()[0]?.id
    if (requested === undefined) {
      throw new Error('dsh-office: hiring needs a workspace to create the session in; pass workspace_id')
    }
    if ((provider === undefined) !== (model === undefined)) {
      throw new TypeError('dsh-office: a model route needs both provider and model')
    }
    // The role is validated before the session exists: a name that cannot be a title, or a role
    // nobody defined, must be refused before a session is created for it.
    const nextRole = role === undefined ? undefined : requireRole(role, 'hire')
    const created = await controller.create(compact({ workspaceId: requested, agentPreset }))
    const title = await rename(created.sessionId, name)
    if (provider !== undefined && model !== undefined) {
      await controller.selectModel(compact({
        sessionId: created.sessionId,
        provider,
        model,
        reasoningEffort,
      }))
    }
    const { record, permission } = await adopt({ sessionId: created.sessionId, role: nextRole, description })
    const greeting = await greet({ ...record, name: title })
    return {
      colleague: { ...record, name: title },
      workspaceId: requested,
      agentPreset: created.agentPreset,
      permission,
      greeting,
    }
  }

  /**
   * Remove one session from the roster.
   *
   * The session itself is untouched — it keeps its history, its workspace, and its
   * messages — and only loses its place in the roster and the channel tools.
   * @param sessionId - the session to remove.
   * @returns the removed row with its resolved name, or undefined when it was not a colleague.
   */
  const dismiss = async (sessionId) => {
    const existing = colleagueBySession(sessionId)
    if (existing === undefined) return undefined
    const name = await nameOf(sessionId)
    await colleagues.delete(sessionId)
    // A dismissed colleague does not keep the office's messages pending: nothing will deliver
    // them, and the office would hold them for ever.
    for (const entry of heldWakes(sessionId)) await pendingWakes.delete(entry.pendingKey)
    hooks.onDismissed(sessionId)
    return { ...existing, name }
  }

  /**
   * Replace a sequence range of one channel with a single summary record, in place.
   *
   * The summary takes the lowest sequence of the range, so anyone reading the channel from
   * the start reads one coherent narrative where the summary stands exactly where the
   * messages it replaced stood. Compacting a range that already contains a summary absorbs
   * that summary's own coverage, which keeps `covers` a description of what is gone rather
   * than of what one call happened to name.
   *
   * The message sequences are not renumbered and nothing is replayed: a message delivered
   * before the compaction stays in the transcript of whoever received it, and anyone reading
   * the channel afterwards meets the summary where the removed messages used to be.
   * @param channelId - the channel to compact.
   * @param from - the first sequence to replace, inclusive.
   * @param to - the last sequence to replace, inclusive.
   * @param text - the summary the boss wrote for the range.
   * @param sender - the boss's identity, recorded as the summary's author.
   * @returns the coverage, the replaced count, and the summary's message id.
   */
  const compactRange = async ({ channelId, from, to, text, sender }) => {
    const channel = channels.get(channelId)
    if (channel === undefined) throw new Error(`dsh-office: unknown channel "${channelId}"`)
    if (text.length > config.maxMessageChars) {
      throw new Error(`dsh-office: a summary is ${text.length} characters; the limit is ${config.maxMessageChars}`)
    }
    const named = readMessages(channelId, Infinity).filter(m => m.seq >= from && m.seq <= to)
    if (named.length === 0) {
      throw new Error(`dsh-office: #${channel.name} has no messages in ${from}..${to}`)
    }
    let lower = from
    let upper = to
    for (const message of named) {
      if (!Array.isArray(message.covers)) continue
      lower = Math.min(lower, message.covers[0])
      upper = Math.max(upper, message.covers[1])
    }
    const covered = readMessages(channelId, Infinity).filter(m => m.seq >= lower && m.seq <= upper)
    for (const message of covered) await messages.delete(messageKey(channelId, message.seq))
    const record = compact({
      messageId: `${channelId}-${lower}`,
      channelId,
      channelName: channel.name,
      kind: 'summary',
      seq: lower,
      senderName: sender.name,
      senderSessionId: sender.sessionId,
      recipients: [],
      text,
      createdAt: Date.now(),
      deliveries: {},
      covers: [lower, upper],
      replaced: covered.length,
    })
    await messages.put(messageKey(channelId, lower), record)
    return { summaryId: record.messageId, covers: [lower, upper], replaced: covered.length }
  }

  /**
   * The office's current name.
   *
   * The stored global is authoritative once it exists, so a rename survives a restart; the
   * configured name seeds it the first time this office's storage is created.
   */
  const name = () => {
    const value = domain.global.get()
    return typeof value?.name === 'string' && value.name.trim().length > 0
      ? canonicalName(value.name)
      : config.officeName
  }

  /**
   * Rename the office.
   *
   * Only the stored name changes. The office id stays the key behind its storage unit, so a
   * rename keeps every colleague and message, and the panel addresses the office by name
   * afterwards.
   * @param next - the new name.
   * @returns the stored name.
   * @throws {TypeError} when the name is empty or outside {@link OFFICE_NAME_RE}.
   */
  const renameOffice = async (next) => {
    const canonical = canonicalName(next)
    if (typeof next !== 'string' || !OFFICE_NAME_RE.test(canonical)) {
      throw new TypeError(`an office name must be letters, digits, or underscores in any script, got ${JSON.stringify(next)}`)
    }
    await domain.global.set({ officeId: config.officeId, name: canonical })
    return canonical
  }

  /**
   * Erase everything this office holds, leaving it open and empty.
   *
   * Used when the user deletes the office: the roster, the channels, and every
   * message go, and the name returns to the configured one.
   */
  const purge = () => purgeDomain(domain, { officeId: config.officeId, name: config.officeName })

  return {
    name,
    renameOffice,
    purge,
    listColleagues,
    colleagueByName,
    colleagueBySession,
    nameOf,
    listChannels,
    visibleChannels,
    ensureChannel,
    readMessages,
    resolveRecipients,
    isUser,
    mail,
    adopt,
    configure,
    applyRolePermission,
    rosterStatus,
    liveAgent,
    dismiss,
    rename,
    hire,
    post,
    compactRange,
    flushWakes,
    restoreWakes,
    senderOf,
    generalChannel: GENERAL_CHANNEL,
    mailboxChannel: MAILBOX_CHANNEL,
    userName: config.userName,
  }
}

/** Reject an absent or non-string tool text argument at the model boundary. */
function requireText(args, tool) {
  const value = args?.text
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${tool}: text must be a non-empty string`)
  }
  return value
}

/** The declared result schema shared by `office_post` and `office_dm`. */
function officePostSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['office', 'message', 'deliveries'],
    properties: {
      office: { type: 'string' },
      message: {
        type: 'object',
        additionalProperties: false,
        required: ['messageId', 'channelId', 'text'],
        properties: {
          messageId: { type: 'string' },
          channelId: { type: 'string' },
          text: { type: 'string' },
        },
      },
      deliveries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['colleague', 'status'],
          properties: {
            colleague: { type: 'string' },
            status: { type: 'string' },
            detail: { type: 'string' },
          },
        },
      },
    },
  }
}

/**
 * Project one stored message onto the declared `office_post`/`office_dm` result.
 * The domain record carries bookkeeping fields the model must not receive, and
 * the registry rejects an undeclared field because the result schema sets
 * `additionalProperties: false`.
 * @param posted - the value returned by the office `post` operation.
 * @param officeName - the posting office's immutable name, which the result carries so its
 *   presenter can name the office without reading the call's arguments.
 * @returns the value matching {@link officePostSchema}.
 */
function toPostResult(posted, officeName) {
  return {
    office: officeName,
    message: {
      messageId: posted.message.messageId,
      channelId: posted.message.channelId,
      text: posted.message.text,
    },
    deliveries: posted.deliveries,
  }
}

/**
 * Model-facing summary of one post and its delivery outcomes.
 * @param value - the declared post result, which names the office that produced it.
 * @returns the rendered content blocks.
 */
function renderPostResult(value) {
  const destination = value.message.channelId === MAILBOX_CHANNEL ? "the user's mailbox" : value.message.channelId
  const head = `[${value.office}] Posted ${value.message.messageId} to ${destination}.`
  if (value.deliveries.length === 0) {
    return `${head} No colleague was woken; the message waits in the office for office_read.`
  }
  const lines = value.deliveries
    .map(d => `- ${d.colleague}: ${d.status}${d.detail === undefined ? '' : ` (${d.detail})`}`)
    .join('\n')
  return `${head} Delivery:\n${lines}`
}

/**
 * Resolve the channel one direct-message tool call addresses, from the caller's view.
 *
 * The user's mailbox is refused here rather than by each caller: it is not a direct channel
 * between two sessions, and no office tool may read it, so the refusal lives with the
 * resolution every reading tool shares.
 */
async function resolveDirectChannel(office, sender, requested, caller) {
  if (office.isUser(requested) || nameKey(requested) === nameKey(MAILBOX_CHANNEL)) {
    throw new Error(`${caller}: "${requested}" is the user's mailbox, which no office tool reads`)
  }
  const other = await office.colleagueByName(requested)
  if (other === undefined) {
    throw new Error(`${caller}: "${requested}" is neither "#general" nor a known colleague`)
  }
  if (sender === undefined) {
    throw new Error(`${caller}: addressing a direct-message channel requires an owning agent session`)
  }
  return directMessageChannelId(sender.sessionId, other.sessionId)
}

/**
 * The `office` argument one role's tools carry.
 *
 * A boss names the office it acts on, because one boss preset may run several offices. A
 * colleague is routed to the office that adopted it and carries the name only to choose
 * when more than one office holds it, so the argument can never reach another office's
 * data — a name the caller does not belong to is refused.
 * @param role - `boss` or `colleague`.
 * @returns the property schema every office tool declares, and whether the role's schemas
 *   must require it.
 */
function officeArgument(role) {
  return {
    property: {
      type: 'string',
      description: role === 'boss'
        ? 'The office to act on, named by its office name. office_list reports the offices this session runs.'
        : 'Optional office name. Omit it to act on the office that adopted you; pass it only to choose when several offices hold you.',
    },
    required: role === 'boss',
  }
}

/**
 * The mounted offices one agent may act on, the role it acts as, and the capabilities it holds.
 *
 * A matching boss preset wins over membership: a session that runs one office and was also
 * adopted by another acts as the boss of the offices it runs, never as their colleague.
 *
 * A colleague may belong to several offices and hold a different predefined role in each, and
 * the capability set is a property of the *agent*, not of one membership — so it is the union of
 * the roles' capabilities. The union grants the tool; the capability is checked again against the
 * office a call resolved, so a membership that does not hold it cannot use the tool there.
 * @param agent - the agent whose scope is resolving an office.
 * @returns the agent's acting role, the capabilities it holds, and the offices it may act on.
 */
function actingOffices(agent) {
  const preset = agent.session.header.agentPreset
  const running = [...mountedOffices.values()].filter(entry => entry.bossPreset === preset)
  if (running.length > 0) {
    return { role: 'boss', capabilities: [...BOSS_CAPABILITIES], offices: running }
  }
  const sessionId = agent.session.header.id
  const memberships = [...mountedOffices.values()]
    .map(entry => ({ entry, record: entry.office.colleagueBySession(sessionId) }))
    .filter(membership => membership.record !== undefined)
  const capabilities = new Set()
  for (const membership of memberships) {
    for (const capability of ROLE_CAPABILITIES[canonicalRole(membership.record.role)]) capabilities.add(capability)
  }
  return {
    role: 'colleague',
    capabilities: [...capabilities],
    offices: memberships.map(membership => membership.entry),
  }
}

/**
 * The predefined role, or `boss`, one agent holds in one mounted office.
 * @param agent - the agent whose membership is read.
 * @param entry - the mounted office entry.
 * @returns `boss`, a predefined colleague role, or undefined when the session belongs to neither.
 */
function roleInOffice(agent, entry) {
  if (agent.session.header.agentPreset === entry.bossPreset) return 'boss'
  const record = entry.office.colleagueBySession(agent.session.header.id)
  return record === undefined ? undefined : canonicalRole(record.role)
}

/**
 * Resolve the office one call acts on.
 *
 * Every failure names the offices the caller may act on, so a caller that guessed wrong
 * recovers in one step instead of retrying blind. The office argument is revalidated here
 * rather than trusted from the schema, because a tool schema is not enforcement. It is
 * matched by name first — names are canonical and case-insensitive — and by storage key
 * second, so a caller that learned an id still resolves.
 * @param acting - the resolution {@link actingOffices} produced for the calling agent.
 * @param requested - the call's `office` argument, when the caller supplied one.
 * @param tool - the registered tool name, prefixed onto every failure message.
 * @returns the resolved mounted-office entry, which carries the office and its own config.
 * @throws {Error} when the caller acts on no office, named one it may not act on, or
 *   omitted a name it needed to choose.
 */
function resolveActingOffice(acting, requested, tool) {
  const { role, offices } = acting
  const listing = () => offices.map(entry => `"${entry.name}"`).join(', ')
  if (offices.length === 0) {
    throw new Error(`${tool}: this session neither runs nor belongs to a mounted office`)
  }
  const named = typeof requested === 'string' && requested.trim().length > 0 ? canonicalName(requested) : undefined
  if (named !== undefined) {
    const key = nameKey(named)
    const match = offices.find(entry => nameKey(entry.name) === key)
      ?? offices.find(entry => entry.id === named)
    if (match === undefined) {
      throw new Error(`${tool}: "${named}" is not an office this session acts on; it acts on ${listing()}`)
    }
    return match
  }
  if (role === 'boss') {
    throw new Error(`${tool}: office is required; this session runs ${listing()}`)
  }
  if (offices.length > 1) {
    throw new Error(
      `${tool}: this colleague belongs to ${String(offices.length)} offices — pass office to choose one of ${listing()}`,
    )
  }
  return offices[0]
}

/**
 * The per-agent helpers every office tool shares.
 *
 * The caller is closed over rather than read from `ToolRunContext.agent`, which is
 * optional. Schemas are declared through {@link parameters} so the role's `office`
 * argument is added in exactly one place.
 * @param agent - the agent whose scope receives these tools.
 * @param acting - the resolution {@link actingOffices} produced for that agent.
 * @returns the content-block helper, the office resolver, the capability gate, and the
 *   declaration helper.
 */
function officeToolContext(agent, acting) {
  const text = (value) => [{ type: 'text', text: value }]
  const argument = officeArgument(acting.role)
  // The office argument is resolved against the registry as it is NOW, not against the set the
  // tools were built from: a tool is installed once and a session can join or leave an office
  // between two calls, so a captured list would route a call by a roster that no longer holds.
  const entry = (args, tool) => resolveActingOffice(actingOffices(agent), args?.office, tool)
  return {
    text,
    entry,
    /** The capabilities this agent holds, which decide which tools are built at all. */
    capabilities: acting.capabilities,
    /** The predefined role, or `boss`, this session holds in each office it acts on. */
    roleIn: (resolved) => roleInOffice(agent, resolved),
    /**
     * Refuse one call whose capability the resolved office's role does not hold.
     *
     * The tool is registered from the union of every membership's capabilities, so this is where
     * a colleague that is a leader of one office and a member of another is held to the office it
     * actually addresses. A boss holds every capability by definition.
     * @param resolved - the mounted office entry the call resolved.
     * @param capability - the capability the tool needs.
     * @param tool - the registered tool name, prefixed onto the failure message.
     * @throws {Error} when the caller's role in that office does not hold the capability.
     */
    require(resolved, capability, tool) {
      const held = roleInOffice(agent, resolved)
      if (held === 'boss') return
      if (held !== undefined && ROLE_CAPABILITIES[held].includes(capability)) return
      throw new Error(held === undefined
        ? `${tool}: this session is not a colleague of office "${resolved.name}"`
        : `${tool}: the "${held}" role in office "${resolved.name}" holds no ${capability} permission `
          + `(it holds ${ROLE_CAPABILITIES[held].join(', ')})`,
      )
    },
    /**
     * Declare one tool's parameters, including the role's `office` argument.
     * @param required - the tool's own required argument names.
     * @param properties - the tool's own property schemas.
     * @returns the parameter object for one tool definition.
     */
    parameters(required, properties) {
      return {
        type: 'object',
        additionalProperties: false,
        required: argument.required ? ['office', ...required] : required,
        properties: { office: argument.property, ...properties },
      }
    },
  }
}

/**
 * Find a mounted office by whatever names it: its name, or its storage key.
 *
 * The name is what a user and the model read, so it is matched first and
 * case-insensitively; the key resolves a caller that learned an id instead — for example a
 * session log written before the office was renamed.
 * @param wanted - an office name or storage key.
 * @returns the mounted entry, or undefined when no mounted office answers to it.
 */
function findMountedOffice(wanted) {
  const canonical = canonicalName(wanted)
  if (canonical.length === 0) return undefined
  const key = nameKey(canonical)
  return [...mountedOffices.values()].find(entry => nameKey(entry.name) === key)
    ?? mountedOffices.get(canonical)
}

/**
 * Build the roster-management tools for one boss agent.
 *
 * A boss runs the office, so it holds every tool the office has: it manages the roster,
 * reads any channel, and posts like any other participant. These are installed only into
 * an agent whose preset runs an office, never globally — organizing a roster is a role,
 * not a capability every session holds.
 * @param agent - the boss agent whose scope receives these tools.
 * @param host - the hosting office's configuration and service readers.
 * @param tool - the caller's shared declaration helpers.
 * @returns the management tool definitions.
 */
function createManagementTools(agent, host, tool) {
  const { config, resolveQuery } = host
  const { text } = tool

  /**
   * List recent sessions that are not colleagues yet. `sessionQuery` is mounted by the Web
   * composition but is not part of the base guarantee, so an absent service reports an
   * empty list: adoption itself needs only a session id.
   * @param office - the office whose roster the listing excludes.
   * @returns the adoptable sessions, newest first.
   */
  const findUnadopted = async (office) => {
    const query = resolveQuery()
    if (query === undefined) return []
    const adopted = new Set((await office.listColleagues()).map(colleague => colleague.sessionId))
    const records = await query.listSessions()
    return records
      .filter(record => !adopted.has(record.header.id))
      .slice(0, config.readLimitMax)
      .map(record => compact({
        sessionId: record.header.id,
        title: typeof record.title === 'string' ? record.title : undefined,
        updatedAt: new Date(record.header.createdAt).toISOString(),
      }))
  }

  return [
    {
      name: 'office_list',
      description:
        'List the offices this session runs. A boss preset may run several offices at once, and every other '
        + 'office tool takes the office to act on by the name reported here.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['offices'],
          properties: {
            offices: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['office', 'colleagues'],
                properties: {
                  office: { type: 'string' },
                  colleagues: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => tool.text(value.offices.length === 0
          ? 'This session runs no office.'
          : `Offices this session runs:\n${value.offices
            .map(o => `- ${o.office}, ${String(o.colleagues)} colleague(s)`)
            .join('\n')}`),
      },
      async execute() {
        return {
          offices: await Promise.all(actingOffices(agent).offices.map(async entry => ({
            office: entry.name,
            colleagues: (await entry.office.listColleagues()).length,
          }))),
        }
      },
    },
    {
      name: 'office_roster',
      description:
        'List the colleague roster and the available channels of one office. A colleague is an ordinary '
        + 'session adopted by id, and it is addressed by that session\'s title — renaming the session renames '
        + 'the colleague. Set include_unadopted to also see recent sessions that are not colleagues yet and '
        + 'can be adopted with office_adopt.',
      parameters: tool.parameters([], {
        include_unadopted: {
          type: 'boolean',
          description: 'Also list recent sessions that are not colleagues yet.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['office', 'colleagues', 'channels'],
          properties: {
            office: { type: 'string' },
            colleagues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'sessionId'],
                properties: {
                  name: { type: 'string' },
                  sessionId: { type: 'string' },
                  role: { type: 'string', enum: COLLEAGUE_ROLES },
                  description: { type: 'string' },
                },
              },
            },
            channels: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['channelId', 'kind', 'members'],
                properties: {
                  channelId: { type: 'string' },
                  kind: { type: 'string', enum: ['public', 'dm', 'mailbox'] },
                  topic: { type: 'string' },
                  members: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            unadopted: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sessionId', 'updatedAt'],
                properties: {
                  sessionId: { type: 'string' },
                  title: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const roster = value.colleagues.length === 0
            ? 'No colleagues yet.'
            : value.colleagues
              .map(c => `- ${c.name} (${c.role})${c.description === undefined ? '' : ` — ${c.description}`} `
                + `— session ${c.sessionId}`)
              .join('\n')
          const channelList = value.channels
            .map(c => `- ${c.kind === 'dm' ? c.channelId : `#${c.channelId}`}`)
            .join('\n')
          const extra = value.unadopted === undefined || value.unadopted.length === 0
            ? ''
            : `\n\nAdoptable sessions:\n${value.unadopted
              .map(s => `- ${s.sessionId}${s.title === undefined ? '' : ` — ${s.title}`}`)
              .join('\n')}`
          return tool.text(`Office "${value.office}":\n\nColleagues:\n${roster}\n\nChannels:\n${channelList}${extra}`)
        },
      },
      async execute(args) {
        const { office, name: officeName } = tool.entry(args, 'office_roster')
        const value = {
          office: officeName,
          colleagues: (await office.listColleagues()).map(c => compact({
            name: c.name,
            sessionId: c.sessionId,
            role: canonicalRole(c.role),
            description: c.description,
          })),
          channels: office.listChannels().map(c => compact({
            channelId: c.channelId,
            kind: c.kind,
            topic: c.topic,
            members: c.members,
          })),
        }
        if (args?.include_unadopted === true) value.unadopted = await findUnadopted(office)
        return value
      },
    },
    {
      name: 'office_adopt',
      description:
        'Adopt an existing session as a colleague. The session keeps its own workspace, history, and tools. '
        + 'A colleague is addressed by its session title, so supplying name renames that session and any '
        + 'other rename changes how the colleague is addressed. The role decides the office tools the '
        + 'colleague holds and the session permission preset the office row maps that role to.',
      parameters: tool.parameters(['session_id'], {
        session_id: { type: 'string', description: 'The session id to adopt.' },
        name: { type: 'string', description: 'Optional new session title; a colleague is addressed by its session title.' },
        role: roleProperty(),
        description: descriptionProperty(),
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['office', 'colleague'],
          properties: {
            office: { type: 'string' },
            colleague: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'sessionId', 'role'],
              properties: {
                name: { type: 'string' },
                sessionId: { type: 'string' },
                role: { type: 'string', enum: COLLEAGUE_ROLES },
                description: { type: 'string' },
                permission: { type: 'string' },
              },
            },
          },
        },
        render: (_args, value) =>
          text(`[${value.office}] Adopted session ${value.colleague.sessionId} as colleague "${value.colleague.name}"`
            + ` (role ${value.colleague.role}${value.colleague.permission === undefined ? '' : `, permission ${value.colleague.permission}`}).`),
      },
      async execute(args) {
        const { office, name: officeName } = tool.entry(args, 'office_adopt')
        const sessionId = args?.session_id
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new TypeError('office_adopt: session_id must be a non-empty string')
        }
        // A supplied name renames the session; the office keeps no name of its own, so
        // renaming that session anywhere else renames the colleague too.
        if (args?.name !== undefined) await office.rename(sessionId, args.name)
        const { record, permission } = await office.adopt({
          sessionId,
          role: args?.role,
          description: args?.description,
        })
        return {
          office: officeName,
          colleague: compact({
            name: await office.nameOf(sessionId),
            sessionId: record.sessionId,
            role: canonicalRole(record.role),
            description: record.description,
            permission,
          }),
        }
      },
    },
    {
      name: 'office_hire',
      description:
        'Create a new session and adopt it as a colleague in one step, for when the colleague does not exist '
        + 'yet. The session is created through the same host path the Web UI uses, so it appears in the '
        + 'workspace sidebar, and name becomes its session title. Use office_adopt instead for a session that '
        + 'already exists. The role decides the office tools the colleague holds and the session permission '
        + 'preset the office row maps that role to.',
      parameters: tool.parameters(['name'], {
        name: { type: 'string', description: 'Session title for the new colleague.' },
        role: roleProperty(),
        description: descriptionProperty(),
        workspace_id: {
          type: 'string',
          description: 'Workspace to create the session in; defaults to the first registered workspace.',
        },
        agent_preset: {
          type: 'string',
          description: 'Agent preset id for the new session; defaults to the deployment default.',
        },
        provider: {
          type: 'string',
          description: 'Model provider route for the new colleague. Supply together with model.',
        },
        model: {
          type: 'string',
          description: 'Model id for the new colleague. Supply together with provider.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Adapter-owned reasoning effort for the chosen route.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['office', 'colleague', 'workspaceId'],
          properties: {
            office: { type: 'string' },
            colleague: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'sessionId', 'role'],
              properties: {
                name: { type: 'string' },
                sessionId: { type: 'string' },
                role: { type: 'string', enum: COLLEAGUE_ROLES },
                description: { type: 'string' },
                permission: { type: 'string' },
              },
            },
            workspaceId: { type: 'string' },
            agentPreset: { type: 'string' },
            greeting: { type: 'string' },
          },
        },
        render: (_args, value) =>
          text(`[${value.office}] Hired colleague "${value.colleague.name}" on new session ${value.colleague.sessionId}`
            + ` with role ${value.colleague.role}`
            + `${value.colleague.permission === undefined ? '' : ` and permission ${value.colleague.permission}`}.`
            + ` Its greeting was ${value.greeting ?? 'not delivered'}: until it takes a turn, the workspace list`
            + ' hides the session, because a session with no turn yet is the provisional New Session row.'),
      },
      async execute(args) {
        const { office, name: officeName } = tool.entry(args, 'office_hire')
        // `hire` creates the session before it titles it, so a name that cannot be a title must
        // be refused here: otherwise the call fails after leaving a session nobody asked for.
        if (typeof args?.name !== 'string' || args.name.trim().length === 0) {
          throw new TypeError('office_hire: name must be a non-empty session title')
        }
        const hired = await office.hire({
          name: args.name,
          role: args?.role,
          description: args?.description,
          workspaceId: args?.workspace_id,
          cwd: agent.session.header.cwd,
          agentPreset: args?.agent_preset,
          provider: args?.provider,
          model: args?.model,
          reasoningEffort: args?.reasoning_effort,
        })
        return compact({
          office: officeName,
          colleague: compact({
            name: hired.colleague.name,
            sessionId: hired.colleague.sessionId,
            role: canonicalRole(hired.colleague.role),
            description: hired.colleague.description,
            permission: hired.permission,
          }),
          workspaceId: hired.workspaceId,
          agentPreset: hired.agentPreset,
          greeting: hired.greeting,
        })
      },
    },
    {
      name: 'office_dismiss',
      description:
        'Remove a colleague from the roster. The session itself is untouched: it keeps its history and its '
        + 'workspace, and only loses its channel tools and its place in the roster.',
      parameters: tool.parameters(['name'], {
        name: { type: 'string', description: "The colleague's session title." },
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['office', 'colleague'],
          properties: {
            office: { type: 'string' },
            colleague: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'sessionId'],
              properties: {
                name: { type: 'string' },
                sessionId: { type: 'string' },
              },
            },
          },
        },
        render: (_args, value) =>
          text(`[${value.office}] Dismissed colleague "${value.colleague.name}" (session ${value.colleague.sessionId}).`),
      },
      async execute(args) {
        const { office, name: officeName } = tool.entry(args, 'office_dismiss')
        if (typeof args?.name !== 'string' || args.name.trim().length === 0) {
          throw new TypeError('office_dismiss: name must be a non-empty session title')
        }
        const colleague = await office.colleagueByName(args.name)
        if (colleague === undefined) {
          throw new Error(`office_dismiss: "${args.name}" does not match any colleague's session title`)
        }
        const dismissed = await office.dismiss(colleague.sessionId)
        return { office: officeName, colleague: { name: dismissed.name, sessionId: dismissed.sessionId } }
      },
    },
    {
      name: 'office_rename',
      description:
        'Rename one office. Only the stored name changes — the office keeps its colleagues, its channels, '
        + 'and every message, and its storage stays where it is, so the office is addressed by the new name '
        + 'afterwards.',
      parameters: tool.parameters(['name'], {
        name: { type: 'string', description: 'The new office name.' },
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['office', 'renamedTo'],
          properties: {
            office: { type: 'string' },
            renamedTo: { type: 'string' },
          },
        },
        render: (_args, value) => tool.text(`Renamed office "${value.office}" to "${value.renamedTo}".`),
      },
      async execute(args) {
        const { office, name: officeName } = tool.entry(args, 'office_rename')
        return { office: officeName, renamedTo: await office.renameOffice(args?.name) }
      },
    },
  ]
}

/**
 * Build the compaction tool for one agent.
 *
 * Compacting rewrites the office's shared record, so it is the `compact` capability rather
 * than a tool every colleague holds: a boss holds it because it runs the office, and a leader
 * holds it because tending the record is what its role is for.
 * @param agent - the agent whose scope receives the tool.
 * @param tool - the caller's shared declaration helpers.
 * @returns the compaction tool definition.
 */
function createCompactTool(agent, tool) {
  return {
    name: 'office_compact',
    description:
      'Replace a range of one channel\'s messages with a summary you wrote, so a long channel stays readable '
      + 'and bounded. Read the range with office_read first, then pass the sequences you covered. The summary '
      + 'takes the lowest sequence of the range and the covered messages are deleted, so anyone reading the '
      + 'channel afterwards meets the summary exactly where they stood. Compact ranges nobody will need in '
      + 'full; a colleague that has already been woken past the range never sees the summary.',
    parameters: tool.parameters(['from', 'to', 'summary'], {
      channel: { type: 'string', description: 'Channel to compact: "#general" (the default), or a colleague\'s session title for your DM with it.' },
      from: { type: 'integer', description: 'First message sequence number to replace, inclusive.' },
      to: { type: 'integer', description: 'Last message sequence number to replace, inclusive.' },
      summary: { type: 'string', description: 'The text that replaces the range. Say what happened and what was decided, not that a range was compacted.' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['office', 'channelId', 'summaryId', 'covers', 'replaced'],
        properties: {
          office: { type: 'string' },
          channelId: { type: 'string' },
          summaryId: { type: 'string' },
          covers: { type: 'array', items: { type: 'integer' } },
          replaced: { type: 'integer' },
        },
      },
      render: (_args, value) => tool.text(
        `[${value.office}] compacted ${String(value.replaced)} message(s) of #${value.channelId} `
        + `into ${value.summaryId}, covering ${String(value.covers[0])}-${String(value.covers[1])}.`,
      ),
    },
    async execute(args) {
      const resolved = tool.entry(args, 'office_compact')
      const { office, name: officeName } = resolved
      tool.require(resolved, 'compact', 'office_compact')
      const summary = typeof args?.summary === 'string' ? args.summary : ''
      if (summary.trim().length === 0) {
        throw new TypeError('office_compact: summary must be a non-empty string')
      }
      for (const key of ['from', 'to']) {
        if (!Number.isSafeInteger(args?.[key]) || args[key] < 1) {
          throw new TypeError(`office_compact: ${key} must be a safe integer of at least 1`)
        }
      }
      if (args.from > args.to) {
        throw new TypeError(`office_compact: from (${String(args.from)}) must not exceed to (${String(args.to)})`)
      }
      const requested = typeof args?.channel === 'string' ? args.channel.trim() : ''
      const isGeneral = requested === '' || requested === 'general' || requested === '#general'
      const sender = await office.senderOf(agent)
      const channelId = isGeneral
        ? office.generalChannel
        : await resolveDirectChannel(office, sender, requested, 'office_compact')
      const compacted = await office.compactRange({
        channelId,
        from: args.from,
        to: args.to,
        text: summary,
        sender,
      })
      return {
        office: officeName,
        channelId,
        summaryId: compacted.summaryId,
        covers: compacted.covers,
        replaced: compacted.replaced,
      }
    },
  }
}

/**
 * Build the interrupt tool for one agent.
 *
 * A colleague that is mid-turn is never interrupted by a delivery — that is the office's
 * delivery contract — so stopping one is an explicit act, and only the `interrupt` capability
 * holds it. The cancellation keeps the colleague's inbox, and the office then hands it
 * everything held for it as one fresh turn: the work in flight is stopped, and nothing anyone
 * sent is lost with it.
 * @param agent - the agent whose scope receives the tool.
 * @param tool - the caller's shared declaration helpers.
 * @returns the interrupt tool definition.
 */
function createInterruptTool(agent, tool) {
  return {
    name: 'office_interrupt',
    description:
      'Cancel a colleague\'s running turn. The colleague is not left with a lost message: everything the '
      + 'office held for it while that turn ran is handed over as one turn when it stops. Use it when a '
      + 'colleague is working on the wrong thing and a message alone would arrive too late. A colleague that '
      + 'is idle or not loaded has nothing to interrupt, which the result reports rather than treating as a '
      + 'failure.',
    parameters: tool.parameters(['name'], {
      name: { type: 'string', description: "The colleague's session title." },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['office', 'colleague', 'status', 'interrupted'],
        properties: {
          office: { type: 'string' },
          colleague: { type: 'string' },
          status: { type: 'string', enum: ['running', 'idle', 'inactive'] },
          interrupted: { type: 'boolean' },
        },
      },
      render: (_args, value) => tool.text(value.interrupted
        ? `[${value.office}] Interrupted "${value.colleague}"; the office hands it everything held for it as `
          + 'one turn once it stops.'
        : `[${value.office}] "${value.colleague}" was not running (status ${value.status}); nothing to interrupt.`),
    },
    async execute(args) {
      const resolved = tool.entry(args, 'office_interrupt')
      const { office, name: officeName } = resolved
      tool.require(resolved, 'interrupt', 'office_interrupt')
      if (typeof args?.name !== 'string' || args.name.trim().length === 0) {
        throw new TypeError('office_interrupt: name must be a non-empty session title')
      }
      const colleague = await office.colleagueByName(args.name)
      if (colleague === undefined) {
        throw new Error(`office_interrupt: "${args.name}" does not match any colleague's session title`)
      }
      if (colleague.sessionId === agent.session.header.id) {
        throw new Error('office_interrupt: a colleague cannot interrupt itself')
      }
      const live = office.liveAgent(colleague.sessionId)
      if (live === undefined) {
        return { office: officeName, colleague: colleague.name, status: 'inactive', interrupted: false }
      }
      const status = live.status === 'running' ? 'running' : 'idle'
      if (status !== 'running') {
        return { office: officeName, colleague: colleague.name, status, interrupted: false }
      }
      // The inbox is kept: a message the leader sent moments ago is not the turn being stopped.
      live.cancel({ kind: 'user' }, { keepInbox: true })
      return { office: officeName, colleague: colleague.name, status, interrupted: true }
    },
  }
}

/**
 * Build the roster-status tool for one agent.
 *
 * Every role holds it: a colleague cannot otherwise discover its peers at all, and the status
 * it reports is what makes "who is busy" and "who is waiting on what" answerable without
 * waking anybody. It is a query — it reads the registry and the office domain, and never
 * delivers, wakes, or cancels.
 * @param tool - the caller's shared declaration helpers.
 * @returns the roster-status tool definition.
 */
function createColleaguesTool(tool) {
  return {
    name: 'office_colleagues',
    description:
      'List every colleague of one office with its role, its description, and its current status: '
      + '`running` while it works, `idle` when it is loaded and waiting, and `inactive` when its session is '
      + 'not loaded at all. A loaded colleague also reports the permission preset its session runs under and '
      + 'the model route it uses; every colleague reports how many messages the office is holding for it and '
      + 'when the office last carried a message from it or to it. Reading this never wakes anybody.',
    parameters: tool.parameters([], {}),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['office', 'colleagues'],
        properties: {
          office: { type: 'string' },
          colleagues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'sessionId', 'role', 'status', 'pending'],
              properties: {
                name: { type: 'string' },
                sessionId: { type: 'string' },
                role: { type: 'string', enum: COLLEAGUE_ROLES },
                description: { type: 'string' },
                status: { type: 'string', enum: ['running', 'idle', 'inactive'] },
                permission: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                pending: { type: 'integer' },
                lastMessageAt: { type: 'integer' },
                adoptedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.colleagues.length === 0) return tool.text(`[${value.office}] No colleagues yet.`)
        const lines = value.colleagues.map((colleague) => {
          const details = [
            colleague.permission === undefined ? undefined : `permission ${colleague.permission}`,
            colleague.model === undefined ? undefined : `model ${colleague.provider ?? '?'}/${colleague.model}`,
            colleague.pending === 0 ? undefined : `${String(colleague.pending)} message(s) held for it`,
            colleague.lastMessageAt === undefined
              ? 'no message from or to it yet'
              : `last message ${new Date(colleague.lastMessageAt).toISOString()}`,
          ].filter(detail => detail !== undefined)
          return `- ${colleague.name} (${colleague.role}) — ${colleague.status}; ${details.join('; ')}`
            + `${colleague.description === undefined ? '' : `\n  ${colleague.description}`}`
        })
        return tool.text(`[${value.office}] ${String(value.colleagues.length)} colleague(s):\n${lines.join('\n')}`)
      },
    },
    async execute(args) {
      const { office, name: officeName } = tool.entry(args, 'office_colleagues')
      return { office: officeName, colleagues: await office.rosterStatus() }
    },
  }
}

/**
 * Build the configure tool for one agent.
 *
 * It sets the two fields that describe a colleague rather than its membership: the predefined
 * role, which decides its office tools and its session permission preset, and the free-text
 * description. A boss holds it because it runs the roster; a leader holds it because curating
 * how the roster is described is what its role is for, without being able to hire or dismiss.
 * @param tool - the caller's shared declaration helpers.
 * @returns the configure tool definition.
 */
function createConfigureTool(tool) {
  return {
    name: 'office_configure',
    description:
      'Set a colleague\'s predefined role and/or its description. The role decides which office tools the '
      + 'colleague holds and the session permission preset the office row maps it to, so the change is '
      + 'refused when this deployment cannot enforce that preset. Passing description as an empty string '
      + 'removes it. Omitted fields keep their stored value.',
    parameters: tool.parameters(['name'], {
      name: { type: 'string', description: "The colleague's session title." },
      role: roleProperty(),
      description: descriptionProperty(),
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['office', 'colleague'],
        properties: {
          office: { type: 'string' },
          colleague: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'sessionId', 'role'],
            properties: {
              name: { type: 'string' },
              sessionId: { type: 'string' },
              role: { type: 'string', enum: COLLEAGUE_ROLES },
              description: { type: 'string' },
              permission: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => tool.text(
        `[${value.office}] "${value.colleague.name}" is now a ${value.colleague.role}`
        + `${value.colleague.permission === undefined ? '' : ` with permission ${value.colleague.permission}`}`
        + `${value.colleague.description === undefined ? '' : `: ${value.colleague.description}`}.`,
      ),
    },
    async execute(args) {
      const resolved = tool.entry(args, 'office_configure')
      const { office, name: officeName } = resolved
      tool.require(resolved, 'configure', 'office_configure')
      if (typeof args?.name !== 'string' || args.name.trim().length === 0) {
        throw new TypeError('office_configure: name must be a non-empty session title')
      }
      if (args?.role === undefined && args?.description === undefined) {
        throw new TypeError('office_configure: pass role, description, or both')
      }
      const colleague = await office.colleagueByName(args.name)
      if (colleague === undefined) {
        throw new Error(`office_configure: "${args.name}" does not match any colleague's session title`)
      }
      const role = args?.role === undefined ? undefined : requireRole(args.role, 'office_configure')
      const changes = {}
      if (role !== undefined) changes.role = role
      if (args?.description !== undefined) {
        changes.description = normalizeDescription(args.description, 'office_configure')
      }
      const { record, permission } = await office.configure(colleague.sessionId, changes)
      return {
        office: officeName,
        colleague: compact({
          name: colleague.name,
          sessionId: record.sessionId,
          role: canonicalRole(record.role),
          description: record.description,
          permission,
        }),
      }
    },
  }
}

/**
 * Build the channel-read tool for one agent.
 *
 * It is installed for both roles: a colleague reads to take part, and a boss reads to
 * inspect. A cross-office boss reads each office it runs through the same tool, naming the
 * office; a colleague omits the name and reads its own office. The tool answers a range and
 * filter query with no read position of its own — a wake carries only the message that caused
 * it, so this is how the caller reaches anything the office did not notify it about.
 * @param agent - the agent whose scope receives the tool.
 * @param tool - the caller's shared declaration helpers.
 * @param config - the hosting office's configuration, which supplies the static defaults.
 * @returns the read tool definition.
 */
function createReadTool(agent, tool, config) {
  const name = 'office_read'
  const { text } = tool

  /** One optional argument that must be a safe integer of at least `minimum`. */
  const optionalInteger = (value, key, minimum) => {
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new TypeError(`${name}: ${key} must be a safe integer of at least ${String(minimum)}`)
    }
    return value
  }

  /** One optional argument that must be a non-empty string. */
  const optionalText = (value, key) => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${name}: ${key} must be a non-empty string`)
    }
    return value.trim()
  }

  /**
   * Resolve the `sender` filter into a predicate over stored messages.
   *
   * The filter names a sender the way the caller reads one: a colleague's session title, or
   * the user that posts from the panel. A colleague is matched by session id, because
   * renaming a session must not split its own history; the user has no session, so its
   * messages are the ones stored without a sender session.
   * @param office - the acting office.
   * @param raw - the caller's `sender` argument.
   * @param userName - the office's configured user name.
   * @returns the predicate, or undefined when the caller set no sender.
   */
  const senderFilter = async (office, raw, userName) => {
    if (raw === undefined) return undefined
    const wanted = optionalText(raw, 'sender')
    const colleague = await office.colleagueByName(wanted)
    if (colleague !== undefined) return message => message.senderSessionId === colleague.sessionId
    if (nameKey(wanted) === nameKey(userName)) return message => message.senderSessionId === undefined
    throw new Error(
      `${name}: "${wanted}" is neither a colleague's session title nor the user "${userName}"`,
    )
  }

  /**
   * Resolve the `mentions` filter into a predicate over stored messages.
   * @param office - the acting office.
   * @param raw - the caller's `mentions` argument: `me`, a colleague's session title, or the user's name.
   * @param sender - the reading session's own identity, which `me` resolves to.
   * @returns the predicate, or undefined when the caller set no mention filter.
   */
  const mentionsFilter = async (office, raw, sender) => {
    if (raw === undefined) return undefined
    const wanted = optionalText(raw, 'mentions')
    if (wanted === 'me') return message => mentionsIn(message.text, [sender.name]).length > 0
    // The user's name is a valid mention target, so it is a valid filter target: a message that
    // named the user is exactly what someone looking for the user's mail wants to find.
    if (office.isUser(wanted)) return message => mentionsIn(message.text, [wanted]).length > 0
    const colleague = await office.colleagueByName(wanted)
    if (colleague === undefined) {
      throw new Error(`${name}: mentions takes "me", a colleague's session title, or the user's name, got "${wanted}"`)
    }
    return message => mentionsIn(message.text, [colleague.name]).length > 0
  }

  return {
    name,
    description:
      'Read office channel history, oldest first. Use "#general" for the public channel, a colleague\'s session '
      + 'title for the direct-message channel with that colleague, or "*" for every channel you can read. Narrow '
      + 'it with from/to over message sequence numbers, with sender, with contains over the body, with mentions, '
      + 'or with since/until over time. A wake carries only what was addressed to you, so this is how '
      + 'you see anything the office did not notify you about.',
    parameters: tool.parameters(['channel'], {
      channel: {
        type: 'string',
        description: 'Channel to read: "#general", a colleague\'s session title for a DM, or "*" for every channel you can read.',
      },
      from: { type: 'integer', description: 'First message sequence number to include, inclusive.' },
      to: { type: 'integer', description: 'Last message sequence number to include, inclusive.' },
      limit: {
        type: 'integer',
        description: `At most this many messages, newest kept (default ${String(config.readLimit)}, maximum ${String(config.readLimitMax)}).`,
      },
      sender: { type: 'string', description: "Only messages from this colleague's session title, or from the user." },
      contains: { type: 'string', description: 'Only messages whose body contains this text, ignoring case.' },
      mentions: { type: 'string', description: 'Only messages that mention "me" or the named colleague\'s session title.' },
      since: { type: 'integer', description: 'Only messages created at or after this Unix time in milliseconds.' },
      until: { type: 'integer', description: 'Only messages created at or before this Unix time in milliseconds.' },
      brief: { type: 'boolean', description: 'Return ids, channels, sequence numbers, senders, and times without the bodies.' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['office', 'channelId', 'messages', 'total', 'truncated'],
        properties: {
          office: { type: 'string' },
          channelId: { type: 'string' },
          // How many messages matched before `limit` kept the newest, so a caller can tell a
          // complete history from a window of it.
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['messageId', 'channelId', 'seq', 'kind', 'senderName', 'createdAt'],
              properties: {
                messageId: { type: 'string' },
                channelId: { type: 'string' },
                seq: { type: 'integer' },
                kind: { type: 'string' },
                senderName: { type: 'string' },
                createdAt: { type: 'integer' },
                text: { type: 'string' },
                covers: { type: 'array', items: { type: 'integer' } },
              },
            },
          },
        },
      },
      render: (args, value) => {
        if (value.messages.length === 0) {
          const narrowed = ['from', 'to', 'sender', 'contains', 'mentions', 'since', 'until']
            .some(key => args?.[key] !== undefined)
          return text(`[${value.office}] #${value.channelId} has ${narrowed ? 'no matching messages' : 'no messages yet'}.`)
        }
        const lines = value.messages.map((message) => {
          const head = `[${message.messageId}] ${message.senderName}`
          const labelled = message.kind === 'summary'
            ? `${head} (summary of ${String(message.covers[0])}-${String(message.covers[1])})`
            : head
          return message.text === undefined ? labelled : `${labelled}: ${message.text}`
        })
        const shown = `[${value.office}] #${value.channelId}\n${lines.join('\n')}`
        if (!value.truncated) return text(shown)
        // A window that does not say it is a window reads as the whole history, which is worse
        // than an error: a caller concluding "the office never discussed this" is wrong and has
        // no signal that it is wrong.
        return text(
          `${shown}\n\nThat is the newest ${String(value.messages.length)} of ${String(value.total)} matching `
          + 'messages; older ones are not in this result. Read them with a sequence range via from/to, or a larger limit.',
        )
      },
    },
    async execute(args) {
      const { office, name: officeName, config: officeConfig } = tool.entry(args, name)
      const limit = args?.limit === undefined ? config.readLimit : args.limit
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > config.readLimitMax) {
        throw new TypeError(`${name}: limit must be a positive integer no greater than ${String(config.readLimitMax)}`)
      }
      const from = optionalInteger(args?.from, 'from', 1)
      const to = optionalInteger(args?.to, 'to', 1)
      if (from !== undefined && to !== undefined && from > to) {
        throw new TypeError(`${name}: from (${String(from)}) must not exceed to (${String(to)})`)
      }
      const since = optionalInteger(args?.since, 'since', 0)
      const until = optionalInteger(args?.until, 'until', 0)
      const containing = optionalText(args?.contains, 'contains')?.toLowerCase()
      const requested = optionalText(args?.channel, 'channel')
      if (requested === undefined) {
        // The schema marks `channel` required, but a schema is not enforcement: a call that
        // omits it must be described as the omission it is, not as an unknown channel named
        // "undefined".
        throw new TypeError(
          `${name}: channel is required — pass "#general", a colleague's session title for a direct `
          + 'channel, or "*" for every channel you can read',
        )
      }
      const everyChannel = requested === '*' || requested === 'all'
      const isGeneral = requested === 'general' || requested === '#general'
      const sender = await office.senderOf(agent)
      const channelIds = everyChannel
        ? office.visibleChannels(sender.sessionId).map(channel => channel.channelId)
        : [isGeneral ? office.generalChannel : await resolveDirectChannel(office, sender, requested, name)]
      const fromSender = await senderFilter(office, args?.sender, officeConfig.userName)
      const mentioning = await mentionsFilter(office, args?.mentions, sender)
      const matched = []
      for (const channelId of channelIds) {
        for (const message of office.readMessages(channelId, Infinity)) {
          if (from !== undefined && message.seq < from) continue
          if (to !== undefined && message.seq > to) continue
          if (since !== undefined && message.createdAt < since) continue
          if (until !== undefined && message.createdAt > until) continue
          if (fromSender !== undefined && !fromSender(message)) continue
          if (containing !== undefined && !message.text.toLowerCase().includes(containing)) continue
          if (mentioning !== undefined && !mentioning(message)) continue
          matched.push(message)
        }
      }
      matched.sort((left, right) => left.createdAt - right.createdAt
        || left.channelId.localeCompare(right.channelId)
        || left.seq - right.seq)
      const selected = matched.slice(-limit)
      return {
        office: officeName,
        channelId: everyChannel ? '*' : channelIds[0],
        total: matched.length,
        truncated: selected.length < matched.length,
        messages: selected.map(message => compact({
          messageId: message.messageId,
          channelId: message.channelId,
          seq: message.seq,
          kind: message.kind,
          senderName: message.senderName,
          createdAt: message.createdAt,
          text: args?.brief === true ? undefined : message.text,
          covers: message.kind === 'summary' ? message.covers : undefined,
        })),
      }
    },
  }
}

/**
 * Build the channel-writing tools one agent's capabilities include.
 *
 * Writing into the office is a capability, not a property of being a colleague: a member and a
 * leader hold it, a consultant does not, so a consultant's scope carries no way to speak. The
 * gate is repeated per call because the tool set is the union of every membership's
 * capabilities; see {@link officeToolContext}.
 * @param agent - the agent whose scope receives these tools.
 * @param tool - the caller's shared declaration helpers.
 * @returns the communication tool definitions the caller's capabilities admit.
 */
function createCommunicationTools(agent, tool) {
  const { text } = tool
  const definitions = []
  if (tool.capabilities.includes('post')) {
    definitions.push({
      name: 'office_post',
      description:
        'Post to the public office channel "#general". #general is the office\'s shared record, not a '
        + 'chat room: a public post wakes every colleague by default, and each of them spends a turn '
        + 'reading it. Post when the office needs something it does not have, and never to acknowledge a '
        + 'message, to agree with it, or to announce that you are working. Name the colleagues who need to '
        + 'read it in mentions to wake only them, or pass mention_all:false to write to the record without '
        + 'waking anyone — everyone can still read it with office_read. An answer stays in its own session '
        + 'unless it posts back. Use office_dm to answer one colleague.',
      parameters: tool.parameters(['text'], {
        text: { type: 'string', description: 'The message body.' },
        mentions: {
          type: 'array',
          description: 'Session titles to wake instead of the whole office; name the colleagues who need to read this. Waking is explicit and never inferred from the text.',
          items: { type: 'string' },
        },
        mention_all: {
          type: 'boolean',
          description: 'Wake the whole office. Defaults to true unless mentions names who to wake; false writes to the channel without waking anyone, who can still read it with office_read.',
        },
      }),
      output: {
        schema: officePostSchema(),
        render: (_args, value) => text(renderPostResult(value)),
      },
      async execute(args) {
        const resolved = tool.entry(args, 'office_post')
        const { office, name: officeName } = resolved
        tool.require(resolved, 'post', 'office_post')
        const body = requireText(args, 'office_post')
        const sender = await office.senderOf(agent)
        const audience = await office.resolveRecipients(args?.mentions, 'office_post')
        if (args?.mention_all !== undefined && typeof args.mention_all !== 'boolean') {
          throw new TypeError('office_post: mention_all must be a boolean')
        }
        // A public post notifies the whole office unless the caller said otherwise: naming
        // colleagues narrows it to them, and an explicit `mentions: []` or `mention_all: false`
        // posts a notice that nobody is woken for.
        const mentionAll = args?.mention_all ?? args?.mentions === undefined
        return toPostResult(await office.post({
          channel: office.generalChannel,
          sender,
          text: body,
          recipients: audience.colleagues,
          kind: 'public',
          mentionAll,
          toUser: audience.toUser,
        }), officeName)
      },
    })
  }
  if (tool.capabilities.includes('dm')) {
    definitions.push({
      name: 'office_dm',
      description:
        'Send a private message to one colleague, which is how to answer one person without waking the '
        + "rest of the office. The message is stored in the office and delivered into that colleague's "
        + 'session as a user turn, waking it if it is inactive. Every delivery outcome is reported: '
        + 'a wake that could not happen is reported rather than silently dropped. Addressing the user '
        + 'writes to the user mailbox instead: the user has no session, so nothing is woken and the '
        + 'message waits there.',
      parameters: tool.parameters(['to', 'text'], {
        to: { type: 'string', description: "The colleague's session title, or the user's name for the user mailbox." },
        text: { type: 'string', description: 'The message body.' },
      }),
      output: {
        schema: officePostSchema(),
        render: (_args, value) => text(renderPostResult(value)),
      },
      async execute(args) {
        const resolved = tool.entry(args, 'office_dm')
        const { office, name: officeName } = resolved
        tool.require(resolved, 'dm', 'office_dm')
        const body = requireText(args, 'office_dm')
        if (typeof args?.to !== 'string' || args.to.length === 0) {
          throw new TypeError('office_dm: to must be a non-empty colleague name or the user name')
        }
        const sender = await office.senderOf(agent)
        const audience = await office.resolveRecipients([args.to], 'office_dm')
        return toPostResult(await office.post({
          sender,
          text: body,
          recipients: audience.colleagues,
          kind: 'dm',
          toUser: audience.toUser,
        }), officeName)
      },
    })
  }
  return definitions
}

/**
 * Build every office tool one agent's scope receives.
 *
 * The set is built per agent because the caller is closed over, which keeps routing
 * independent of the optional `ToolRunContext.agent`. The tool names are
 * office-independent: the office is an argument, not part of the name, so one boss preset
 * that runs several offices still holds one constant set. Which tools are built is decided by
 * the capabilities the agent holds, so a colleague's role decides its tool set, and a role
 * change is a change to that set rather than to a check the model never sees.
 * @param agent - the agent whose scope is receiving tools.
 * @param host - the hosting office's configuration and service readers.
 * @returns the tool definitions, or undefined when the agent has no office role.
 */
function createOfficeTools(agent, host) {
  const acting = actingOffices(agent)
  if (acting.offices.length === 0) return undefined
  const tool = officeToolContext(agent, acting)
  const definitions = []
  if (acting.capabilities.includes('manage')) definitions.push(...createManagementTools(agent, host, tool))
  if (acting.capabilities.includes('interrupt')) definitions.push(createInterruptTool(agent, tool))
  if (acting.capabilities.includes('configure')) definitions.push(createConfigureTool(tool))
  if (acting.capabilities.includes('compact')) definitions.push(createCompactTool(agent, tool))
  definitions.push(...createCommunicationTools(agent, tool))
  definitions.push(createReadTool(agent, tool, host.config))
  definitions.push(createColleaguesTool(tool))
  return definitions
}

/**
 * The signature of the office tool set one agent holds.
 *
 * A tool set is a function of the acting role and the capabilities the agent's roles hold, so
 * this is what {@link syncOfficeTools} compares to notice that a roster change moved an
 * agent to a different set. `undefined` means the agent holds no office role at all.
 * @param agent - the agent whose set is described.
 * @returns the signature, or undefined when the agent holds no office tool.
 */
function officeToolSignature(agent) {
  const acting = actingOffices(agent)
  if (acting.offices.length === 0) return undefined
  return `${acting.role}:${[...acting.capabilities].sort().join(',')}`
}

/**
 * Arm one agent with the office tool set its roles admit.
 *
 * The set is registered into the agent's own scope, never globally, because an office tool
 * is a role a session holds. The host is the only installer, so there is no collision to
 * avoid and no share to count: it installs once per agent, reinstalls when a role change
 * moves the agent to a different set, and withdraws when the agent holds no office role at
 * all. The signature is what makes a role change take effect: a leader demoted to member must
 * lose `office_interrupt` and `office_compact` from its scope, not merely be refused by them.
 * @param agent - the agent to arm.
 */
function installOfficeTools(agent) {
  if (officeHost === undefined) return
  const signature = officeToolSignature(agent)
  const installed = officeToolInstalls.get(agent)
  if (installed?.signature === signature) return
  installed?.dispose()
  officeToolInstalls.delete(agent)
  if (signature === undefined) return
  const definitions = createOfficeTools(agent, officeHost) ?? []
  const disposers = definitions.map(definition => agent.ctx.tools.register(definition))
  officeToolInstalls.set(agent, { signature, dispose: () => { for (const dispose of disposers) dispose() } })
}

/**
 * Disarm one agent, when it no longer acts on any office.
 * @param agent - the agent to disarm.
 */
function withdrawOfficeTools(agent) {
  officeToolInstalls.get(agent)?.dispose()
  officeToolInstalls.delete(agent)
}

/**
 * Bring every listed agent's office tool set in line with the current registry.
 *
 * An office mounting or unmounting, a roster gaining or losing a session, and a colleague's
 * role change all change which tools an agent holds — so each of those only asks for a resync
 * instead of installing or withdrawing anything itself. An agent gains a set when it first
 * holds a role, moves to another when its capabilities change, and loses it when it holds none.
 * @param agents - the agents to bring in line.
 */
function syncOfficeTools(agents) {
  if (officeHost === undefined) return
  for (const agent of agents) {
    if (officeToolSignature(agent) === undefined) withdrawOfficeTools(agent)
    else installOfficeTools(agent)
  }
}

/**
 * The host's configuration, or the defaults when no host row is mounted.
 *
 * A route owned by an office can run before the host does, and the panel's own preview
 * length is a host value, so it is read per request rather than captured at activation.
 * @returns the host configuration.
 */
function hostConfig() {
  return officeHost?.config ?? DEFAULT_HOST_CONFIG
}

/** Write one JSON response. */
function respondJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * The connection policy's verdict for one request: a refusal status, or undefined to proceed.
 *
 * The web server enforces no authentication of its own and a profile may bind it to every
 * interface, so every route reuses the connection service's host/origin fence and browser
 * authentication. The service is read per request because it may activate after this plugin.
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @returns the status to answer with, or undefined to serve the request.
 */
function refusalOf(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined) return 503
  return connection.requestRejection({ headers: req.headers }) ?? undefined
}

/**
 * Read one JSON request body, refusing a body above `maxBytes`.
 * @param req - the incoming request.
 * @param maxBytes - the largest body this route accepts.
 * @returns the parsed body, or `{}` for an empty one.
 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(new Error(`request body is not JSON: ${String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Largest body a host management route accepts; it carries names, never messages. */
const MAX_MANAGEMENT_BODY_BYTES = 64 * 1024

/** Read an office from a request body field, as an empty string when the request omits it. */
function requestedOffice(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Build the row id, and so the storage key, one created office is identified by.
 *
 * A row id defaults to the office's storage key, so it must survive a name in any script: a
 * Latin name keeps a readable slug, and anything else falls back to a digest of the name, so
 * the same name always yields the same row and the same storage. The separator is an
 * underscore rather than a hyphen because a storage unit name takes only `[a-z0-9_]`.
 * @param name - a canonical office name.
 * @returns the row id.
 */
function officeRowId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const token = slug.length > 0 ? slug.slice(0, 32) : createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12)
  return `office_${token}`
}

/**
 * Project one stored message onto the shape the panel renders.
 *
 * One projection for the snapshot and the history page, so a message cannot read one way while
 * it is the newest page and another way after the reader unfolds the older ones.
 * @param message - the stored message record.
 * @param names - the colleague names, so the panel colors exactly the mentions that resolved.
 * @returns the panel's message view.
 */
function panelMessage(message, names) {
  return compact({
    messageId: message.messageId,
    // The sequence number is what the panel's folded row asks below when it unfolds older
    // messages, so a view without it can render the feed but can never open its history.
    seq: message.seq,
    kind: message.kind,
    senderName: message.senderName,
    createdAt: message.createdAt,
    text: message.text,
    covers: Array.isArray(message.covers) ? message.covers : undefined,
    recipients: message.recipients,
    // Where a mailbox copy came from, so the panel can say it was also said in a channel.
    origin: message.origin,
    mentions: mentionsIn(message.text, names),
  })
}

/**
 * Snapshot one office for the panel.
 *
 * The host registers the route but the office owns the data, so the whole snapshot is derived
 * from the mounted entry: its stored name, its roster, its channels, and its messages.
 *
 * Each message list travels with its total, because the panel renders the newest `readLimit`
 * and folds the rest behind one row: without the total it could not say how many are folded.
 * @param ctx - the plugin context carrying the optional listing services.
 * @param mounted - the mounted office entry.
 * @returns the panel snapshot.
 */
async function officeState(ctx, mounted) {
  const { office } = mounted
  const colleagues = await office.rosterStatus()
  // The user name is a mention target like a colleague name, so the panel colors it in the same
  // pass: a body that named the user is exactly what the mailbox exists to collect.
  const names = [...colleagues.map(entry => entry.name), mounted.config.userName]
  const limit = hostConfig().readLimit
  const general = office.readMessages(office.generalChannel, Infinity)
  const mailbox = office.readMessages(office.mailboxChannel, Infinity)
  return {
    office: mounted.name,
    officeId: mounted.id,
    colleagues,
    // What the hire and edit dialogs offer. A role's mapped preset travels with it, so the panel
    // shows what choosing a role does to that colleague's session rather than only its name.
    roles: COLLEAGUE_ROLES.map(role => compact({
      id: role,
      permission: mounted.config.rolePermissions[role],
    })),
    // The name `@` addresses to reach the user's mailbox, and the mailbox itself. A colleague
    // cannot read it through any tool, so this route is the only way it reaches a surface.
    user: { name: mounted.config.userName },
    channels: office.listChannels().map(c => compact({
      channelId: c.channelId,
      kind: c.kind,
      topic: c.topic,
    })),
    messages: general.slice(-limit).map(m => panelMessage(m, names)),
    messagesTotal: general.length,
    mailbox: mailbox.slice(-limit).map(m => panelMessage(m, names)),
    mailboxTotal: mailbox.length,
    workspaces: (ctx.get('workspaceRegistry')?.list() ?? []).map(workspace => ({
      id: workspace.id,
      title: workspace.title ?? workspace.path,
    })),
    presets: ((await ctx.get('agentPresets')?.list()) ?? [])
      .filter(preset => preset.broken === undefined)
      .map(preset => ({ id: preset.id, name: preset.name ?? preset.id })),
    models: ((await ctx.get('sessionController')?.modelCatalog())?.groups ?? [])
      .flatMap(group => group.models.map(entry => ({
        provider: group.id,
        model: entry.id,
        name: `${group.name} / ${entry.name}`,
      }))),
  }
}

/**
 * One page of older messages for one panel feed, newest page first.
 *
 * The panel holds the newest `readLimit` messages from the snapshot and asks for what is older
 * than the oldest it holds, which is what makes the folded row expandable without the snapshot
 * carrying an office's whole history on every poll.
 * @param mounted - the mounted office entry.
 * @param channelId - the channel to read.
 * @param before - return messages older than this sequence; absent reads the newest page.
 * @param limit - the page size, already bounded by the host's ceiling.
 * @param names - the colleague names the message view resolves mentions against.
 * @returns the page, oldest first, and whether older messages remain.
 */
function officeHistory(mounted, channelId, before, limit, names) {
  const all = mounted.office.readMessages(channelId, Infinity)
  const older = before === undefined ? all : all.filter(message => message.seq < before)
  const page = older.slice(-limit)
  return {
    office: mounted.name,
    channelId,
    messages: page.map(message => panelMessage(message, names)),
    total: all.length,
    truncated: page.length < older.length,
  }
}

/**
 * Register the routes that manage the office registry itself.
 *
 * These belong to the host, not to any office, so they answer while the registry is empty —
 * which is what lets the panel list nothing and still create the first office. Every office
 * route takes the office as its `office` parameter, so one registration serves every office
 * instead of each office claiming a path of its own. They are the only routes that edit the
 * profile patch.
 * @param ctx - the plugin context carrying the web-server and connection services.
 * @param config - the host's resolved configuration.
 */
function registerHostRoutes(ctx, config) {
  ctx.inject(['webServer'], (web) => {
    const refusal = (req) => refusalOf(ctx, req)
    const readJson = (req, maxBytes = MAX_MANAGEMENT_BODY_BYTES) => readJsonBody(req, maxBytes)

    /**
     * The office one request names in its `office` query parameter, or the status and body
     * to answer with instead.
     *
     * The office travels as a parameter rather than as a path segment because an office name
     * accepts any script: a path segment would have to be percent-encoded in both the route
     * table and every request, and a name spelled with a different Unicode normalization
     * would then miss its own route.
     */
    const officeOr404 = (req, res) => {
      const wanted = new URL(req.url ?? '/', 'http://x').searchParams.get('office') ?? ''
      const mounted = findMountedOffice(wanted)
      if (mounted === undefined) {
        respondJson(res, 404, { error: `no office "${wanted}" is mounted` })
        return undefined
      }
      return mounted
    }

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: OFFICES_ROUTE,
      handler: (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'GET') return respondJson(res, 405, { error: 'use GET' })
        respondJson(res, 200, {
          offices: [...mountedOffices.values()].map(entry => ({ id: entry.id, name: entry.name })),
        })
      },
    }))

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: `${OFFICES_ROUTE}/state`,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'GET') return respondJson(res, 405, { error: 'use GET' })
        const mounted = officeOr404(req, res)
        if (mounted === undefined) return undefined
        try {
          return respondJson(res, 200, await officeState(ctx, mounted))
        } catch (error) {
          return respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    // One page of older messages for a panel feed. The panel renders the newest `readLimit`
    // messages and folds the rest behind a count, so this is what the folded row asks for when
    // the reader opens it — the snapshot never has to carry an office's whole history.
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: `${OFFICES_ROUTE}/history`,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'GET') return respondJson(res, 405, { error: 'use GET' })
        const mounted = officeOr404(req, res)
        if (mounted === undefined) return undefined
        try {
          const query = new URL(req.url ?? '/', 'http://x').searchParams
          const wanted = query.get('channel') ?? mounted.office.generalChannel
          const channelId = wanted === 'mailbox' ? mounted.office.mailboxChannel : mounted.office.generalChannel
          const beforeRaw = query.get('before')
          const before = beforeRaw === null ? undefined : Number(beforeRaw)
          if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
            return respondJson(res, 400, { error: 'before must be a positive integer sequence number' })
          }
          const requested = query.get('limit')
          const limit = requested === null ? hostConfig().readLimitMax : Number(requested)
          if (!Number.isSafeInteger(limit) || limit <= 0 || limit > hostConfig().readLimitMax) {
            return respondJson(res, 400, { error: `limit must be a positive integer no greater than ${String(hostConfig().readLimitMax)}` })
          }
          const names = [
            ...(await mounted.office.listColleagues()).map(entry => entry.name),
            mounted.config.userName,
          ]
          return respondJson(res, 200, officeHistory(mounted, channelId, before, limit, names))
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: `${OFFICES_ROUTE}/post`,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
        const mounted = officeOr404(req, res)
        if (mounted === undefined) return undefined
        try {
          const body = await readJson(req, mounted.config.maxMessageChars * 4)
          if (typeof body.text !== 'string' || body.text.length === 0) {
            return respondJson(res, 400, { error: 'text must be a non-empty string' })
          }
          // The panel sends the body alone: who is woken follows from the names written in it,
          // so nothing a client claims can wake a colleague the message does not address. The
          // user's name is scanned the same way, which is what collects `@user` into the mailbox.
          const roster = await mounted.office.listColleagues()
          const audience = await mounted.office.resolveRecipients(
            mentionsIn(body.text, [...roster.map(entry => entry.name), mounted.config.userName]),
            'office',
          )
          const posted = await mounted.office.post({
            channel: mounted.office.generalChannel,
            sender: { sessionId: undefined, name: mounted.config.userName },
            text: body.text,
            recipients: audience.colleagues,
            kind: 'public',
            // The panel notifies the whole office by default, exactly as `office_post` does;
            // unchecking the box narrows the wake to the colleagues the body names.
            mentionAll: body.mention_all !== false,
            toUser: audience.toUser,
          })
          return respondJson(res, 200, toPostResult(posted, mounted.name))
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: `${OFFICES_ROUTE}/hire`,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
        const mounted = officeOr404(req, res)
        if (mounted === undefined) return undefined
        try {
          const body = await readJson(req)
          const hired = await mounted.office.hire({
            name: body.name,
            role: body.role,
            description: body.description,
            workspaceId: body.workspace_id,
            agentPreset: body.agent_preset,
            provider: body.provider,
            model: body.model,
            reasoningEffort: body.reasoning_effort,
          })
          return respondJson(res, 200, compact({
            colleague: compact({
              name: hired.colleague.name,
              sessionId: hired.colleague.sessionId,
              role: canonicalRole(hired.colleague.role),
              description: hired.colleague.description,
              permission: hired.permission,
            }),
            workspaceId: hired.workspaceId,
            agentPreset: hired.agentPreset,
            greeting: hired.greeting,
          }))
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    // The panel's edit path for an existing colleague. It is the route twin of `office_configure`
    // and shares every rule with it: role and description are validated by the same functions,
    // and a role this deployment cannot enforce is refused rather than stored.
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: `${OFFICES_ROUTE}/configure`,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
        const mounted = officeOr404(req, res)
        if (mounted === undefined) return undefined
        try {
          const body = await readJson(req)
          if (body.role === undefined && body.description === undefined) {
            return respondJson(res, 400, { error: 'pass role, description, or both' })
          }
          const colleague = await mounted.office.colleagueByName(body.name)
          if (colleague === undefined) {
            return respondJson(res, 404, { error: `"${String(body.name)}" does not match any colleague's session title` })
          }
          const changes = {}
          if (body.role !== undefined) changes.role = requireRole(body.role, 'office')
          if (body.description !== undefined) {
            changes.description = normalizeDescription(body.description, 'office')
          }
          const configured = await mounted.office.configure(colleague.sessionId, changes)
          return respondJson(res, 200, {
            colleague: compact({
              name: colleague.name,
              sessionId: configured.record.sessionId,
              role: canonicalRole(configured.record.role),
              description: configured.record.description,
              permission: configured.permission,
            }),
          })
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: `${OFFICES_ROUTE}/dismiss`,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
        const mounted = officeOr404(req, res)
        if (mounted === undefined) return undefined
        try {
          const body = await readJson(req)
          const colleague = await mounted.office.colleagueByName(body.name)
          if (colleague === undefined) {
            return respondJson(res, 404, { error: `"${String(body.name)}" does not match any colleague's session title` })
          }
          const dismissed = await mounted.office.dismiss(colleague.sessionId)
          return respondJson(res, 200, {
            colleague: compact({ name: dismissed.name, sessionId: dismissed.sessionId }),
          })
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    /** Locate the office a management request names, or the status and body to answer with instead. */
    const mountedOr404 = (wanted, res) => {
      const mounted = findMountedOffice(wanted)
      if (mounted === undefined) {
        respondJson(res, 404, { error: `no office "${wanted}" is mounted` })
        return undefined
      }
      return mounted
    }

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: RENAME_OFFICE_ROUTE,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
        try {
          const body = await readJson(req)
          const mounted = mountedOr404(requestedOffice(body.office), res)
          if (mounted === undefined) return undefined
          return respondJson(res, 200, {
            office: mounted.name,
            name: await mounted.office.renameOffice(body.name),
          })
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: CREATE_OFFICE_ROUTE,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
        const patchPath = profilePatchPath(ctx, config)
        if (patchPath === undefined) {
          return respondJson(res, 503, { error: 'this deployment exposes no profile patch; add the row by hand' })
        }
        try {
          const body = await readJson(req)
          const officeName = canonicalName(body.name)
          if (typeof body.name !== 'string' || !OFFICE_NAME_RE.test(officeName)) {
            return respondJson(res, 400, {
              error: 'an office name must be letters, digits, or underscores in any script',
            })
          }
          const document = await readPatch(patchPath)
          // Two checks, because a duplicate name would make the office unaddressable: one for an
          // office mounted from another layer, one for a row this patch already declares.
          if (findMountedOffice(officeName) !== undefined) {
            return respondJson(res, 409, { error: `an office named "${officeName}" is already mounted` })
          }
          if (officeRowPath(document, { name: officeName }) !== undefined) {
            return respondJson(res, 409, { error: `the profile declares office "${officeName}"` })
          }
          // The row id is the office's storage key, and the one identifier a patch override
          // cannot replace, so it is generated here and written down as `officeId` too: a name
          // in another script yields an ASCII id, and a later edit to the row id cannot move
          // the office's storage by accident. A name that keeps no ASCII part is digested
          // instead, so it still gets a stable, readable-enough id.
          const officeId = officeRowId(officeName)
          // The new office takes the host's boss preset, so one boss supervises every office
          // created this way. It must be added inside an `insert` list: a top-level row for
          // this id is an id-targeted override of a row that does not exist yet, which the
          // Loader skips with a warning instead of mounting.
          document.add({
            insert: [{
              id: officeId,
              name: 'dsh-office',
              config: { officeName, officeId, bossPreset: config.bossPreset },
            }],
          })
          await writePatch(patchPath, document)
          return respondJson(res, 202, { office: officeName })
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: DELETE_OFFICE_ROUTE,
      handler: async (req, res) => {
        const refused = refusal(req)
        if (refused !== undefined) return respondJson(res, refused, { error: 'not authorized' })
        if (req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
        const patchPath = profilePatchPath(ctx, config)
        if (patchPath === undefined) {
          return respondJson(res, 503, { error: 'this deployment exposes no profile patch; remove the row by hand' })
        }
        try {
          const body = await readJson(req)
          const officeName = canonicalName(body.office)
          if (typeof body.office !== 'string' || officeName.length === 0) {
            return respondJson(res, 400, { error: 'office must name the office to delete' })
          }
          // Locate the row before erasing anything: a request naming an office this profile
          // does not declare must not wipe that office's data on its way to 404. The mounted
          // registry supplies the storage key, because a renamed office is found by its id
          // rather than by the name its row was created with.
          const mounted = findMountedOffice(officeName)
          const document = await readPatch(patchPath)
          const path = officeRowPath(document, { name: officeName, officeId: mounted?.id })
          if (path === undefined) {
            return respondJson(res, 404, { error: `the profile declares no office "${officeName}"` })
          }
          if (mounted === undefined) {
            const identity = rowOfficeIdentity(document, path, officeName)
            if (identity.officeId === undefined) {
              return respondJson(res, 400, { error: `the row for office "${officeName}" declares no usable officeId` })
            }
            const domain = await ctx.storageDomain.open(officeDomain(identity.officeId, identity.name))
            try {
              await purgeDomain(domain, identity)
            } finally {
              await domain.close()
            }
          } else {
            await mounted.office.purge()
          }
          // The two row forms are not equivalent to delete. A row this profile inserted is
          // the only thing mounting its office, so removing it unmounts the office. A
          // top-level row only OVERRIDES a row an earlier layer inserted, so removing it
          // would restore that layer's config and leave the office mounted; disabling it is
          // the only way this layer can unmount it. A top-level row for an office that is
          // not mounted overrides nothing, so it is a dead row from a hand edit and is
          // removed rather than left behind to block a later create of the same name.
          if (path.length !== 3 && mounted !== undefined) {
            document.setIn([path[0], 'disabled'], true)
          } else {
            document.deleteIn(path)
            // Drop an insert list this row was the last member of, so repeated
            // create/delete cycles do not accumulate empty `- insert: []` entries.
            if (path.length === 3 && document.getIn([path[0], 'insert']).items.length === 0) {
              document.deleteIn([path[0]])
            }
          }
          await writePatch(patchPath, document)
          return respondJson(res, 200, compact({
            office: officeName,
            deleted: true,
            // A disabled row survives in the patch, so the user can re-enable it there.
            disabledRow: path.length !== 3 && mounted !== undefined ? true : undefined,
          }))
        } catch (error) {
          return respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
  })
}

/**
 * Mount the office host: the process's single owner of the agent tool set and the panel.
 *
 * The host holds no office and stores nothing. Its lifetime is deliberately independent of
 * every office row, so the tools and the panel survive the registry being emptied — the
 * panel can then list nothing and still create the first office.
 * @param ctx - the plugin context carrying the tool, agent, and web services.
 * @param raw - the host row's configuration object.
 */
function applyHost(ctx, raw) {
  const config = resolveHostConfig(raw, HOST_ROW_ID)
  if (officeHost !== undefined) {
    throw new Error('dsh-office: only one office host row may be mounted in a process')
  }
  officeHost = {
    config,
    resolveQuery: () => ctx.get('sessionQuery'),
  }
  ctx.effect(() => () => { officeHost = undefined })

  // Every office mounting or unmounting, and every roster change, resyncs the affected
  // agents; the host owns the set, so nothing else installs or withdraws it.
  syncOfficeTools(ctx.agents.list())
  ctx.on('agent/created', ({ agent }) => { syncOfficeTools([agent]) })
  ctx.on('agent/disposed', ({ agent }) => { withdrawOfficeTools(agent) })
  ctx.effect(() => () => {
    for (const stored of officeToolInstalls.values()) stored.dispose()
    officeToolInstalls.clear()
  })

  registerHostRoutes(ctx, config)
}

/**
 * Mount one office: its storage domain and its place in the host's registry.
 *
 * The office owns everything about storing and delivering its own messages and nothing
 * about the plugin as a whole, so it never registers a tool and never registers a route: the
 * office is an argument to the host's tool set and to the host's `/dsh-office/*` routes, not
 * a bearer of either.
 * @param ctx - the plugin context carrying the storage, agent, and web services.
 * @param raw - the office row's configuration object.
 * @param rowId - the row's id, the office's storage key unless it configures one.
 */
async function applyOffice(ctx, raw, rowId) {
  const config = resolveOfficeConfig(raw, rowId)
  const domain = await ctx.storageDomain.open(officeDomain(config.officeId, config.officeName))
  ctx.effect(() => () => domain.close())

  // The stored global is authoritative once written, so a renamed office keeps its name
  // across a restart. It also proves the unit was opened for the office that configured it:
  // two rows sharing one storage key would otherwise merge two rosters silently, which no
  // backend detects because the unit is closed and reopened between them.
  const stored = domain.global.get()
  if (stored?.officeId !== undefined && stored.officeId !== config.officeId) {
    throw new Error(
      `dsh-office: storage unit "${config.officeId}" belongs to office "${String(stored.officeId)}", `
      + `not to "${config.officeId}"; give one of them a different config.officeId`,
    )
  }
  const legacyName = typeof stored?.label === 'string' ? stored.label : undefined
  const name = typeof stored?.name === 'string' && stored.name.trim().length > 0
    ? canonicalName(stored.name)
    : canonicalName(legacyName ?? config.officeName)
  if (stored?.name !== name || stored?.officeId !== config.officeId) {
    await domain.global.set({ officeId: config.officeId, name })
  }

  // Both halves of the identity must be unique in this process. A storage backend rejects a
  // second open of one unit, but that would surface as a backend error rather than as the
  // mistake it is, and the name has no backend to notice a collision at all.
  const sameName = [...mountedOffices.values()].find(entry => nameKey(entry.name) === nameKey(name))
  if (sameName !== undefined) {
    throw new Error(
      `dsh-office: an office named "${name}" is already mounted from row "${sameName.id}"; `
      + 'two offices cannot share a name, because the name is how the panel and the tools address one',
    )
  }
  const sameKey = mountedOffices.get(config.officeId)
  if (sameKey !== undefined) {
    throw new Error(
      `dsh-office: config.officeId "${config.officeId}" is already mounted as office "${sameKey.name}"; `
      + 'each office needs a storage key of its own',
    )
  }

  const hooks = { onAdopted: () => {}, onConfigured: () => {}, onDismissed: () => {} }
  const office = createOffice(ctx, domain, config, hooks)
  await office.ensureChannel(GENERAL_CHANNEL, {
    kind: 'public',
    name: GENERAL_CHANNEL,
    topic: 'General office channel for every colleague.',
    members: [],
  })
  // The user's mailbox is created beside the public channel and never listed as a colleague's
  // channel: it is what gives a message addressed to the user somewhere to live.
  await office.ensureChannel(MAILBOX_CHANNEL, {
    kind: 'mailbox',
    name: MAILBOX_CHANNEL,
    topic: `Messages addressed to the user "${config.userName}".`,
    members: [],
  })

  // Join the registry before resyncing: every role lookup reads it, so an agent that this
  // office makes a boss or a colleague is only visible once this entry exists. The name is
  // read through the office rather than copied, because a rename changes stored data and
  // must take effect without remounting the row that carries the storage.
  mountedOffices.set(config.officeId, {
    id: config.officeId,
    get name() { return office.name() },
    bossPreset: config.bossPreset,
    config,
    office,
  })
  ctx.effect(() => () => {
    // Leave the registry first, for the same reason: an agent whose only office role came
    // from this office must stop counting as a holder before the resync withdraws it.
    mountedOffices.delete(config.officeId)
    syncOfficeTools(ctx.agents.list())
  })
  syncOfficeTools(ctx.agents.list())

  // A colleague that finishes a turn is idle, and everything the office held for it while that
  // turn ran is delivered as one turn. `agent/status` is a process-wide agent event, so this
  // listener sees every agent; an office ignores the sessions that are not its colleagues
  // because it holds nothing for them.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    void office.flushWakes(agent.session.header.id).catch((error) => {
      // The held wakes stay where they are, so the next idle transition delivers them; the
      // failure is reported here because nothing else would show it.
      ctx.logger?.warn?.(`dsh-office: delivering held wakes failed: ${String(error)}`)
    })
  })

  // A process that stopped while wakes were held delivers them now, one turn per colleague.
  void office.restoreWakes().catch((error) => {
    ctx.logger?.warn?.(`dsh-office: restoring held wakes failed: ${String(error)}`)
  })

  // One roster event, one resync: entering, leaving, and changing role all move the agent's
  // tool set, so none of them installs or withdraws anything itself.
  const resyncAgent = (sessionId) => {
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined) syncOfficeTools([agent])
  }
  hooks.onAdopted = resyncAgent
  hooks.onConfigured = resyncAgent
  hooks.onDismissed = resyncAgent
}

/**
 * Mount one row of this package.
 *
 * The row id decides which kind it is; see {@link HOST_ROW_ID} for why. The host takes the
 * deployment-wide values (the tool bounds, the boss preset new offices inherit, the profile
 * patch to edit) and an office takes its own name and storage key plus the limits it stores
 * and delivers messages under. Each kind refuses the other's fields rather than ignoring
 * them, so a misplaced field cannot look configured while doing nothing.
 * @param ctx - the plugin context carrying the tool, agent, storage, and web services.
 * @param raw - the row's configuration object.
 */
export async function apply(ctx, raw) {
  const rowId = ctx.fiber?.entry?.options.id
  if (rowId === HOST_ROW_ID) return applyHost(ctx, raw)
  return applyOffice(ctx, raw, rowId)
}
