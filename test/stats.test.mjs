import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { BUCKETS, PREFIX_CHARS, bucketOf, computeSessionStats, computeStats, decompressZstdFrames } from '../lib/stats.js'

function toolResult(text) {
  return JSON.stringify({
    type: 'tool/result',
    time: 1_700_000_000_000,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: 'm',
        role: 'tool',
        toolCallId: 'c',
        isError: false,
        source: { kind: 'tool', callId: 'c' },
        content: [{ type: 'text', text }],
      },
    },
  })
}

/** Two zstd frames, mirroring how the session log flushes batches. */
function writeLog(file, lines) {
  const half = Math.ceil(lines.length / 2)
  const frame1 = zlib.zstdCompressSync(Buffer.from(lines.slice(0, half).join('\n') + '\n'))
  const frame2 = zlib.zstdCompressSync(Buffer.from(lines.slice(half).join('\n') + '\n'))
  writeFileSync(file, Buffer.concat([frame1, frame2]))
}

test('bucketOf covers every size band', () => {
  assert.equal(bucketOf(0), '<500')
  assert.equal(bucketOf(499), '<500')
  assert.equal(bucketOf(500), '500-1k')
  assert.equal(bucketOf(1999), '1k-2k')
  assert.equal(bucketOf(2000), '2k-5k')
  assert.equal(bucketOf(20000), '20k+')
})

test('decompressZstdFrames reads concatenated frames', () => {
  const buffer = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from('a\n')),
    zlib.zstdCompressSync(Buffer.from('b\n')),
  ])
  const { text, complete } = decompressZstdFrames(buffer)
  assert.equal(text, 'a\nb\n')
  assert.equal(complete, true)
})

test('computeStats buckets the logs and joins the archives index', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-stats-'))
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const sessionDir = join(home, 'sessions', '--proj--', 'session-1')
    mkdirSync(join(sessionDir, 'archives'), { recursive: true })
    writeLog(join(sessionDir, 'session.v4.jsonl.zstd'), [
      toolResult('a'.repeat(400)), // <500
      toolResult('b'.repeat(600)), // 500-1k
      toolResult('[#aaaa1111 · 2500 chars]\n' + 'c'.repeat(2500)), // 2k-5k, annotated
      toolResult('[archived #deadbeef · tool · 3000 chars]\nfile: /x'), // stub, ignored
    ])
    writeFileSync(
      join(sessionDir, 'archives', 'index.json'),
      JSON.stringify({
        version: 1,
        entries: {
          deadbeef: { chars: 2500, stubChars: 300 },
        },
      }),
    )

    const stats = computeStats({})
    assert.equal(stats.sessions, 1)
    assert.equal(stats.totals.seen, 3, 'the stub is not counted as a fresh result')
    assert.equal(stats.totals.archived, 1)
    assert.equal(stats.totals.prefixCost, PREFIX_CHARS)
    const bucket = stats.buckets.find((row) => row.bucket === '2k-5k')
    assert.equal(bucket.seen, 1)
    assert.equal(bucket.archived, 1)
    assert.equal(bucket.rate, 1)
    assert.equal(bucket.avgChars, 2500)
    assert.equal(bucket.savingPerArchive, 2200)
    assert.equal(bucket.verdict, 'unknown', 'below the minimum sample')
    const empty = stats.buckets.find((row) => row.bucket === '<500')
    assert.equal(empty.archived, 0)
    assert.equal(empty.savingPerArchive, 0)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('computeStats withholds a recommendation until a band has samples', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-stats2-'))
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const sessionDir = join(home, 'sessions', '--proj--', 'session-1')
    mkdirSync(join(sessionDir, 'archives'), { recursive: true })
    const lines = [toolResult('x'.repeat(900)), toolResult('y'.repeat(5000)), toolResult('z'.repeat(5000))]
    writeLog(join(sessionDir, 'session.v4.jsonl.zstd'), lines)
    writeFileSync(
      join(sessionDir, 'archives', 'index.json'),
      JSON.stringify({ version: 1, entries: { aa: { chars: 5000, stubChars: 300 } } }),
    )
    const stats = computeStats({})
    const big = stats.buckets.find((row) => row.bucket === '5k-20k')
    assert.equal(big.savingPerArchive, 4700)
    assert.equal(big.breakEvenRate, 0.003, '13 chars of prefix against 4700 saved')
    assert.equal(big.verdict, 'unknown', 'one archive is not a sample')
    assert.equal(stats.recommendedMinChars, null)
    assert.ok(BUCKETS.length === 6)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('a band with enough samples is called profitable', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-stats3-'))
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const sessionDir = join(home, 'sessions', '--proj--', 'session-1')
    mkdirSync(join(sessionDir, 'archives'), { recursive: true })
    const lines = [5000, 5000, 5000, 5000, 300].map((n, index) =>
      toolResult(index < 4 ? `[#bbbb2222 · ${n} chars]\n` + 'q'.repeat(n) : 'q'.repeat(n)),
    )
    writeLog(join(sessionDir, 'session.v4.jsonl.zstd'), lines)
    writeFileSync(
      join(sessionDir, 'archives', 'index.json'),
      JSON.stringify({
        version: 1,
        entries: {
          a1: { chars: 5000, stubChars: 300 },
          a2: { chars: 5000, stubChars: 300 },
          a3: { chars: 5000, stubChars: 300 },
        },
      }),
    )
    const stats = computeStats({})
    const big = stats.buckets.find((row) => row.bucket === '5k-20k')
    assert.equal(big.rate, 0.75)
    assert.equal(big.verdict, 'profitable')
    const small = stats.buckets.find((row) => row.bucket === '<500')
    assert.equal(small.archived, 0)
    assert.equal(stats.recommendedMinChars, 5000)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('computeSessionStats reports the actionable surface of one session', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-session-'))
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const sessionId = 'session-x'
    const sessionDir = join(home, 'sessions', '--proj--', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const lines = [
      JSON.stringify({
        type: 'tool/result',
        seq: 0,
        time: 1,
        data: { turn: 1, step: 0, message: { id: 'a', role: 'tool', toolCallId: 'c0', source: { kind: 'tool', callId: 'c0' }, content: [{ type: 'text', text: 'small' }] } },
      }),
      JSON.stringify({
        type: 'tool/result',
        seq: 1,
        time: 2,
        data: { turn: 1, step: 0, message: { id: 'b', role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: '[#aaaa0001 · 3000 chars]\n' + 'x'.repeat(3000) }] } },
      }),
      JSON.stringify({
        type: 'tool/result',
        seq: 2,
        time: 3,
        data: { turn: 4, step: 0, message: { id: 'c', role: 'tool', toolCallId: 'c2', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: '[#aaaa0002 · 5000 chars]\n' + 'y'.repeat(5000) }] } },
      }),
      JSON.stringify({
        type: 'tool/result',
        seq: 3,
        time: 4,
        surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
        sourceEventSeqs: [0],
        data: { turn: 1, step: 0, message: { id: 'd', role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: '[archived #aaaa0001 · tool · 3000 chars]\nfile: /x' }] } },
      }),
    ]
    writeLog(join(sessionDir, 'session.v4.jsonl.zstd'), lines)
    const stats = computeSessionStats({ sessionId, minChars: 2000, keepTurns: 3 })
    assert.equal(stats.archived, 1, 'the replacement stub counts as archived')
    assert.equal(stats.live, 2, 'seq 0 is shadowed by the replacement')
    assert.equal(stats.surface, 3)
    assert.equal(stats.archivable, 1, 'turn 4 is inside the guard, the 5000-char one is not')
    assert.equal(stats.potentialChars, 3000 - 384)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
