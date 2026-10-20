import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { annotationFor, hashId, splitAnnotation } from '../lib/core.js'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Load the plugin against stub @deepseek-ai modules (defineTool identity, schema chainable). */
async function loadPlugin() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-context-archive-test-'))
  const deepseek = join(root, 'node_modules', '@deepseek-ai')
  const toolRoot = join(deepseek, 'dsh-tools')
  const schemaRoot = join(deepseek, 'schemastery')
  mkdirSync(toolRoot, { recursive: true })
  mkdirSync(schemaRoot, { recursive: true })
  writeFileSync(
    join(toolRoot, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', exports: './index.js' }),
  )
  writeFileSync(join(toolRoot, 'index.js'), 'export function defineTool(tool) { return tool }\n')
  writeFileSync(
    join(schemaRoot, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', type: 'module', exports: './index.js' }),
  )
  writeFileSync(
    join(schemaRoot, 'index.js'),
    [
      'const chain = () => { const c = { step: () => c, min: () => c, default: () => c }; return c }',
      'export default { number: chain, boolean: chain, object: (shape) => shape }',
      '',
    ].join('\n'),
  )
  mkdirSync(join(root, 'lib'))
  for (const file of ['core.js', 'index.js']) {
    writeFileSync(join(root, 'lib', file), readFileSync(join(pluginRoot, 'lib', file)))
  }
  const module = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  return { root, module }
}

/** Minimal stand-in for a live Session: surface ops replace the shadowed node. */
function makeSession(events) {
  const log = [...events]
  // `tool/call` is a known log event but NOT surface-eligible: only message events join.
  const surface = new Set(
    events.map((event, index) => (event.type === 'tool/call' ? -1 : index)).filter((index) => index >= 0),
  )
  return {
    header: { id: 'sess-test', cwd: 'C:\\work\\demo' },
    get surface() {
      return { nodes: [...surface].sort((a, b) => a - b) }
    },
    get log() {
      return log
    },
    eventAt(seq) {
      return log[seq]
    },
    deriveEventMessage(event) {
      return event.type === 'tool/result' ? event.data.message : null
    },
    append(type, data, opts) {
      if (opts?.surfaceOp?.op === 'replace') surface.delete(opts.surfaceOp.startSeq)
      const event = { type, seq: log.length, time: 1_700_000_000_000, data, ...(opts ?? {}) }
      log.push(event)
      surface.add(event.seq)
      return event
    },
  }
}

function pair(callId, name, text, { turn = 1, nonText = false } = {}) {
  const content = nonText
    ? [{ type: 'text', text }, { type: 'image', url: 'file:///x.png' }]
    : [{ type: 'text', text }]
  return [
    { type: 'tool/call', time: 1_700_000_000_000, data: { turn, step: 0, callId, name, arguments: '{}' } },
    {
      type: 'tool/result',
      time: 1_700_000_000_000,
      data: {
        turn,
        step: 0,
        message: {
          id: `msg-${callId}`,
          role: 'tool',
          toolCallId: callId,
          isError: false,
          source: { kind: 'tool', callId },
          content,
        },
      },
    },
  ]
}

function makeCtx(root) {
  const handlers = new Map()
  let registered
  const ctx = {
    tools: {
      register(tool) {
        registered = tool
      },
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    get(name) {
      if (name !== 'sessionPersistence') return undefined
      return { locate: () => ({ path: join(root, 'sessions', 'proj', 'sess-test', 'session.v4.jsonl.zstd') }) }
    },
    get tool() {
      return registered
    },
    get handlers() {
      return handlers
    },
  }
  return ctx
}

const LONG = 'x'.repeat(2000)

test('list mode returns hash ids for results outside the turn guard', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', LONG, { turn: 1 }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
      ...pair('c2', 'bash', 'short', { turn: 3 }),
      ...pair('c3', 'bash', LONG + 'b', { turn: 4 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx)
    const out = JSON.parse(await ctx.tool.execute({}, { agent: { session } }))
    assert.equal(out.mode, 'list')
    assert.equal(out.candidates.length, 1, 'default keep_turns=3 leaves only turn 1')
    assert.equal(out.candidates[0].id, hashId(LONG))
    assert.equal(out.candidates[0].tool, 'bash', 'tool name resolves from the tool/call log event')
    assert.deepEqual(out.archived, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keep_turns=0 drops the turn guard entirely', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', LONG, { turn: 1 }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx)
    const out = JSON.parse(await ctx.tool.execute({ keep_turns: 0 }, { agent: { session } }))
    assert.equal(out.candidates.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archive writes the original to the session folder and leaves a stub', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', LONG, { turn: 1 }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
      ...pair('c2', 'bash', LONG + 'b', { turn: 3 }),
      ...pair('c3', 'bash', LONG + 'c', { turn: 4 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx)
    const id = hashId(LONG)
    const out = JSON.parse(
      await ctx.tool.execute({ ids: [id], keep_turns: 2, note: '已提取字段' }, { agent: { session } }),
    )
    assert.equal(out.outcomes[0].status, 'archived', JSON.stringify(out))

    const archiveFile = out.outcomes[0].file
    assert.ok(archiveFile.endsWith(`${id}.txt`))
    assert.ok(archiveFile.includes(join('sess-test', 'archives')), 'archives live in the session folder')
    const body = readFileSync(archiveFile, 'utf8')
    assert.ok(body.includes('tool: bash'))
    assert.ok(body.includes('note: 已提取字段'))
    assert.ok(body.endsWith(LONG), 'original text is preserved verbatim')

    const replacement = session.log.at(-1)
    assert.equal(replacement.type, 'tool/result')
    assert.equal(replacement.surfaceOp.op, 'replace')
    assert.equal(replacement.surfaceOp.startSeq, 1)
    const stub = replacement.data.message.content[0].text
    assert.match(stub, new RegExp(`^\\[archived #${id} · bash · 2000 chars`))
    assert.ok(stub.includes(archiveFile))

    // Everything except content must be unchanged (host validates this).
    const strip = (value) => ({ ...value, message: { ...value.message, content: null } })
    assert.deepEqual(strip(replacement.data), strip(session.log[1].data))

    const index = JSON.parse(readFileSync(join(out.dir, 'index.json'), 'utf8'))
    assert.equal(index.entries[id].tool, 'bash')
    assert.equal(index.entries[id].chars, 2000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiving twice is idempotent and honours the turn guard', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', LONG, { turn: 1 }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
      ...pair('c2', 'bash', LONG + 'b', { turn: 3 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx)
    const oldId = hashId(LONG)
    const recentId = hashId(LONG + 'b')

    const first = JSON.parse(
      await ctx.tool.execute({ ids: [oldId], keep_turns: 2 }, { agent: { session } }),
    )
    assert.equal(first.outcomes[0].status, 'archived')
    const again = JSON.parse(
      await ctx.tool.execute({ ids: [oldId, recentId], keep_turns: 2 }, { agent: { session } }),
    )
    const byId = new Map(again.outcomes.map((item) => [item.id, item.status]))
    assert.equal(byId.get(oldId), 'already_archived')
    assert.equal(byId.get(recentId), 'skipped_recent_turn')
    assert.equal(session.log.filter((event) => event.type === 'tool/result').length, 4, 'no duplicate replacement')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bad and unknown ids are reported, never thrown', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', LONG, { turn: 1 }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx)
    const out = JSON.parse(await ctx.tool.execute({ ids: ['NOT-AN-ID', 'ffffffff'] }, { agent: { session } }))
    const byId = new Map(out.outcomes.map((item) => [item.id, item.status]))
    assert.equal(byId.get('not-an-id'), 'invalid_id')
    assert.equal(byId.get('ffffffff'), 'not_found')
    assert.equal(out.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('results with non-text blocks are never archived', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'read_image', LONG, { turn: 1, nonText: true }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
      ...pair('c2', 'bash', LONG + 'b', { turn: 3 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx)
    const out = JSON.parse(await ctx.tool.execute({ keep_turns: 1 }, { agent: { session } }))
    assert.equal(out.candidates.length, 1, 'the long text result stays eligible')
    assert.ok(out.candidates.every((item) => item.id !== hashId(LONG)), 'non-text result is not a candidate')
    const archived = JSON.parse(
      await ctx.tool.execute({ ids: [hashId(LONG)], keep_turns: 1 }, { agent: { session } }),
    )
    assert.equal(archived.outcomes[0].status, 'skipped_nontext')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a session without a live handle fails open', async () => {
  const { root, module } = await loadPlugin()
  try {
    const ctx = makeCtx(root)
    module.apply(ctx)
    const out = JSON.parse(await ctx.tool.execute({}, {}))
    assert.equal(out.ok, false)
    assert.match(out.error, /no live session/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('post-execute annotates long text results with an inline id', async () => {
  const { root, module } = await loadPlugin()
  try {
    const ctx = makeCtx(root)
    module.apply(ctx)
    const handler = ctx.handlers.get('tools/post-execute')
    assert.equal(typeof handler, 'function', 'annotation hook registered')

    const content = [{ type: 'text', text: LONG }]
    const decision = await handler(
      { name: 'ops_bash' },
      { content },
      async () => ({ kind: 'accept' }),
    )
    const text = decision.content[0].text
    const parsed = splitAnnotation(text)
    assert.equal(parsed.id, hashId(LONG))
    assert.equal(parsed.chars, 2000)
    assert.equal(parsed.body, LONG)
    assert.ok(text.startsWith(`[#${hashId(LONG)} · 2000 chars]\n`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('annotation is skipped for short, non-text, replaced and already-annotated results', async () => {
  const { root, module } = await loadPlugin()
  try {
    const ctx = makeCtx(root)
    module.apply(ctx)
    const handler = ctx.handlers.get('tools/post-execute')
    const nextWith = (content) => async () => ({ kind: 'accept', content })
    const shortContent = [{ type: 'text', text: 'ok' }]

    const short = await handler({ name: 'ops_bash' }, { content: shortContent }, nextWith(shortContent))
    assert.equal(short.content, shortContent, 'short results keep the untouched decision')

    const richContent = [{ type: 'image', url: 'x' }, { type: 'text', text: LONG }]
    const image = await handler({ name: 'read_image' }, { content: richContent }, nextWith(richContent))
    assert.equal(image.content, richContent, 'multi-block results keep the untouched decision')

    const replaced = await handler({ name: 'ops_bash' }, { content: [] }, async () => ({
      kind: 'accept',
      value: 42,
    }))
    assert.equal(replaced.value, 42)

    const annotated = annotationFor(hashId(LONG), 2000) + LONG
    const annotatedContent = [{ type: 'text', text: annotated }]
    const again = await handler({ name: 'ops_bash' }, { content: annotatedContent }, nextWith(annotatedContent))
    assert.equal(again.content, annotatedContent, 'no double annotation')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an inline-annotated result can be archived without listing first', async () => {
  const { root, module } = await loadPlugin()
  try {
    const id = hashId(LONG)
    const annotated = annotationFor(id, 2000) + LONG
    const session = makeSession([
      ...pair('c0', 'ops_bash', annotated, { turn: 1 }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx)
    const out = JSON.parse(await ctx.tool.execute({ ids: [id], keep_turns: 0 }, { agent: { session } }))
    assert.equal(out.outcomes[0].status, 'archived')
    const body = readFileSync(out.outcomes[0].file, 'utf8')
    assert.ok(body.endsWith(LONG), 'the annotation prefix is not written into the archive')
    assert.ok(!body.includes('[#'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plugin config supplies the defaults; per-call args still win', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', LONG, { turn: 1 }),
      ...pair('c1', 'bash', LONG + 'a', { turn: 2 }),
      ...pair('c2', 'bash', 'short', { turn: 3 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx, { keepTurns: 0, minChars: 1500 })

    const base = JSON.parse(await ctx.tool.execute({}, { agent: { session } }))
    assert.equal(base.candidates.length, 2, 'keepTurns=0 from config')

    const overridden = JSON.parse(await ctx.tool.execute({ min_chars: 5000 }, { agent: { session } }))
    assert.equal(overridden.candidates.length, 0, 'per-call min_chars overrides config')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('annotate=false disables inline ids; annotateMinChars gates them', async () => {
  const { root, module } = await loadPlugin()
  try {
    const off = makeCtx(root)
    module.apply(off, { annotate: false })
    assert.equal(off.handlers.has('tools/post-execute'), false, 'no hook when annotate is off')

    const high = makeCtx(root)
    module.apply(high, { annotateMinChars: 5000 })
    const handler = high.handlers.get('tools/post-execute')
    const content = [{ type: 'text', text: LONG }]
    const decision = await handler({ name: 'ops_bash' }, { content }, async () => ({ kind: 'accept', content }))
    assert.equal(decision.content, content, '2000-char result stays below the 5000 threshold')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('invalid config fails loudly instead of half-loading', async () => {
  const { root, module } = await loadPlugin()
  try {
    const ctx = makeCtx(root)
    assert.throws(() => module.apply(ctx, { keepTurns: -1 }), /keepTurns/)
    assert.throws(() => module.apply(ctx, { annotate: 'yes' }), /annotate/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
