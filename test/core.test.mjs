import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_KEEP_TURNS,
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
  stubIdOf,
  stubMetaOf,
} from '../lib/core.js'

test('hashId is 8 lowercase hex chars and content-stable', () => {
  const a = hashId('hello world')
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.equal(a, hashId('hello world'))
  assert.notEqual(a, hashId('hello world!'))
})

test('hashId does not split on different line endings', () => {
  assert.notEqual(hashId('a\r\nb'), hashId('a\nb'))
})

test('flattenText joins only text blocks', () => {
  assert.equal(
    flattenText([
      { type: 'text', text: 'ab' },
      { type: 'image', url: 'x' },
      { type: 'text', text: 'cd' },
    ]),
    'abcd',
  )
  assert.equal(flattenText(undefined), '')
})

test('hasNonText detects rich blocks', () => {
  assert.equal(hasNonText([{ type: 'text', text: 'x' }]), false)
  assert.equal(hasNonText([{ type: 'text', text: 'x' }, { type: 'image' }]), true)
})

test('charCount counts code points, not UTF-16 units', () => {
  assert.equal(charCount('a😀b'), 3)
})

test('previewOf collapses whitespace and truncates by code point', () => {
  assert.equal(previewOf('  a\n\n b\tc  '), 'a b c')
  assert.equal(Array.from(previewOf('x'.repeat(500))).length, 120)
})

test('stub round-trips its id and stays parseable', () => {
  const id = 'deadbeef'
  const stub = renderStub({
    id,
    tool: 'bash',
    chars: 12345,
    lines: 120,
    file: '/tmp/archives/deadbeef.txt',
    preview: 'npm test',
  })
  assert.match(stub, /^\[archived #deadbeef · bash · 12345 chars \/ 120 lines\]/)
  assert.match(stub, /file: \/tmp\/archives\/deadbeef\.txt/)
  assert.equal(stubIdOf([{ type: 'text', text: stub }]), id)
})

test('stubIdOf returns null for ordinary output', () => {
  assert.equal(stubIdOf([{ type: 'text', text: 'total 0\ndrwxr-xr-x' }]), null)
  assert.equal(stubIdOf([]), null)
})

test('replacementData changes only message.content', () => {
  const data = {
    turn: 2,
    step: 4,
    message: {
      id: 'm1',
      role: 'tool',
      toolCallId: 'call_1',
      isError: false,
      source: { kind: 'tool', callId: 'call_1' },
      content: [{ type: 'text', text: 'old output' }],
    },
  }
  const next = replacementData(data, 'stub')
  assert.deepEqual(next.message.content, [{ type: 'text', text: 'stub' }])
  assert.deepEqual({ ...next, message: { ...next.message, content: null } }, { ...data, message: { ...data.message, content: null } })
  assert.equal(data.message.content[0].text, 'old output', 'input must not be mutated')
})

test('projectKey mirrors the session project directory encoding', () => {
  assert.equal(projectKey('C:\\Users\\admin\\Documents\\deepseek-harness\\default-workspace'), '--C-Users-admin-Documents-deepseek-harness-default-workspace--')
  assert.equal(projectKey('/workspace/aile'), '--workspace-aile--')
  assert.equal(projectKey(undefined), '_no-cwd')
})

test('encodeSegment keeps safe characters and escapes the rest', () => {
  assert.equal(encodeSegment('abc-123._'), 'abc-123._')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
})

test('archiveFileBody keeps the original text verbatim below the header', () => {
  const text = 'line1\nline2 😀\n'
  const body = archiveFileBody({
    sessionId: 's1',
    seq: 7,
    tool: 'read',
    time: '2026-10-20T00:00:00.000Z',
    chars: charCount(text),
    lines: 3,
    note: '已提取字段',
    text,
  })
  assert.ok(body.startsWith('# dsh-context-archive\nsession: s1\nseq: 7\ntool: read\n'))
  assert.ok(body.includes('note: 已提取字段'))
  assert.ok(body.endsWith('---\n\n' + text))
})

test('defaults are sane', () => {
  assert.ok(DEFAULT_KEEP_TURNS >= 1)
})

test('stubMetaOf recovers the original tool and size from a stub', () => {
  const stub = renderStub({ id: 'deadbeef', tool: 'ops_bash', chars: 24810, lines: 612, file: '/tmp/x.txt', preview: 'npm run build' })
  assert.deepEqual(stubMetaOf([{ type: 'text', text: stub }]), { id: 'deadbeef', tool: 'ops_bash', chars: 24810, lines: 612 })
  assert.equal(stubMetaOf([{ type: 'text', text: 'ordinary output' }]), null)
})
