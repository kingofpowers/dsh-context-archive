/**
 * dsh-context-archive — let the model decide which tool results it no longer
 * needs, and archive them into the session's own directory.
 *
 * One call, when a result already carries its inline id:
 *   context_archive { ids: ["a1b2c3d4"] }   → archive + stub, in one go
 * One discovery call for older results that have no inline id:
 *   context_archive {}                      → numbered candidate list
 *
 * Each archived result:
 *   1. is written verbatim to `<session dir>/archives/<hash8>.txt`;
 *   2. is replaced on the surface by a one-line stub carrying id, size and path;
 *   3. keeps its original event in the append-only session log, so replay and
 *      the `read` tool can always recover the full text.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_ANNOTATE_MIN_CHARS,
  DEFAULT_KEEP_TURNS,
  DEFAULT_MIN_CHARS,
  MAX_ITEMS_PER_CALL,
  MAX_LIST_ENTRIES,
  annotationFor,
  archiveFileBody,
  charCount,
  encodeSegment,
  flattenText,
  hashId,
  hasNonText,
  previewOf,
  projectKey,
  renderStub,
  replacementData,
  splitAnnotation,
  stubIdOf,
  stubMetaOf,
  STUB_PREFIX,
} from './core.js'

export const name = 'dsh-context-archive'
export const inject = ['tools']

const TOOL_NAME = 'context_archive'
const ID_PATTERN = /^[0-9a-f]{8}$/

/**
 * Plugin-level defaults, editable in the profile patch:
 *
 * ```yaml
 * - id: context-archive
 *   config:
 *     keepTurns: 0
 *     annotateMinChars: 4000
 * ```
 *
 * Per-call tool arguments win over these values.
 */
export const Config = z.object({
  keepTurns: z.number().step(1).min(0).default(DEFAULT_KEEP_TURNS),
  minChars: z.number().step(1).min(0).default(DEFAULT_MIN_CHARS),
  annotate: z.boolean().default(true),
  annotateMinChars: z.number().step(1).min(0).default(DEFAULT_ANNOTATE_MIN_CHARS),
})

/** Validate raw configuration into the immutable settings used by both halves. */
function resolveConfig(raw = {}) {
  const settings = {
    keepTurns: raw.keepTurns ?? DEFAULT_KEEP_TURNS,
    minChars: raw.minChars ?? DEFAULT_MIN_CHARS,
    annotate: raw.annotate ?? true,
    annotateMinChars: raw.annotateMinChars ?? DEFAULT_ANNOTATE_MIN_CHARS,
  }
  for (const key of ['keepTurns', 'minChars', 'annotateMinChars']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 0) {
      throw new Error(`context-archive: ${key} must be a non-negative integer (got ${JSON.stringify(settings[key])})`)
    }
  }
  if (typeof settings.annotate !== 'boolean') {
    throw new Error(`context-archive: annotate must be a boolean (got ${JSON.stringify(settings.annotate)})`)
  }
  return Object.freeze(settings)
}

function log(ctx, message) {
  try {
    ctx?.logger?.warn?.(`context-archive: ${message}`)
  } catch {
    // logging must never break plugin loading
  }
}

/** Resolve `<session dir>/archives` through the persistence service, with a path fallback. */
function resolveArchiveDir(ctx, session) {
  const id = session?.header?.id
  const cwd = session?.header?.cwd
  let logPath = null
  try {
    const persistence = typeof ctx?.get === 'function' ? ctx.get('sessionPersistence') : undefined
    const located = persistence?.locate?.({ id, cwd })
    if (located?.path) logPath = located.path
  } catch {
    logPath = null
  }
  if (logPath) return { dir: join(dirname(logPath), 'archives'), id }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const root = join(home, 'sessions')
  const dir = cwd
    ? join(root, projectKey(cwd), encodeSegment(id), 'archives')
    : join(root, '_no-cwd', encodeSegment(id), 'archives')
  return { dir, id }
}

/**
 * Tool name for one result. `tool/call` events are not surface-eligible, so the
 * call is looked up in the log just before its result (same step, a few events
 * back); an unbounded scan is not worth it.
 */
function resolveToolName(session, callId, beforeSeq) {
  if (!callId) return 'tool'
  const floor = Math.max(0, beforeSeq - 200)
  for (let seq = beforeSeq - 1; seq >= floor; seq--) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/call' && event.data?.callId === callId) return event.data.name ?? 'tool'
  }
  return 'tool'
}

/** Walk the current surface once: every tool result, with name and derived text. */
function collectResults(session) {
  const results = []
  let order = 0
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (!message) continue
    results.push({ seq, order: order++, event, message })
  }
  for (const item of results) {
    const callId = item.message?.source?.callId ?? item.event?.data?.message?.toolCallId
    item.tool = resolveToolName(session, callId, item.seq)
    item.content = item.message.content
    item.text = flattenText(item.content)
    item.stubId = stubIdOf(item.content)
    // A long result carries `[#id · N chars]` from tools/post-execute; strip it
    // before hashing so the id is stable for the body alone.
    const annotated = splitAnnotation(item.text)
    item.body = annotated.body
    item.chars = charCount(item.body)
    item.annId = annotated.id
    item.id = item.stubId ?? item.annId ?? hashId(item.body)
    item.turn = Number.isInteger(item.event?.data?.turn) ? item.event.data.turn : null
    if (item.stubId) {
      const meta = stubMetaOf(item.content)
      if (meta) {
        item.tool = meta.tool
        item.chars = meta.chars
      }
    }
  }
  return results
}

function summarize(item, dir) {
  return {
    id: item.id,
    tool: item.tool,
    seq: item.seq,
    chars: item.chars,
    preview: previewOf(item.text),
    archived: Boolean(item.stubId),
    file: item.stubId ? join(dir, `${item.stubId}.txt`) : undefined,
  }
}

async function readIndex(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') return parsed
  } catch {
    // missing or unreadable index: start from an empty one
  }
  return { version: 1, entries: {} }
}

async function writeIndex(file, index) {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

function registerTool(ctx, settings) {
  const tool = defineTool({
    name: TOOL_NAME,
    description: [
      '列出或归档当前会话中较早、较长的工具结果，用来给上下文腾地方。',
      '较长的结果在写入上下文时会带一行前缀 [#编号 · 字符数]，直接把这些编号传给 ids 即可归档，不必先列清单。',
      '不传 ids：只返回候选清单（编号 = 结果正文的哈希前 8 位，附工具名、字符数、首行预览），不改变任何内容。',
      '传 ids：把这些结果写入本会话目录下的 archives/ 文件夹，并在上下文里替换成一行存根（编号、大小、归档文件路径）。',
      '原文始终保留在归档文件和只增的会话日志中，需要时用 read / grep 打开路径取回。',
      `最近 keep_turns 轮（当前默认 ${settings.keepTurns}）内的工具结果、以及含图片等非文本块的结果不会被归档；keep_turns=0 表示不设轮次护栏。`,
    ].join('\n'),
    parameters: {
      ids: {
        type: 'array',
        items: { type: 'string', description: '归档编号（8 位十六进制）' },
        description: '要归档的编号列表；省略时只返回候选清单',
      },
      note: {
        type: 'string',
        description: '归档原因，写入归档文件头与索引，便于事后审计；建议一句话',
      },
      keep_turns: {
        type: 'number',
        description: `最近多少轮保持不动，默认 ${settings.keepTurns}；0 表示全部可归档`,
      },
      min_chars: {
        type: 'number',
        description: `低于该字符数的结果不出现在清单里，默认 ${settings.minChars}`,
      },
      limit: {
        type: 'number',
        description: `清单最多返回多少条，默认 ${MAX_LIST_ENTRIES}`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (!session?.surface || typeof session.append !== 'function') {
        return JSON.stringify({ ok: false, error: 'no live session is attached to this tool call' })
      }

      const keepTurns = Number.isInteger(args?.keep_turns) ? Math.max(0, args.keep_turns) : settings.keepTurns
      const minChars = Number.isInteger(args?.min_chars) ? Math.max(0, args.min_chars) : settings.minChars
      const limit = Number.isInteger(args?.limit)
        ? Math.min(MAX_LIST_ENTRIES, Math.max(1, args.limit))
        : MAX_LIST_ENTRIES

      const { dir, id: sessionId } = resolveArchiveDir(ctx, session)
      const results = collectResults(session)
      const turnNumbers = results.map((item) => item.turn).filter((turn) => turn !== null)
      const latestTurn = turnNumbers.length > 0 ? Math.max(...turnNumbers) : 0
      /** Turn guard: results from the last `keepTurns` turns stay untouched. */
      const turnAllowed = (item) => {
        if (keepTurns <= 0) return true
        if (item.turn === null) return false
        return item.turn <= latestTurn - keepTurns
      }

      if (!Array.isArray(args?.ids) || args.ids.length === 0) {
        const entries = results
          .filter((item) => turnAllowed(item) && !item.stubId && !hasNonText(item.content) && item.chars >= minChars)
          .reverse()
          .slice(0, limit)
          .map((item) => summarize(item, dir))
        const archived = results.filter((item) => item.stubId).map((item) => summarize(item, dir))
        return JSON.stringify({
          ok: true,
          mode: 'list',
          session: sessionId ?? null,
          dir,
          candidates: entries,
          archived,
          notes: [
            keepTurns > 0
              ? `候选共 ${entries.length} 条；最近 ${keepTurns} 轮（turn >= ${latestTurn - keepTurns + 1}）不可归档。`
              : `候选共 ${entries.length} 条；未设轮次护栏。`,
            entries.length ? '把编号放进 ids 再调用一次；带 [#编号] 前缀的结果也可直接归档。' : '当前没有满足条件的候选。',
          ],
        })
      }

      await mkdir(dir, { recursive: true })
      const indexFile = join(dir, 'index.json')
      const index = await readIndex(indexFile)
      const ids = [...new Set(args.ids.map((value) => String(value).trim().toLowerCase()))].slice(
        0,
        MAX_ITEMS_PER_CALL,
      )
      const byId = new Map()
      for (const item of results) {
        if (!item.stubId && !byId.has(item.id)) byId.set(item.id, item)
      }

      const outcomes = []
      for (const id of ids) {
        if (!ID_PATTERN.test(id)) {
          outcomes.push({ id, status: 'invalid_id' })
          continue
        }
        const item = byId.get(id)
        if (!item) {
          const existing = results.find((value) => value.stubId === id)
          outcomes.push({ id, status: existing ? 'already_archived' : 'not_found' })
          continue
        }
        if (!turnAllowed(item)) {
          outcomes.push({ id, status: 'skipped_recent_turn', seq: item.seq, turn: item.turn })
          continue
        }
        if (hasNonText(item.content)) {
          outcomes.push({ id, status: 'skipped_nontext', seq: item.seq })
          continue
        }
        try {
          const file = join(dir, `${id}.txt`)
          const body = item.body
          const lines = body.split('\n').length
          if (!existsSync(file)) {
            const fileBody = archiveFileBody({
              sessionId,
              seq: item.seq,
              tool: item.tool,
              time: new Date(item.event.time).toISOString(),
              chars: item.chars,
              lines,
              note: args?.note,
              text: body,
            })
            await writeFile(file, fileBody, 'utf8')
          }
          const stub = renderStub({
            id,
            tool: item.tool,
            chars: item.chars,
            lines,
            file,
            preview: previewOf(body),
          })
          const replacement = session.append('tool/result', replacementData(item.event.data, stub), {
            surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq },
            sourceEventSeqs: [item.seq],
          })
          index.entries[id] = {
            seq: item.seq,
            tool: item.tool,
            chars: item.chars,
            file,
            note: args?.note ?? null,
            archivedAt: new Date().toISOString(),
            replacementSeq: replacement?.seq ?? null,
          }
          outcomes.push({ id, status: 'archived', seq: item.seq, chars: item.chars, file })
        } catch (error) {
          outcomes.push({ id, status: 'failed', seq: item.seq, error: error?.message ?? String(error) })
        }
      }

      try {
        index.session = sessionId ?? index.session ?? null
        await writeIndex(indexFile, index)
      } catch (error) {
        log(ctx, `index write failed: ${error?.message ?? error}`)
      }

      return JSON.stringify({
        ok: outcomes.some((item) => item.status === 'archived'),
        mode: 'archive',
        session: sessionId ?? null,
        dir,
        index: indexFile,
        outcomes,
      })
    },
  })
  ctx.tools.register(tool)
}

/**
 * Prefix long text-only results with `[#id · N chars]` while they are still
 * being written, so the model can archive from what it already sees instead of
 * paying for a listing call.
 */
function registerAnnotation(ctx, settings) {
  if (!settings.annotate) return
  if (typeof ctx?.on !== 'function') {
    log(ctx, 'event service is unavailable; inline ids disabled')
    return
  }
  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      const decision = await next()
      try {
        if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
        if (exec?.name === TOOL_NAME) return decision
        const content = decision.content ?? result?.content
        if (!Array.isArray(content) || content.length !== 1) return decision
        const block = content[0]
        if (block?.type !== 'text' || typeof block.text !== 'string') return decision
        if (block.text.startsWith(STUB_PREFIX)) return decision
        if (splitAnnotation(block.text).id) return decision
        const chars = charCount(block.text)
        if (chars < settings.annotateMinChars) return decision
        return {
          ...decision,
          content: [{ ...block, text: annotationFor(hashId(block.text), chars) + block.text }],
        }
      } catch (error) {
        log(ctx, `annotation failed: ${error?.message ?? error}`)
        return decision
      }
    },
    { prepend: true },
  )
}

export function apply(ctx, config = {}) {
  let settings
  try {
    settings = resolveConfig(config)
  } catch (error) {
    log(ctx, `invalid config: ${error?.message ?? error}`)
    throw error
  }
  try {
    if (typeof ctx?.tools?.register !== 'function') throw new Error('tools service is unavailable')
    registerTool(ctx, settings)
  } catch (error) {
    log(ctx, `tool registration failed: ${error?.message ?? error}`)
  }
  try {
    registerAnnotation(ctx, settings)
  } catch (error) {
    log(ctx, `annotation registration failed: ${error?.message ?? error}`)
  }
}
