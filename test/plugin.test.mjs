import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  const llmRoot = join(deepseek, 'dsh-llm')
  mkdirSync(toolRoot, { recursive: true })
  mkdirSync(schemaRoot, { recursive: true })
  mkdirSync(llmRoot, { recursive: true })
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
  writeFileSync(
    join(llmRoot, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', exports: './index.js' }),
  )
  writeFileSync(
    join(llmRoot, 'index.js'),
    'export function createUserMessage(input) { return { id: "nudge", role: "user", ...input } }\n',
  )
  mkdirSync(join(root, 'lib'))
  for (const file of readdirSync(join(pluginRoot, 'lib')).filter((name) => name.endsWith('.js'))) {
    writeFileSync(join(root, 'lib', file), readFileSync(join(pluginRoot, 'lib', file)))
  }
  // Keep the runtime config file inside the test sandbox.
  mkdirSync(join(root, 'home'))
  process.env.DSH_HOME = join(root, 'home')
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

    const replacement = session.log.filter((event) => event.surfaceOp?.op === 'replace' && event.surfaceOp.startSeq === 1).at(-1)
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
    module.apply(ctx, { annotate: false })
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
    assert.equal(parsed.chars, null, 'the short form omits the size')
    assert.equal(parsed.body, LONG)
    assert.equal(text, `[#${hashId(LONG)}]\n` + LONG, '12-character prefix, no size')
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

    const annotated = annotationFor(hashId(LONG)) + LONG
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
    const annotated = annotationFor(id) + LONG
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
    const offHandler = off.handlers.get('tools/post-execute')
    const content = [{ type: 'text', text: LONG }]
    const kept = await offHandler({ name: 'ops_bash' }, { content }, async () => ({ kind: 'accept', content }))
    assert.equal(kept.content, content, 'annotate=false keeps the result untouched')

    const high = makeCtx(root)
    module.apply(high, { minChars: 5000 })
    const handler = high.handlers.get('tools/post-execute')
    const decision = await handler({ name: 'ops_bash' }, { content }, async () => ({ kind: 'accept', content }))
    assert.equal(decision.content, content, '2000-char result stays below the 5000 threshold')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a config file written at runtime applies to the next result (no restart)', async () => {
  const { root, module } = await loadPlugin()
  try {
    const ctx = makeCtx(root)
    module.apply(ctx, { minChars: 2000 })
    const handler = ctx.handlers.get('tools/post-execute')
    const content = [{ type: 'text', text: LONG }]
    const next = async () => ({ kind: 'accept', content })

    const before = await handler({ name: 'ops_bash' }, { content }, next)
    assert.notEqual(before.content, undefined, 'default 2000 annotates a 2000-char result')

    // The panel POSTs this file; the hook must pick it up on the next call.
    writeFileSync(join(root, 'home', 'context-archive.json'), JSON.stringify({ minChars: 5000 }))
    const after = await handler({ name: 'ops_bash' }, { content }, next)
    assert.equal(after.content, content, 'the higher threshold applies immediately')
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

/** Fake res that records what a route handler wrote. */
function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

test('stats and config routes answer over the host web server', async () => {
  const { root, module } = await loadPlugin()
  try {
    const routes = new Map()
    const ctx = {
      tools: { register() {} },
      on() {},
      inject(deps, callback) {
        assert.deepEqual(deps, ['webServer'])
        callback({
          effect(fn) {
            fn()
          },
          webServer: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        })
      },
      get() {
        return undefined
      },
    }
    module.apply(ctx, { annotateMinChars: 2000 })
    assert.ok(routes.has('/dsh-context-archive/stats'))
    assert.ok(routes.has('/dsh-context-archive/config'))

    // GET /config reports defaults + effective values.
    const configRes = makeRes()
    routes.get('/dsh-context-archive/config').handler({ method: 'GET', url: '/dsh-context-archive/config' }, configRes)
    assert.equal(configRes.status, 200)
    const configPayload = JSON.parse(configRes.body)
    assert.equal(configPayload.defaults.maxAnnotated, 200)
    assert.equal(configPayload.effective.minChars, 2000)

    // POST /config writes the runtime file the hooks read.
    const { EventEmitter } = await import('node:events')
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/dsh-context-archive/config'
    const writeRes = makeRes()
    routes.get('/dsh-context-archive/config').handler(req, writeRes)
    req.emit('data', JSON.stringify({ minChars: 500, keepTurns: 0 }))
    req.emit('end')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(writeRes.status, 200)
    assert.equal(JSON.parse(writeRes.body).effective.minChars, 500)

    const statsRes = makeRes()
    routes.get('/dsh-context-archive/stats').handler({ method: 'GET', url: '/dsh-context-archive/stats' }, statsRes)
    assert.equal(statsRes.status, 200)
    const statsPayload = JSON.parse(statsRes.body)
    assert.equal(statsPayload.buckets.length, 6)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('maxAnnotated caps how many live ids exist at once', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([...pair('c0', 'ops_bash', annotationFor('aaaaaaaa') + LONG, { turn: 1 })])
    const ctx = makeCtx(root)
    module.apply(ctx, { minChars: 2000, maxAnnotated: 1 })
    const handler = ctx.handlers.get('tools/post-execute')
    const content = [{ type: 'text', text: 'z'.repeat(2500) }]
    const decision = await handler(
      { name: 'ops_bash', agent: { session } },
      { content },
      async () => ({ kind: 'accept', content }),
    )
    assert.equal(decision.content, content, 'the cap suppresses a second inline id')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pre-step nudges once when enough results are archivable', async () => {
  const { root, module } = await loadPlugin()
  try {
    const events = []
    for (let turn = 1; turn <= 8; turn++) events.push(...pair(`c${turn}`, 'ops_bash', 'n'.repeat(2500), { turn }))
    const session = makeSession(events)
    const ctx = makeCtx(root)
    module.apply(ctx, { minChars: 2000, keepTurns: 3 })
    const handler = ctx.handlers.get('agent/pre-step')
    assert.equal(typeof handler, 'function', 'nudge hook registered')
    const next = async () => ({ kind: 'enter', messages: [] })
    const first = await handler({ agent: { session }, messages: [] }, next)
    assert.equal(first.messages.length, 1, 'nudge appended to the request messages')
    assert.match(first.messages[0].content[0].text, /context-archive/)
    const second = await handler({ agent: { session }, messages: [] }, next)
    assert.equal(second.messages.length, 0, 'throttled until the event gap passes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('nudge message carries a producer-owned source kind that format v4 admits', async () => {
  const { root, module } = await loadPlugin()
  try {
    const events = []
    for (let turn = 1; turn <= 8; turn++) events.push(...pair(`c${turn}`, 'ops_bash', 'n'.repeat(2500), { turn }))
    const session = makeSession(events)
    const ctx = makeCtx(root)
    module.apply(ctx, { minChars: 2000, keepTurns: 3 })
    const handler = ctx.handlers.get('agent/pre-step')
    const next = async () => ({ kind: 'enter', messages: [] })
    const decision = await handler({ agent: { session }, messages: [] }, next)
    assert.equal(decision.messages.length, 1, 'nudge appended to the request messages')

    // The nudge lands in a durable `user/message` slot, and format v4 refuses the retired
    // v3 wrapper (`kind: 'plugin'`) there with "format v4 message requires a producer-owned
    // source kind" — that refusal used to abort the whole turn.
    const source = decision.messages[0].source
    assert.equal(typeof source?.kind, 'string', 'nudge source carries a string kind')
    assert.notEqual(source.kind, '', 'nudge source kind is not empty')
    assert.notEqual(source.kind, 'plugin', 'the retired v3 plugin wrapper is not admissible')
    assert.equal(source.kind, 'plugin:dsh-context-archive', 'the producer writes its own kind')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiving reconciles inline ids with the current threshold', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', annotationFor(hashId('old')) + 'a'.repeat(3000), { turn: 1 }),
      ...pair('c1', 'bash', 'b'.repeat(2500), { turn: 2 }),
      ...pair('c2', 'bash', 'c'.repeat(6000), { turn: 3 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx, { minChars: 2000, keepTurns: 0 })
    const out = JSON.parse(
      await ctx.tool.execute({ ids: [hashId('old')], keep_turns: 0 }, { agent: { session } }),
    )
    assert.equal(out.sync.added, 2, 'both remaining long results get ids')
    const texts = session.log
      .filter((event) => event.type === 'tool/result' && event.surfaceOp?.op === 'replace')
      .map((event) => event.data.message.content[0].text)
    assert.ok(texts.some((text) => text.startsWith(`[#${hashId('b'.repeat(2500))}]`)))
    assert.ok(texts.some((text) => text.startsWith(`[#${hashId('c'.repeat(6000))}]`)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('raising the threshold strips ids and the cap limits additions', async () => {
  const { root, module } = await loadPlugin()
  try {
    const session = makeSession([
      ...pair('c0', 'bash', annotationFor(hashId('small')) + 's'.repeat(2500), { turn: 1 }),
      ...pair('c1', 'bash', 'x'.repeat(3000), { turn: 2 }),
      ...pair('c2', 'bash', 'y'.repeat(9000), { turn: 3 }),
      ...pair('c3', 'bash', annotationFor(hashId('victim')) + 'v'.repeat(5000), { turn: 4 }),
    ])
    const ctx = makeCtx(root)
    module.apply(ctx, { minChars: 4000, keepTurns: 0, maxAnnotated: 1 })
    const out = JSON.parse(
      await ctx.tool.execute({ ids: [hashId('victim')], keep_turns: 0 }, { agent: { session } }),
    )
    assert.equal(out.sync.removed, 1, 'the 2500 result is below the new threshold')
    assert.equal(out.sync.added, 1, 'only the largest result fits under the cap')
    const added = session.log
      .filter((event) => event.type === 'tool/result' && event.surfaceOp?.op === 'replace')
      .map((event) => event.data.message.content[0].text)
    assert.ok(added.some((text) => text.startsWith(`[#${hashId('y'.repeat(9000))}]`)))
    assert.ok(!added.some((text) => text.startsWith(`[#${hashId('x'.repeat(3000))}]`)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
