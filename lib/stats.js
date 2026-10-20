/**
 * Recovery statistics for dsh-context-archive.
 *
 * Denominator: every text tool result recorded in the session logs of one scope
 * (workspace or all workspaces). Numerator: entries in each session's
 * `archives/index.json`. Everything is computed on demand from disk, so the
 * numbers cannot drift away from the data.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { flattenText, projectKey, splitAnnotation, stubIdOf } from './core.js'

/** Inline prefix cost in code points: `[#xxxxxxxx · NNNN chars]` + newline. */
export const PREFIX_CHARS = 13
/** Fallback stub size when an index entry predates `stubChars`. */
export const DEFAULT_STUB_CHARS = 384

export const BUCKETS = [
  { key: '<500', min: 0, max: 500 },
  { key: '500-1k', min: 500, max: 1000 },
  { key: '1k-2k', min: 1000, max: 2000 },
  { key: '2k-5k', min: 2000, max: 5000 },
  { key: '5k-20k', min: 5000, max: 20000 },
  { key: '20k+', min: 20000, max: Number.POSITIVE_INFINITY },
]

/** Minimum archived samples before a bucket is allowed to have a verdict. */
export const MIN_SAMPLE = 3

export function bucketOf(chars) {
  for (const bucket of BUCKETS) if (chars >= bucket.min && chars < bucket.max) return bucket.key
  return BUCKETS[BUCKETS.length - 1].key
}

export function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * Split one concatenated zstd file into frames and decompress each one.
 * Session logs append one frame per flush, so a single-frame decoder is not
 * enough.
 */
export function decompressZstdFrames(buffer) {
  const out = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) break
    let cursor = offset + 4
    const frameHeader = buffer[cursor++]
    const fcsFlag = frameHeader >> 6
    const singleSegment = (frameHeader >> 5) & 1
    const checksum = (frameHeader >> 2) & 1
    const dictFlag = frameHeader & 3
    if (!singleSegment) cursor += 1
    if (dictFlag === 1) cursor += 1
    else if (dictFlag === 2) cursor += 2
    else if (dictFlag === 3) cursor += 4
    if (fcsFlag === 1) cursor += 2
    else if (fcsFlag === 2) cursor += 4
    else if (fcsFlag === 3) cursor += 8
    else if (singleSegment) cursor += 1
    for (;;) {
      if (cursor + 3 > buffer.length) return { text: out.join(''), complete: false }
      const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
      cursor += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 0) cursor += size
      else if (type === 1) cursor += 1
      else if (type === 2) cursor += size
      else return { text: out.join(''), complete: false }
      if (last) break
    }
    if (checksum) cursor += 4
    const frame = buffer.subarray(offset, cursor)
    try {
      out.push(zlib.zstdDecompressSync(frame).toString('utf8'))
    } catch {
      return { text: out.join(''), complete: false }
    }
    offset = cursor
  }
  return { text: out.join(''), complete: offset === buffer.length }
}

/** Parse one session log: body sizes of its tool results plus its last seq. */
function readLogSizes(file) {
  let buffer
  try {
    if (statSync(file).size > 64 * 1024 * 1024) return null
    buffer = readFileSync(file)
  } catch {
    return null
  }
  const { text } = decompressZstdFrames(buffer)
  const entries = []
  let maxSeq = -1
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event?.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
    if (event?.type !== 'tool/result') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    if (stubIdOf(content)) continue
    const split = splitAnnotation(flattenText(content))
    entries.push({ chars: [...split.body].length, annotated: split.id !== null })
  }
  return { entries, maxSeq }
}

function readIndex(sessionDir) {
  const file = join(sessionDir, 'archives', 'index.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const entries = parsed?.entries ?? {}
    return Object.entries(entries).map(([id, entry]) => ({
      id,
      chars: Number(entry?.chars ?? 0),
      stubChars: Number(entry?.stubChars ?? DEFAULT_STUB_CHARS),
    }))
  } catch {
    return []
  }
}

function projectDirs(scopeCwd) {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const all = readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())
  if (!scopeCwd) return all.map((item) => join(root, item.name))
  const wanted = projectKey(scopeCwd)
  return all.filter((item) => item.name === wanted).map((item) => join(root, item.name))
}

/**
 * Aggregate recovery statistics for one scope.
 * @param options.cwd - restrict to this workspace's project directory.
 */
export function computeStats({ cwd } = {}) {
  const buckets = new Map(BUCKETS.map((bucket) => [bucket.key, { seen: 0, annotated: 0, archived: 0, archivedChars: 0, stubChars: 0 }]))
  const sessionSeq = {}
  let sessions = 0
  let logsRead = 0

  for (const project of projectDirs(cwd)) {
    let sessionDirs
    try {
      sessionDirs = readdirSync(project, { withFileTypes: true }).filter((item) => item.isDirectory())
    } catch {
      continue
    }
    for (const entry of sessionDirs) {
      const dir = join(project, entry.name)
      const log = join(dir, 'session.v4.jsonl.zstd')
      if (!existsSync(log)) continue
      sessions += 1
      const parsed = readLogSizes(log)
      if (parsed) {
        logsRead += 1
        for (const item of parsed.entries) {
          const bucket = buckets.get(bucketOf(item.chars))
          bucket.seen += 1
          if (item.annotated) bucket.annotated += 1
        }
        sessionSeq[entry.name] = parsed.maxSeq
      }
      for (const item of readIndex(dir)) {
        const bucket = buckets.get(bucketOf(item.chars))
        if (!bucket) continue
        bucket.archived += 1
        bucket.archivedChars += item.chars
        bucket.stubChars += item.stubChars
      }
    }
  }

  let totalSeen = 0
  let totalAnnotated = 0
  let totalArchived = 0
  const rows = []
  for (const bucket of BUCKETS) {
    const row = buckets.get(bucket.key)
    const rate = row.annotated > 0 ? row.archived / row.annotated : 0
    const avgChars = row.archived > 0 ? Math.round(row.archivedChars / row.archived) : 0
    const avgStub = row.archived > 0 ? Math.round(row.stubChars / row.archived) : DEFAULT_STUB_CHARS
    // Rate at which "archive one, pay one prefix" breaks even for this size.
    const savingPerArchive = Math.max(0, avgChars - avgStub)
    const breakEvenRate = row.archived > 0 && savingPerArchive > 0 ? PREFIX_CHARS / savingPerArchive : null
    const verdict =
      row.archived < MIN_SAMPLE
        ? 'unknown'
        : breakEvenRate !== null && rate >= breakEvenRate
          ? 'profitable'
          : 'losing'
    totalSeen += row.seen
    totalAnnotated += row.annotated
    totalArchived += row.archived
    rows.push({
      bucket: bucket.key,
      min: bucket.min === Number.POSITIVE_INFINITY ? null : bucket.min,
      seen: row.seen,
      annotated: row.annotated,
      archived: row.archived,
      rate: Math.round(rate * 1000) / 1000,
      avgChars,
      avgStub,
      savingPerArchive,
      breakEvenRate: breakEvenRate === null ? null : Math.round(breakEvenRate * 1000) / 1000,
      verdict,
    })
  }

  // The smallest band that is observed to pay for itself.
  const firstProfitable = rows.find((row) => row.verdict === 'profitable' && row.min !== null)
  const recommended = firstProfitable ? firstProfitable.min : null

  return {
    scope: cwd ? 'workspace' : 'all',
    sessions,
    logsRead,
    minSample: MIN_SAMPLE,
    sessionSeq,
    totals: {
      seen: totalSeen,
      annotated: totalAnnotated,
      archived: totalArchived,
      rate: totalAnnotated > 0 ? Math.round((totalArchived / totalAnnotated) * 1000) / 1000 : 0,
      prefixCost: PREFIX_CHARS,
    },
    buckets: rows,
    recommendedMinChars: recommended,
  }
}

/**
 * Actionable numbers for one session: what is on its surface right now and how
 * much of it the turn guard still allows archiving.
 */
const sessionStatsCache = new Map()

export function computeSessionStats({ sessionId, minChars = 800, keepTurns = 3 } = {}) {
  const empty = { sessionId: sessionId ?? null, surface: 0, live: 0, archived: 0, archivable: 0, potentialChars: 0 }
  if (!sessionId) return empty
  let file = null
  for (const project of projectDirs()) {
    const candidate = join(project, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) {
      file = candidate
      break
    }
  }
  if (file === null) return empty
  let buffer
  let signature
  try {
    const stat = statSync(file)
    signature = `${stat.mtimeMs}:${stat.size}:${minChars}:${keepTurns}`
    const cached = sessionStatsCache.get(file)
    if (cached && cached.signature === signature) return cached.value
    buffer = readFileSync(file)
  } catch {
    return empty
  }
  const { text } = decompressZstdFrames(buffer)
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // partial trailing frame
    }
  }
  const shadowed = new Set()
  for (const event of events) {
    if (event?.surfaceOp?.op !== 'replace' || !Array.isArray(event.sourceEventSeqs)) continue
    for (const seq of event.sourceEventSeqs) shadowed.add(seq)
  }
  const live = []
  let archived = 0
  for (const event of events) {
    if (event?.type !== 'tool/result' || shadowed.has(event.seq)) continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    if (stubIdOf(content)) {
      archived += 1
      continue
    }
    const chars = [...splitAnnotation(flattenText(content)).body].length
    live.push({ seq: event.seq, chars, turn: Number.isInteger(event.data?.turn) ? event.data.turn : null })
  }
  const latestTurn = live.reduce((max, item) => (item.turn !== null && item.turn > max ? item.turn : max), 0)
  const archivable = live.filter((item) => {
    if (item.chars < minChars) return false
    if (keepTurns <= 0) return true
    return item.turn !== null && item.turn <= latestTurn - keepTurns
  })
  const value = {
    sessionId,
    surface: live.length + archived,
    live: live.length,
    archived,
    archivable: archivable.length,
    potentialChars: archivable.reduce((sum, item) => sum + Math.max(0, item.chars - DEFAULT_STUB_CHARS), 0),
  }
  sessionStatsCache.set(file, { signature, value })
  if (sessionStatsCache.size > 16) {
    const oldest = sessionStatsCache.keys().next().value
    sessionStatsCache.delete(oldest)
  }
  return value
}
