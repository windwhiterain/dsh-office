/**
 * Read-only diagnostic over one stored session: which tool catalog each request carried, and
 * which tools the session actually called.
 *
 * Usage: node probe/session-tool-scan.mjs <session.v4.jsonl.zstd> [name-regex]
 *
 * It answers "what did this session hold, and when did that change" from the record rather than
 * from a model's account of itself, which is the difference between a diagnosis and a story. The
 * catalog list is the load-bearing half: a plane the session never called a tool from is exactly
 * the case a call log cannot show — a colleague silently stripped of its shell reads as a session
 * with no shell calls, and as a *smaller request header*, which this prints.
 *
 * The optional regex filters the call summary only, so a run can ask "did it ever call git_bash"
 * without losing the planes.
 *
 * A stored session is a concatenation of small zstd frames, one per event batch, and Node's
 * zstd stream stops after the first frame (measured: 202 of 725435 bytes decoded, 1 of 699
 * events). The scan therefore walks every frame magic and decodes the frame starting there, which
 * is why it is a scan and not a reader.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every zstd frame of one session file into its events, in `seq` order.
 * @param buffer - the whole stored session.
 * @returns its events, deduplicated and sorted by `seq`.
 */
function decodeFrames(buffer) {
  const events = new Map()
  let offset = buffer.indexOf(ZSTD_MAGIC)
  while (offset !== -1) {
    try {
      for (const line of zstdDecompressSync(buffer.subarray(offset)).toString('utf8').split('\n')) {
        if (!line.startsWith('{')) continue
        try {
          const event = JSON.parse(line)
          events.set(`${event.type}#${event.seq ?? ''}#${line.length}`, event)
        } catch {
          // A frame-shaped byte run that is not a stored event.
        }
      }
    } catch {
      // A magic-shaped byte run inside a payload is not a frame start; skip it.
    }
    offset = buffer.indexOf(ZSTD_MAGIC, offset + ZSTD_MAGIC.length)
  }
  return [...events.values()].sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1))
}

/** Every tool call one event carries, however deep the loop nests it. */
function callsIn(event, seq) {
  const found = []
  const stack = [event]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const item of node) if (item !== null && typeof item === 'object') stack.push(item)
      continue
    }
    if (node === null || typeof node !== 'object') continue
    if (typeof node.name === 'string' && typeof node.callId === 'string') {
      found.push({ seq, name: node.name, time: event.time })
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') stack.push(value)
    }
  }
  return found
}

const [path, filter] = process.argv.slice(2)
if (path === undefined) {
  console.error('usage: node probe/session-tool-scan.mjs <session.v4.jsonl.zstd> [name-regex]')
  process.exit(2)
}

const events = decodeFrames(readFileSync(path))
const wanted = filter === undefined ? undefined : new RegExp(filter)
const calls = []
const planes = []
let previous

for (const event of events) {
  if (event.type === 'request/header') {
    // A header is logged per request that changes it, so consecutive equal catalogs collapse:
    // what remains is one line per plane this session ever ran under.
    const names = (event.data?.header?.tools ?? []).map(tool => tool.name).sort()
    const key = names.join(',')
    if (key !== previous) {
      previous = key
      planes.push({ seq: event.seq, time: event.time, names })
    }
    continue
  }
  calls.push(...callsIn(event, event.seq))
}

console.log(`session: ${path}`)
console.log(`events: ${String(events.length)}   tool calls: ${String(calls.length)}`)
console.log('')
console.log('tool catalogs, one line per change:')
if (planes.length === 0) console.log('  (no request header is stored: an old or seeded session)')
for (const plane of planes) {
  const at = plane.time === undefined ? '?' : new Date(plane.time).toISOString()
  console.log(`  seq ${String(plane.seq).padStart(6)}  ${at}  ${String(plane.names.length).padStart(3)} tools: ${plane.names.join(' ')}`)
}

const summary = new Map()
for (const call of calls) {
  if (wanted !== undefined && !wanted.test(call.name)) continue
  const entry = summary.get(call.name) ?? { count: 0, first: call }
  entry.count += 1
  entry.last = call
  summary.set(call.name, entry)
}
console.log('')
console.log('tool calls, most used first:')
for (const [name, entry] of [...summary.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${name.padEnd(28)} count=${String(entry.count).padEnd(4)} firstSeq=${String(entry.first.seq).padEnd(6)} lastSeq=${entry.last.seq}`)
}
if (wanted !== undefined) {
  console.log('')
  console.log(`calls matching /${filter}/, in order:`)
  for (const call of calls.filter(call => wanted.test(call.name))) console.log(`  seq ${call.seq} ${call.name}`)
}
