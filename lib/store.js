/**
 * Incremental recovery counters.
 *
 * Scanning every session log on each request is O(all results) — fine at 3k,
 * hopeless at 300k. Instead the counters are folded from `session/event` one
 * event at a time and persisted next to the runtime config; a session seen for
 * the first time is folded once from its in-memory prefix, then only appended
 * events are counted.
 *
 * `reconcile()` keeps the old "scan everything" path as an explicit rebuild.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUCKETS, MIN_SAMPLE, PREFIX_CHARS, bucketOf, computeStats } from './stats.js'
import { flattenText, splitAnnotation, stubIdOf } from './core.js'

const STORE_VERSION = 4
const EMPTY_BUCKET = () => ({ seen: 0, annotated: 0, archived: 0, annotatedArchived: 0, archivedChars: 0, stubChars: 0 })
const SAVE_DEBOUNCE_MS = 1500
const MAX_BACKFILL_EVENTS = 200_000

export function statsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'context-archive-stats.json')
}

function emptyState() {
  const buckets = {}
  for (const bucket of BUCKETS) buckets[bucket.key] = EMPTY_BUCKET()
  return { version: STORE_VERSION, buckets, sessions: {}, savedAt: null }
}

function normalize(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  // An older schema may have counted nothing; rebuild from the logs instead of
  // trusting numbers produced by different rules.
  if (raw.version !== STORE_VERSION) return state
  if (raw.buckets && typeof raw.buckets === 'object') {
    for (const bucket of BUCKETS) {
      const row = raw.buckets[bucket.key]
      if (!row || typeof row !== 'object') continue
      const num = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
      state.buckets[bucket.key] = {
        seen: num(row.seen),
        annotated: num(row.annotated),
        archived: num(row.archived),
        annotatedArchived: num(row.annotatedArchived),
        archivedChars: num(row.archivedChars),
        stubChars: num(row.stubChars),
      }
    }
  }
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [id, value] of Object.entries(raw.sessions)) {
      if (typeof id !== 'string' || !id) continue
      const lastSeq = value && Number.isInteger(value.lastSeq) && value.lastSeq >= 0 ? value.lastSeq : -1
      state.sessions[id] = { lastSeq }
    }
  }
  return state
}

/** Count one tool result into the bucket counters. */
function foldResult(state, content) {
  if (!Array.isArray(content)) return
  if (stubIdOf(content)) return // archived replacements are counted from index.json
  const split = splitAnnotation(flattenText(content))
  const chars = [...split.body].length
  const row = state.buckets[bucketOf(chars)]
  if (!row) return
  row.seen += 1
  if (split.id) row.annotated += 1
}

export class StatsStore {
  constructor({ path = statsPath(), logger } = {}) {
    this.path = path
    this.logger = logger
    this.state = this.load()
    this.timer = null
    this.dirty = false
  }

  load() {
    try {
      if (!existsSync(this.path)) return emptyState()
      return normalize(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      return emptyState()
    }
  }

  /** Persist now (atomic replace). */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    try {
      this.state.savedAt = new Date().toISOString()
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state) + '\n', 'utf8')
      renameSync(tmp, this.path)
      this.dirty = false
    } catch (error) {
      this.logger?.warn?.(`context-archive: stats write failed: ${error?.message ?? error}`)
    }
  }

  scheduleSave() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /**
   * Fold one session event. A session seen for the first time is backfilled from
   * its prefix so restarts and pre-existing sessions are not lost.
   */
  apply(session, event) {
    const id = session?.id
    if (typeof id !== 'string' || !id || !event || typeof event.seq !== 'number') return
    const known = this.state.sessions[id]
    if (known === undefined) {
      this.state.sessions[id] = { lastSeq: -1 }
      this.backfill(session, event.seq)
    }
    const entry = this.state.sessions[id]
    if (event.seq <= entry.lastSeq) return
    if (event.type === 'tool/result') foldResult(this.state, event.data?.message?.content)
    entry.lastSeq = event.seq
    this.scheduleSave()
  }

  /** Fold events [0, until) of a session we have never seen. */
  backfill(session, until) {
    if (!(until > 0) || typeof session?.snapshotEvents !== 'function') return
    try {
      const limit = Math.min(until, MAX_BACKFILL_EVENTS)
      const events = session.snapshotEvents(0, limit)
      for (const event of events) {
        if (event.type === 'tool/result') foldResult(this.state, event.data?.message?.content)
      }
    } catch (error) {
      this.logger?.warn?.(`context-archive: stats backfill failed: ${error?.message ?? error}`)
    }
  }

  /** O(1) snapshot for the panel/tool; archives are joined from index.json. */
  snapshot() {
    const buckets = BUCKETS.map((bucket) => {
      const row = this.state.buckets[bucket.key] ?? EMPTY_BUCKET()
      const archivedRow = {
        archived: row.archived,
        annotated: row.annotatedArchived,
        chars: row.archivedChars,
        stubs: row.stubChars,
      }
      // Opportunities = annotated results plus archived ones that never carried an id.
      const opportunities = row.annotated + Math.max(0, row.archived - row.annotatedArchived)
      const rate = opportunities > 0 ? Math.min(1, archivedRow.archived / opportunities) : 0
      const avgChars = archivedRow.archived > 0 ? Math.round(archivedRow.chars / archivedRow.archived) : 0
      const avgStub = archivedRow.archived > 0 ? Math.round(archivedRow.stubs / archivedRow.archived) : 0
      const savingPerArchive = Math.max(0, avgChars - avgStub)
      const breakEvenRate = archivedRow.archived > 0 && savingPerArchive > 0 ? PREFIX_CHARS / savingPerArchive : null
      const verdict =
        archivedRow.archived < MIN_SAMPLE
          ? 'unknown'
          : breakEvenRate !== null && rate >= breakEvenRate
            ? 'profitable'
            : 'losing'
      return {
        bucket: bucket.key,
        min: bucket.min === Number.POSITIVE_INFINITY ? null : bucket.min,
        seen: row.seen,
        annotated: row.annotated,
        archived: archivedRow.archived,
        rate: Math.round(rate * 1000) / 1000,
        avgChars,
        avgStub,
        savingPerArchive,
        breakEvenRate: breakEvenRate === null ? null : Math.round(breakEvenRate * 1000) / 1000,
        verdict,
      }
    })
    return buckets
  }

  /** Count one archived result; replaces rescanning every index.json. */
  recordArchive({ chars = 0, stubChars = 0, annotated = true }) {
    const row = this.state.buckets[bucketOf(chars)]
    if (!row) return
    row.archived += 1
    if (annotated) row.annotatedArchived += 1
    row.archivedChars += chars
    row.stubChars += stubChars
    this.scheduleSave()
  }

  /** Drop everything and fold from the logs again (explicit rebuild). */
  reconcile() {
    const fresh = computeStats({})
    const state = emptyState()
    for (const row of fresh.buckets) {
      state.buckets[row.bucket] = {
        seen: row.seen,
        annotated: row.annotated ?? 0,
        archived: row.archived ?? 0,
        annotatedArchived: row.archived ?? 0,
        archivedChars: row.archivedChars ?? 0,
        stubChars: row.stubChars ?? 0,
      }
    }
    // Seed lastSeq so the next live event for these sessions is not folded twice.
    for (const [id, lastSeq] of Object.entries(fresh.sessionSeq ?? {})) {
      state.sessions[id] = { lastSeq }
    }
    this.state = state
    this.dirty = true
    this.flush()
    return fresh
  }
}

function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => join(dir, item.name))
  } catch {
    return []
  }
}
