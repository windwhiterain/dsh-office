/**
 * Optional panel render check for dsh-office.
 *
 * Loads `client.js` the way the shell does, renders the panel against a stubbed office route in
 * jsdom, and drives the interactions the panel added: collapsing and reopening the roster column,
 * opening the mailbox sidebar, unfolding the folded history row, and seeding the colleague dialog.
 * `probe/smoke.mjs` covers the plugin's own logic without any of this; this check exists for the
 * render path and the panel's contract with the state route, which a schema check cannot see.
 *
 * It is opt-in because it needs React, react-dom, and jsdom, which this package does not depend
 * on. Point `DSH_OFFICE_PROBE_MODULES` at a directory holding a `node_modules` with them (a
 * DeepSeek Harness checkout works), and the check runs; without them it reports itself skipped
 * rather than failing, so it is safe to wire into any pipeline.
 *
 * Run: node probe/panel-render.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Roots to resolve the optional peer modules from, most specific first. */
const MODULE_ROOTS = [
  process.env.DSH_OFFICE_PROBE_MODULES,
  join(import.meta.dirname, '..'),
].filter(root => typeof root === 'string' && root.length > 0)

/**
 * Import one installed package by the entry its own manifest names.
 *
 * Covers both a flat `node_modules/<name>` and a pnpm store's `<name>@<version>` layout, so the
 * check works from whichever checkout happens to carry the modules.
 * @param name - the package to resolve.
 * @returns the imported module, or undefined when no root has it.
 */
async function optional(name) {
  for (const root of MODULE_ROOTS) {
    const candidates = [join(root, 'node_modules', name)]
    const store = join(root, 'node_modules', '.pnpm')
    if (existsSync(store)) {
      for (const entry of readdirSync(store)) {
        if (entry === name || entry.startsWith(`${name}@`)) candidates.push(join(store, entry, 'node_modules', name))
      }
    }
    for (const directory of candidates) {
      const manifest = join(directory, 'package.json')
      if (!existsSync(manifest)) continue
      const main = JSON.parse(readFileSync(manifest, 'utf8')).main ?? 'index.js'
      return import(pathToFileURL(join(directory, main)).href)
    }
  }
  return undefined
}

const jsdomModule = await optional('jsdom')
const reactModule = await optional('react')
const reactDomModule = await optional('react-dom')
if (jsdomModule === undefined || reactModule === undefined || reactDomModule === undefined) {
  console.log('panel render check: skipped (jsdom, react, and react-dom are not resolvable)')
  process.exit(0)
}

const { JSDOM } = jsdomModule.default ?? jsdomModule
const React = reactModule.default ?? reactModule
// `react-dom/client` is a subpath, resolved by hand from whichever copy react-dom came from.
const reactDomClient = MODULE_ROOTS
  .flatMap((root) => {
    const store = join(root, 'node_modules', '.pnpm')
    const entries = existsSync(store) ? readdirSync(store).filter(entry => entry.startsWith('react-dom@')) : []
    return [join(root, 'node_modules', 'react-dom', 'client.js'), ...entries.map(entry => join(store, entry, 'node_modules', 'react-dom', 'client.js'))]
  })
  .find(candidate => existsSync(candidate))
assert.ok(reactDomClient, 'react-dom/client must be resolvable once react-dom is')
const { createRoot } = await import(pathToFileURL(reactDomClient).href)

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3081/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = false

const COLLEAGUE = {
  name: 'nia',
  sessionId: 'session-nia',
  role: 'leader',
  description: 'runs the standup',
  status: 'idle',
  permission: 'read-only',
  pending: 2,
}
const SNAPSHOT = {
  office: 'office',
  officeId: 'office',
  colleagues: [COLLEAGUE],
  roles: [{ id: 'member' }, { id: 'leader' }, { id: 'consultant', permission: 'read-only' }],
  user: { name: 'user' },
  channels: [{ channelId: 'general', kind: 'public' }, { channelId: 'mailbox', kind: 'mailbox' }],
  messages: [
    { messageId: 'general-10', seq: 10, channelId: 'general', kind: 'public', senderName: 'nia', createdAt: 1, text: 'newest', mentions: [] },
    { messageId: 'general-11', seq: 11, channelId: 'general', kind: 'public', senderName: 'user', createdAt: 2, text: 'tail', mentions: [] },
  ],
  messagesTotal: 12,
  mailbox: [
    { messageId: 'mailbox-1', seq: 1, channelId: 'mailbox', kind: 'mailbox', senderName: 'nia', createdAt: 3, text: 'please look at @user', mentions: ['user'], origin: { channelId: 'general', messageId: 'general-9' } },
  ],
  mailboxTotal: 3,
  workspaces: [{ id: 'w1', title: 'Workspace' }],
  presets: [{ id: 'standard', name: 'Standard' }],
  models: [{ provider: 'p', model: 'm', name: 'P / M' }],
}
const OLDER = {
  office: 'office',
  channelId: 'general',
  messages: [
    { messageId: 'general-8', seq: 8, channelId: 'general', kind: 'public', senderName: 'nia', createdAt: 0, text: 'eight', mentions: [] },
    { messageId: 'general-9', seq: 9, channelId: 'general', kind: 'public', senderName: 'nia', createdAt: 1, text: 'nine', mentions: [] },
  ],
  total: 12,
  truncated: false,
}

const calls = []
let captured
dom.window.__ModuleLoader__ = { load: (module) => { captured = module } }
globalThis.fetch = async (path) => {
  calls.push(path)
  const body = path === '/dsh-office/offices'
    ? { offices: [{ id: 'office', name: 'office' }] }
    : path.includes('/state') ? SNAPSHOT : OLDER
  return { ok: true, status: 200, json: async () => body }
}

await import('../client.js')
assert.equal(captured?.id, 'dsh-office', 'client.js registers the dsh-office module')

const Modal = ({ open, children }) => (open ? React.createElement('div', { 'data-modal': true }, children) : null)
const passthrough = (name) => (props) => React.createElement('div', { 'data-stub': name }, props.children ?? null)
const primitives = {
  Modal,
  Menu: passthrough('Menu'),
  Button: ({ children, ...rest }) => React.createElement('button', rest, children),
  IconChevronDownOutlineRegular: () => React.createElement('span', null, 'v'),
}
const module = captured.factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${name}`)
})

const registered = {}
const ctx = {
  slots: {
    inject: (_name, callback) => callback(),
    register: (slot, Component) => { registered[slot.name] = Component; return () => {} },
  },
}
module.apply(ctx)
assert.ok(registered.main, 'the panel registers the main slot')

const root = createRoot(document.getElementById('root'))
root.render(React.createElement(registered.main))
const settle = async (ms = 30) => { await new Promise(resolve => setTimeout(resolve, ms)) }
await settle(80)

const text = () => document.body.textContent
const buttons = () => [...document.querySelectorAll('button')]
/** Wait for a condition instead of guessing at a delay; a cold first run is slower than a warm one. */
const until = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const clickOn = (label) => {
  const button = buttons().find(entry => entry.textContent.includes(label))
  assert.ok(button, `a button labelled "${label}" must be rendered; body was: ${text()}`)
  button.click()
  return button
}

// The body is two collapsible side columns around the channel: roster open, mailbox closed.
assert.ok(
  await until(() => document.getElementById('dsh-office-colleagues') !== null),
  `the panel must draw the office it mounted; body was: ${text()}`,
)
assert.match(text(), /nia/, 'the rail lists the colleague')
assert.match(text(), /leader · idle · read-only · 2 held/, 'the rail reports role, status, permission, and held mail')
assert.match(text(), /runs the standup/, 'and the description')
assert.ok(document.getElementById('dsh-office-colleagues'), 'the roster column is open by default')
assert.equal(document.getElementById('dsh-office-mailbox'), null, 'the mailbox sidebar is closed by default')
assert.equal(document.querySelector('[data-channel="mailbox"]'), null, 'so the mailbox draws no feed')
assert.match(text(), /Mailbox · 3/, 'the header toggle reports how much mail waits')
assert.match(text(), /#general/, 'the public channel names its own column')
assert.equal(document.querySelectorAll('[data-channel="general"]').length, 1, 'and owns exactly one scrollport')
assert.match(text(), /10 earlier messages/, 'the feed folds everything older than the newest page')
assert.match(text(), /tail/, 'the newest page is rendered')
assert.ok(!text().includes('please look at @user'), 'the mailbox is collapsed by default')

// The roster column collapses from its header toggle and comes back with its content.
clickOn('Colleagues')
await settle()
assert.equal(document.getElementById('dsh-office-colleagues'), null, 'the header toggle closes the roster')
assert.ok(!text().includes('runs the standup'), 'and takes its content with it')
clickOn('Colleagues')
await settle()
assert.match(text(), /runs the standup/, 'and reopens it')

// Opening the mailbox gives it a column of its own rather than another band of the channel.
clickOn('Mailbox')
await settle()
const mailboxColumn = document.getElementById('dsh-office-mailbox')
const generalFeed = document.querySelector('[data-channel="general"]')
const mailboxFeed = document.querySelector('[data-channel="mailbox"]')
assert.ok(mailboxColumn, 'the header toggle opens the mailbox sidebar')
assert.ok(mailboxFeed, 'which holds its own scrollport')
assert.ok(mailboxColumn.contains(mailboxFeed), 'inside the sidebar element')
assert.ok(
  !generalFeed.contains(mailboxFeed) && !mailboxFeed.contains(generalFeed),
  'and #general shares no scrollport with it',
)
assert.match(text(), /Mailbox · @user/, 'the sidebar names the mailbox and the name that reaches it')
assert.match(text(), /please look at @user/, 'opening the mailbox shows the mail')
assert.match(text(), /also in #general as general-9/, 'a copied message says where it was also said')
assert.match(text(), /2 earlier messages/, 'the mailbox folds its own older messages')
assert.ok(
  mailboxFeed.innerHTML.includes('var(--dsw-alias-state-business-primary)'),
  'a mention in the mail carries the reference color',
)

// The sidebar's own close button collapses it again.
clickOn('✕')
await settle()
assert.equal(document.getElementById('dsh-office-mailbox'), null, 'the close button collapses the mailbox')

// Unfolding the channel asks the history route and prepends the page.
const before = calls.length
clickOn('10 earlier messages')
await settle(80)
assert.ok(
  calls.slice(before).some(path => path.includes('/history') && path.includes('channel=general') && path.includes('before=10')),
  `unfolding must ask the history route below the oldest held sequence; calls: ${calls.slice(before).join(', ')}`,
)
assert.match(text(), /nine/, 'the unfolded page is rendered')
assert.match(text(), /8 earlier messages/, 'and the row now counts what is left')

// The configure dialog posts the role and the description of the colleague it was opened on.
clickOn('Edit')
await settle()
assert.ok(document.querySelector('[data-modal]'), 'the edit dialog opens')
const selects = [...document.querySelectorAll('select')]
assert.equal(selects.length, 1, 'the edit dialog offers exactly the role picker')
assert.equal(selects[0].value, 'leader', 'seeded from the colleague it was opened on')
const description = [...document.querySelectorAll('input')].find(input => input.getAttribute('aria-label') === 'Colleague description')
assert.equal(description.value, 'runs the standup', 'and from that colleague description')

console.log('panel render check: ok')
root.unmount()
