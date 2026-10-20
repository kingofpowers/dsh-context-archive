/**
 * Runtime configuration for dsh-context-archive.
 *
 * The loader-level `config:` block only supplies the initial defaults. The
 * effective values live in `~/.dsh/context-archive.json`, which the settings
 * panel writes and which every hook re-reads (mtime-cached), so a change
 * applies to the next tool result without restarting DSH.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CONFIG_KEYS = ['keepTurns', 'minChars', 'annotate', 'nudge', 'maxAnnotated']

export function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'context-archive.json')
}

let cache = { mtimeMs: -1, value: null }

/** Read the runtime override, or null when the file is absent/unreadable. */
export function readRuntimeConfig() {
  const file = configPath()
  try {
    const { mtimeMs } = statSync(file)
    if (mtimeMs === cache.mtimeMs) return cache.value
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value = pickValid(parsed)
    cache = { mtimeMs, value }
    return value
  } catch {
    cache = { mtimeMs: -1, value: null }
    return null
  }
}

/** Write the runtime override atomically. Returns the sanitized value. */
export function writeRuntimeConfig(patch) {
  const file = configPath()
  const next = pickValid(patch)
  if (next === null) throw new Error('no valid config keys in payload')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  cache = { mtimeMs: -1, value: null }
  return next
}

/** Old two-threshold configs collapse into the single archive threshold. */
function migrate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  if (raw.annotateMinChars === undefined) return raw
  const { annotateMinChars, ...rest } = raw
  const merged = Math.max(
    Number.isInteger(rest.minChars) ? rest.minChars : 0,
    Number.isInteger(annotateMinChars) ? annotateMinChars : 0,
  )
  return { ...rest, ...(merged > 0 ? { minChars: merged } : {}) }
}

/** Keep only known keys with usable values; `null` when nothing survives. */
export function pickValid(input) {
  const raw = migrate(input)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const key of CONFIG_KEYS) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (key === 'annotate' || key === 'nudge') {
      if (typeof value === 'boolean') out[key] = value
      continue
    }
    if (Number.isInteger(value) && value >= 0) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Effective settings: runtime override first, then loader defaults. */
export function effectiveSettings(defaults) {
  const override = readRuntimeConfig()
  return override ? { ...defaults, ...override } : defaults
}
