/**
 * Compatibility guard: declare-and-check.
 *
 * DSH refuses (or skips) a plugin whose `engines.dsh` range does not satisfy the
 * running runtime. That refusal is invisible until the user hits it, and an
 * exact pin like `0.2.1-rc.1 || 0.2.1-rc.2` breaks on every prerelease bump.
 *
 * This script runs before `npm test` and checks the manifest against the DSH
 * that is actually installed on this machine, so the next runtime upgrade fails
 * loudly here instead of silently in the user's profile.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parse(version) {
  const match = VERSION.exec(String(version ?? '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** SemVer 2.0 precedence, including prerelease identifiers. */
export function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  const left = a.prerelease
  const right = b.prerelease
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index]
    const two = right[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    const numeric = /^\d+$/.test(one)
    const otherNumeric = /^\d+$/.test(two)
    if (numeric && otherNumeric) {
      const diff = Number(one) - Number(two)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (numeric !== otherNumeric) return numeric ? -1 : 1
    if (one !== two) return one < two ? -1 : 1
  }
  return 0
}

/** Comparable `>=x`, `>x`, `<=x`, `<x`, `=x` comparators joined by spaces, alternatives by `||`. */
export function satisfies(version, range) {
  const parsed = parse(version)
  if (!parsed || typeof range !== 'string' || range.trim() === '') return false
  const alternatives = range.split('||')
  return alternatives.some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean)
    if (comparators.length === 0) return false
    return comparators.every((comparator) => {
      const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator)
      if (!match) return false
      const bound = parse(match[2])
      if (!bound) return false
      const order = compare(parsed, bound)
      switch (match[1] ?? '=') {
        case '>=':
          return order >= 0
        case '>':
          return order > 0
        case '<=':
          return order <= 0
        case '<':
          return order < 0
        default:
          return order === 0
      }
    })
  })
}

/** Read the app version stamped into an Electron asar archive. */
export function asarVersion(asarPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuffer = Buffer.alloc(headerSize)
    readSync(fd, headerBuffer, 0, headerSize, 16)
    const header = JSON.parse(headerBuffer.toString('utf8'))
    const base = 16 + headerSize
    for (const candidate of [['package.json'], ['dsh', 'package.json']]) {
      let node = header
      for (const part of candidate) {
        node = node?.files?.[part]
        if (!node) break
      }
      if (!node || node.files) continue
      const offset = Number(node.offset)
      const size = Number(node.size)
      if (!Number.isFinite(offset) || !Number.isFinite(size)) continue
      const body = Buffer.alloc(size)
      readSync(fd, body, 0, size, base + offset)
      const parsed = JSON.parse(body.toString('utf8'))
      if (parse(parsed.version)) return parsed.version
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return null
}

/** The DSH runtime that this machine runs, when it can be discovered. */
export function runtimeVersion() {
  const explicit = process.env.DSH_VERSION
  if (explicit && parse(explicit)) return { version: explicit, source: 'DSH_VERSION' }
  const candidates = [
    process.env.DSH_ASAR,
    'D:/dsh/resources/app.asar',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness', 'resources', 'app.asar'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  ].filter(Boolean)
  for (const asar of candidates) {
    if (!existsSync(asar)) continue
    const version = asarVersion(asar)
    if (version) return { version, source: asar }
  }
  return null
}

/** Unmet requirements in the shape DSH itself reports, plus the compared version. */
export function checkManifest(packageJson, runtime) {
  const unmet = {}
  const engines = packageJson.engines ?? {}
  if (Object.hasOwn(engines, 'dsh')) {
    if (!satisfies(runtime, engines.dsh)) unmet['engines.dsh'] = engines.dsh
  } else {
    for (const [name, range] of Object.entries(packageJson.peerDependencies ?? {})) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
      if (!satisfies(runtime, range)) unmet[name] = range
    }
  }
  return unmet
}

/** An exact pin (`0.2.1-rc.1 || 0.2.1-rc.2`) dies on the next prerelease. */
export function isExactPin(range) {
  return String(range ?? '')
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(part))
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const runtime = runtimeVersion()
  if (!runtime) {
    console.log('[compat] skipped: no DSH runtime found (set DSH_VERSION or DSH_ASAR to check explicitly)')
    process.exit(0)
  }
  const unmet = checkManifest(manifest, runtime.version)
  const pins = []
  if (isExactPin(manifest.engines?.dsh)) pins.push(`engines.dsh=${manifest.engines.dsh}`)
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/schemastery') continue
    if (isExactPin(range)) pins.push(`${name}=${range}`)
  }

  console.log(`[compat] runtime ${runtime.version} (${runtime.source})`)
  console.log(`[compat] engines.dsh ${manifest.engines?.dsh ?? '(none)'}`)

  let failed = false
  if (Object.keys(unmet).length > 0) {
    failed = true
    console.error(`[compat] INCOMPATIBLE with dsh ${runtime.version}: ${JSON.stringify(unmet)}`)
    console.error('[compat] widen the range (e.g. ">=0.2.1-rc.1 <0.3.0") and publish before telling users to upgrade.')
  }
  if (pins.length > 0) {
    failed = true
    console.error(`[compat] exact version pins break on the next prerelease: ${pins.join(', ')}`)
    console.error('[compat] use an open-ended range instead of "0.2.1-rc.1 || 0.2.1-rc.2".')
  }
  if (!failed) console.log('[compat] ok')
  process.exit(failed ? 1 : 0)
}
