/**
 * Pure helpers for dsh-context-archive: hashing, content flattening, stub
 * rendering, path fallbacks and replay-safe replacement payloads.
 *
 * Nothing in this file touches the filesystem or a live session, so it can be
 * unit-tested directly.
 */
import { createHash } from 'node:crypto'

/** First line of every archived stub; also the parse anchor. */
export const STUB_PREFIX = '[archived #'

/** Marker embedded in the stub so a second call can tell it is already archived. */
const STUB_ID = /^\[archived #([0-9a-f]{8})\b/
/** Full stub header: id, tool name, original size. */
const STUB_META = /^\[archived #([0-9a-f]{8}) · ([^·\n]+?) · (\d+) chars(?: \/ (\d+) lines)?\]/
/** Inline id prefix added to long results so the model can archive without listing. */
const ANNOTATION = /^\[#([0-9a-f]{8})(?: · (\d+) chars)?\]\n/

/** Lower bound for "worth archiving"; shorter results cost more to track than they save. */
export const DEFAULT_MIN_CHARS = 2000
/** Kept only to read configs written before the thresholds were merged. */
export const DEFAULT_ANNOTATE_MIN_CHARS = 2000
/** Keep the most recent turns untouched: the model usually still needs them. */
export const DEFAULT_KEEP_TURNS = 3
/** Upper bound per call keeps one tool call cheap and the rewrite bounded. */
export const MAX_ITEMS_PER_CALL = 20
/** List output budget. */
export const MAX_LIST_ENTRIES = 40
/** Stub preview budget in code points. */
const PREVIEW_CHARS = 120

/** Count Unicode code points without splitting surrogate pairs. */
export function charCount(text) {
  return Array.from(String(text ?? '')).length
}

/** One-line inline id prefix, e.g. `[#12a4b291]`. */
export function annotationFor(id) {
  return `[#${id}]\n`
}

/** Split an inline annotation from the body, or return no annotation. */
export function splitAnnotation(text) {
  const value = String(text ?? '')
  const match = ANNOTATION.exec(value)
  if (!match) return { id: null, chars: null, body: value }
  return { id: match[1], chars: match[2] === undefined ? null : Number(match[2]), body: value.slice(match[0].length) }
}

/** Stable 8-hex id derived from a tool result's full text. */
export function hashId(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 8)
}

/**
 * Concatenate the text blocks of a tool-result content array.
 * Non-text blocks are ignored by the caller (they make a result ineligible).
 */
export function flattenText(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Whether any block is not text (images etc. would be lost by archiving). */
export function hasNonText(content) {
  if (!Array.isArray(content)) return false
  return content.some((block) => !block || block.type !== 'text')
}

/** Parse the id out of an existing archive stub, or null. */
export function stubIdOf(content) {
  const text = flattenText(content)
  const match = STUB_ID.exec(text)
  return match ? match[1] : null
}

/**
 * Parse a stub header back into the original tool name and size, so an archived
 * entry can still be described accurately in the list output.
 */
export function stubMetaOf(content) {
  const text = flattenText(content)
  const match = STUB_META.exec(text)
  if (!match) return null
  return {
    id: match[1],
    tool: match[2].trim(),
    chars: Number(match[3]),
    lines: match[4] ? Number(match[4]) : 0,
  }
}

/** One-line preview of the original text for the stub and the list output. */
export function previewOf(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(flat).slice(0, PREVIEW_CHARS).join('')
}

/**
 * Render the replacement content for one archived result.
 * Kept short on purpose: the stub exists to tell the model what was archived
 * and where to find it, not to re-summarize the payload.
 */
export function renderStub({ id, tool, chars, lines, file, preview }) {
  const size = `${chars} chars${lines > 0 ? ` / ${lines} lines` : ''}`
  const head = `${STUB_PREFIX}${id} · ${tool || 'tool'} · ${size}]`
  const rows = [head, `file: ${file}`]
  if (preview) rows.push(`first: ${preview}`)
  rows.push('原文已保留在该文件与会话日志中；需要时用 read/grep 打开上面的路径。')
  return rows.join('\n')
}

/** Replay-safe replacement payload: change only `content`, keep every other field. */
export function replacementData(eventData, text) {
  const data = eventData ?? {}
  const message = data.message ?? {}
  return {
    ...data,
    message: {
      ...message,
      content: [{ type: 'text', text }],
    },
  }
}

/**
 * Fallback encoder for the session project directory, mirroring
 * `projectKey` in dsh-session-persistence-jsonl. Used only when the persistence
 * service does not expose `locate()`.
 */
export function projectKey(cwd) {
  if (!cwd) return '_no-cwd'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Safe single path segment (session ids are already safe, but never trust input). */
export function encodeSegment(raw) {
  const value = String(raw ?? '')
  if (value.length === 0) throw new Error('empty path segment')
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Header block written above the archived original text. */
export function archiveFileBody({ sessionId, seq, tool, time, chars, lines, note, text }) {
  const header = [
    '# dsh-context-archive',
    `session: ${sessionId ?? 'unknown'}`,
    `seq: ${seq}`,
    `tool: ${tool || 'tool'}`,
    `time: ${time ?? new Date().toISOString()}`,
    `chars: ${chars}`,
    `lines: ${lines}`,
    note ? `note: ${String(note).replace(/\s+/g, ' ').slice(0, 500)}` : null,
    '---',
  ]
    .filter((line) => line !== null)
    .join('\n')
  return header + '\n\n' + text
}
